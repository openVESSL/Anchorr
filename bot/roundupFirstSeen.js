import { PersistentMap } from "../utils/persistentMap.js";

// Wider than the 7-day roundup window so an item filtered out one week is
// still remembered the following week (avoids it re-appearing as "new" if
// Sonarr does a second upgrade just past the 7-day mark).
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

const map = new PersistentMap("roundup-first-seen", TTL_MS, {
  validateValue: (v) => v && typeof v.firstSeenAt === "number",
});

/**
 * Build a stable per-item identity key that survives Sonarr/Radarr quality
 * upgrades (which change the Jellyfin ItemId).
 *
 * - Movies prefer TMDB; fall back to ItemId (re-imports without TMDB will
 *   slip through — known limitation, very rare in practice).
 * - Episodes/Seasons use SeriesId, which is the Jellyfin series *container*
 *   ItemId. The container persists across episode-file re-imports, so it's
 *   stable for our purposes.
 */
export function stableKeyFor(item) {
  if (!item || !item.Type) return null;
  const tmdb = item.ProviderIds?.Tmdb;
  switch (item.Type) {
    case "Movie":
      if (tmdb) return `m:tmdb:${tmdb}`;
      return item.Id ? `m:jf:${item.Id}` : null;
    case "Series":
      if (tmdb) return `S:tmdb:${tmdb}`;
      return item.Id ? `S:jf:${item.Id}` : null;
    case "Season": {
      const sid = item.SeriesId;
      const n = item.IndexNumber;
      if (sid && n != null) return `s:${sid}-S${n}`;
      return item.Id ? `s:jf:${item.Id}` : null;
    }
    case "Episode": {
      const sid = item.SeriesId;
      const season = item.ParentIndexNumber;
      const ep = item.IndexNumber;
      const epEnd = item.IndexNumberEnd;
      if (sid && season != null && ep != null) {
        return epEnd != null && epEnd !== ep
          ? `e:${sid}-S${season}E${ep}-${epEnd}`
          : `e:${sid}-S${season}E${ep}`;
      }
      // No usable index — best we can do is series + episode title.
      if (sid && item.Name) {
        return `e:${sid}-n:${item.Name.toLowerCase().trim()}`;
      }
      return item.Id ? `e:jf:${item.Id}` : null;
    }
    default:
      return null;
  }
}

/**
 * Returns the recorded `firstSeenAt` timestamp for this item's stable
 * identity. Records `now` if it's the first time we've seen it.
 *
 * Items that can't be keyed (no Type, no Id) are treated as new — we'd
 * rather over-include than drop a genuinely new item.
 */
export function recordOrGet(item, now = Date.now()) {
  const key = stableKeyFor(item);
  if (!key) return now;
  const existing = map.get(key);
  if (existing && typeof existing.firstSeenAt === "number") {
    return existing.firstSeenAt;
  }
  map.set(key, { firstSeenAt: now });
  return now;
}
