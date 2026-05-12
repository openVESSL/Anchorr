import { PersistentMap } from "../utils/persistentMap.js";
import { buildIdentityKey } from "../jellyfin/libraryResolver.js";
import logger from "../utils/logger.js";

// Items already seen should never re-appear as "new" regardless of how many
// Sonarr/Radarr quality upgrades happen. ~5 years is effectively permanent.
const TTL_MS = 5 * 365 * 24 * 60 * 60 * 1000;

const map = new PersistentMap("roundup-first-seen", TTL_MS, {
  validateValue: (v) => v && typeof v.firstSeenAt === "number",
});

// One-time migration from the v1 key format (used by stableKeyFor) to the v2
// format (used by buildIdentityKey). Runs once on startup; a no-op after that
// since v2 keys don't start with the old single-letter prefixes.
(function migrateV1Keys() {
  const oldPrefixes = ["m:", "S:", "s:", "e:"];
  const toMigrate = map.keys().filter((k) => oldPrefixes.some((p) => k.startsWith(p)));
  if (toMigrate.length === 0) return;

  let migrated = 0;
  let dropped = 0;
  for (const oldKey of toMigrate) {
    const newKey = migrateKey(oldKey);
    if (newKey !== null) {
      map.rekey(oldKey, newKey);
      migrated++;
    } else {
      map.delete(oldKey);
      dropped++;
    }
  }
  logger.info(
    `roundup-first-seen: migrated ${migrated} key(s) from v1 to v2 format (dropped ${dropped} unrecognised)`
  );
})();

function migrateKey(oldKey) {
  // m:tmdb:X → movie:tmdb:X
  if (oldKey.startsWith("m:tmdb:")) return "movie:tmdb:" + oldKey.slice(7);
  // m:jf:X → id:X
  if (oldKey.startsWith("m:jf:")) return "id:" + oldKey.slice(5);
  // S:tmdb:X → series:tmdb:X
  if (oldKey.startsWith("S:tmdb:")) return "series:tmdb:" + oldKey.slice(7);
  // S:jf:X → series:id:X
  if (oldKey.startsWith("S:jf:")) return "series:id:" + oldKey.slice(5);
  // s:SeriesId-SN → series:id:SeriesId:sN
  const seasonMatch = oldKey.match(/^s:([^-]+)-S(\d+)$/);
  if (seasonMatch) return `series:id:${seasonMatch[1]}:s${seasonMatch[2]}`;
  // s:jf:X → id:X
  if (oldKey.startsWith("s:jf:")) return "id:" + oldKey.slice(5);
  // e:SeriesId-SNEm(-m2)? → series:id:SeriesId:sNem
  const epMatch = oldKey.match(/^e:([^-]+)-S(\d+)E(\d+)(?:-\d+)?$/);
  if (epMatch) return `series:id:${epMatch[1]}:s${epMatch[2]}e${epMatch[3]}`;
  // e:SeriesId-n:name → no stable equivalent, drop
  // e:jf:X → id:X
  if (oldKey.startsWith("e:jf:")) return "id:" + oldKey.slice(5);
  return null;
}

/**
 * Returns the recorded `firstSeenAt` timestamp for this item's stable
 * identity. Records `now` if it's the first time we've seen it.
 *
 * Items that can't be keyed (no Type, no Id) are treated as new — we'd
 * rather over-include than drop a genuinely new item.
 */
export function recordOrGet(item, now = Date.now()) {
  const key = buildIdentityKey(item);
  if (!key) return now;
  const existing = map.get(key);
  if (existing && typeof existing.firstSeenAt === "number") {
    return existing.firstSeenAt;
  }
  map.set(key, { firstSeenAt: now });
  return now;
}
