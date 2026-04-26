import fs from "fs";
import path from "path";
import logger from "./logger.js";
import { CONFIG_PATH } from "./configFile.js";

const FLUSH_DEBOUNCE_MS = 2000;

const registry = new Set();
let shutdownHooksInstalled = false;

function installShutdownHooks() {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;
  const flushAll = () => {
    for (const m of registry) {
      try {
        m.flush();
      } catch (err) {
        logger.warn(`PersistentMap shutdown flush failed: ${err?.message || err}`);
      }
    }
  };
  // Process termination is owned by app.js (which calls process.exit(0) after
  // server.close). These additional listeners run synchronously alongside it
  // to flush dirty state before exit; we deliberately do not call exit here
  // to avoid racing app.js's graceful shutdown.
  process.on("SIGTERM", flushAll);
  process.on("SIGINT", flushAll);
  process.on("beforeExit", flushAll);
}

/**
 * Map-like store with per-entry TTL that survives process restarts.
 *
 * Persists to a JSON file next to config.json. Mutations schedule a
 * debounced atomic write (tmp file + rename) so we don't thrash the disk
 * on bursty traffic. Expired entries are dropped lazily on access and
 * eagerly on load/cleanup.
 *
 * Used for dedup state — losing a few seconds of writes on hard crash
 * is acceptable; the worst outcome is one extra Discord notification.
 */
export class PersistentMap {
  constructor(name, defaultTtlMs) {
    this.name = name;
    this.defaultTtlMs = defaultTtlMs;
    this.filePath = path.join(path.dirname(CONFIG_PATH), `dedup-${name}.json`);
    this.entries = new Map();
    this.flushTimer = null;
    this.dirty = false;
    this._load();
    registry.add(this);
    installShutdownHooks();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        logger.warn(`PersistentMap[${this.name}]: file content is not an array, ignoring`);
        return;
      }
      const now = Date.now();
      let loaded = 0;
      let dropped = 0;
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const { key, value, expiresAt } = entry;
        if (typeof key !== "string" || typeof expiresAt !== "number") continue;
        if (expiresAt <= now) {
          dropped++;
          continue;
        }
        this.entries.set(key, { value, expiresAt });
        loaded++;
      }
      logger.info(
        `PersistentMap[${this.name}]: loaded ${loaded} entries from ${this.filePath} (dropped ${dropped} expired)`
      );
    } catch (err) {
      logger.warn(`PersistentMap[${this.name}]: failed to load (${err?.message || err})`);
    }
  }

  _scheduleFlush() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_DEBOUNCE_MS);
  }

  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const now = Date.now();
    const data = [];
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) {
        data.push({ key, value: entry.value, expiresAt: entry.expiresAt });
      }
    }
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      logger.warn(`PersistentMap[${this.name}]: flush failed (${err?.message || err})`);
      this.dirty = true;
    }
  }

  has(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this._scheduleFlush();
      return false;
    }
    return true;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this._scheduleFlush();
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    this.entries.set(key, { value, expiresAt });
    this._scheduleFlush();
  }

  delete(key) {
    if (this.entries.delete(key)) this._scheduleFlush();
  }

  cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed++;
      }
    }
    if (removed > 0) this._scheduleFlush();
    return removed;
  }

  /** Drop entries matching the predicate. Returns count removed. */
  prune(predicate) {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (predicate(key, entry.value)) {
        this.entries.delete(key);
        removed++;
      }
    }
    if (removed > 0) this._scheduleFlush();
    return removed;
  }

  size() {
    return this.entries.size;
  }
}
