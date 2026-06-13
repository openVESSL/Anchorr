import * as jellyfinApi from "../api/jellyfin.js";
import {
  fetchLibraryMap,
  buildIdentityKey,
  deduplicator,
} from "./libraryResolver.js";
import { updateConfig } from "../utils/configFile.js";
import logger from "../utils/logger.js";

/**
 * Builds every identity key that webhook/poller dedup might check for a
 * given Jellyfin API item. For episodes, this includes the series-level
 * and season-level keys in addition to the episode-level key, so a webhook
 * for a pre-existing episode is suppressed at any granularity.
 */
export function deriveSeedKeys(item) {
  const keys = [];
  const itemKey = buildIdentityKey(item);
  if (itemKey) keys.push(itemKey);

  if (item.Type === "Episode") {
    const seriesKeyPart = item.ProviderIds?.Tmdb
      ? `tmdb:${item.ProviderIds.Tmdb}`
      : item.SeriesId
      ? `id:${item.SeriesId}`
      : item.SeriesName
      ? `name:${item.SeriesName}`
      : null;

    if (seriesKeyPart) {
      keys.push(`series:${seriesKeyPart}`);
      if (item.ParentIndexNumber != null) {
        keys.push(`series:${seriesKeyPart}:s${item.ParentIndexNumber}`);
      }
    }
  }

  return keys;
}

/**
 * One-time (or manually re-triggered) scan of every Jellyfin library.
 * Pre-populates the existing dedup store so webhooks for pre-existing
 * content are never treated as "new". On success, persists
 * LIBRARY_SEEDED=true to config.json. On failure, leaves the flag unset
 * so the caller retries on the next process start.
 */
export async function seedLibrary() {
  const apiKey = process.env.JELLYFIN_API_KEY;
  const baseUrl = process.env.JELLYFIN_BASE_URL;
  if (!apiKey || !baseUrl) {
    logger.warn(
      "librarySeeder: JELLYFIN_API_KEY/JELLYFIN_BASE_URL not configured — skipping library seed"
    );
    return;
  }

  logger.info("librarySeeder: starting library seed scan...");
  try {
    const { libraries } = await fetchLibraryMap();
    let totalKeys = 0;

    for (const lib of libraries) {
      const items = await jellyfinApi.fetchAllLibraryItems(
        apiKey,
        baseUrl,
        lib.ItemId
      );
      for (const item of items) {
        for (const key of deriveSeedKeys(item)) {
          deduplicator.store.set(key, true);
          totalKeys++;
        }
      }
      logger.info(
        `librarySeeder: seeded ${items.length} items from library "${lib.Name}"`
      );
    }

    deduplicator.store.flush();

    if (!updateConfig({ LIBRARY_SEEDED: "true" })) {
      throw new Error("failed to persist LIBRARY_SEEDED flag to config.json");
    }
    process.env.LIBRARY_SEEDED = "true";

    logger.info(
      `librarySeeder: seed complete — ${totalKeys} identity keys stored across ${libraries.length} libraries`
    );
  } catch (err) {
    logger.error(
      `librarySeeder: seed failed (${err?.message || err}) — LIBRARY_SEEDED left unset, will retry on next start`
    );
  }
}
