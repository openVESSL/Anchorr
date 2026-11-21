/**
 * In-memory cache for Seerr metadata (search, trending, details), 5 minutes per entry,
 * kept per bot language.
 */
import { CACHE_TTL } from "../lib/constants.js";
import logger from "./logger.js";
import { settings } from "./settings.js";

// Metadata comes in the bot language: a language change must not serve the old one
const scoped = (key) => `${settings.LANGUAGE || "en"}:${key}`;

const SWEEP_ABOVE = 500; // drop expired entries once the cache grows past this

class MetadataCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  read(key) {
    key = scoped(key);
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      this.hits++;
      return entry.value;
    }
    if (entry) this.entries.delete(key);
    this.misses++;
    return null;
  }

  write(key, value) {
    if (this.entries.size >= SWEEP_ABOVE) this.sweep();
    this.entries.set(scoped(key), { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }

  // Called with one argument less to read, with the value to store.
  search(query, results) {
    const key = `search:${query.toLowerCase().trim()}`;
    return results === undefined ? this.read(key) : this.write(key, results);
  }

  details(id, mediaType, details) {
    const key = `details:${mediaType}:${id}`;
    return details === undefined ? this.read(key) : this.write(key, details);
  }

  trending(results) {
    return results === undefined ? this.read("trending") : this.write("trending", results);
  }

  clearAll() {
    this.entries.clear();
    logger.info("Metadata cache cleared");
  }

  getStats() {
    this.sweep();
    const total = this.hits + this.misses;
    return {
      keys: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(2)}%` : "0%",
    };
  }
}

export default new MetadataCache(CACHE_TTL.METADATA);
