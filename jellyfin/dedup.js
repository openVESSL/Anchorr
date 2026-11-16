/**
 * What was already announced, so a restart, a file upgrade or a late Jellyfin event never
 * posts the same item twice.
 *
 * Keys: movies and `item:<identity>` entries are permanent; `burst:<series identity>`
 * groups one import burst of a series for an hour (level -1 while its batch is pending).
 */
import logger from "../utils/logger.js";
import { PersistentMap } from "../utils/persistentMap.js";

export const SERIES_BURST_WINDOW_MS = 60 * 60 * 1000; // lower-level items in this window fold into the series post
export const SEASON_NOTIFICATION_DELAY_MS = 3 * 60 * 1000; // a season may follow its series post after this delay
export const IN_PROGRESS_TTL_MS = 5 * 60 * 1000; // a pending batch that never fires stops blocking after this

// Persistent so dedup state survives container restarts (otherwise a restart
// re-notifies anything in the recently-added window via the next poll/WS reconnect).
export const sentNotifications = new PersistentMap(
  "sent-notifications",
  5 * 365 * 24 * 60 * 60 * 1000, // ~5 years — items already in the library never re-notify
  { validateValue: (v) => v && typeof v.level === "number" }
);

// Sweep stale "in-progress" markers (level: -1) from a previous run. Their
// associated debouncer is gone after restart, so the marker would otherwise
// block notifications for that series until its 5-min TTL expires.
const staleMarkers = sentNotifications.prune((_key, value) => value?.level === -1);
if (staleMarkers > 0) {
  logger.info(`[DEDUP] Cleared ${staleMarkers} stale in-progress markers from previous run`);
}

/** Series 3, Season 2, Episode 1, anything else 0. */
export function getItemLevel(itemType) {
  return { Series: 3, Season: 2, Episode: 1 }[itemType] ?? 0;
}

// Before 1.6.3 each Series/Season/Episode was stored under series:tmdb:<its own TMDB ID>.
// Only the level tells which kind of item wrote the entry, so require an exact match.
export function findLegacyItemKey(data) {
  if (!data.Provider_tmdb) return null;
  const legacyKey = `series:tmdb:${data.Provider_tmdb}`;
  const entry = sentNotifications.get(legacyKey);
  return entry?.level === getItemLevel(data.ItemType) ? legacyKey : null;
}
