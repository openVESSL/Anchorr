import * as jellyfinApi from "../api/jellyfin.js";
import { fetchLibraryMap, deduplicator } from "./libraryResolver.js";
import { deriveSeedKeys } from "./librarySeeder.js";
import logger from "../utils/logger.js";

/**
 * Daily background scan: re-enumerates every Jellyfin library and removes
 * dedup-store keys for items that no longer exist (i.e. were deleted from
 * Jellyfin). Only touches movie:/series: identity keys — the same format
 * produced by buildIdentityKey()/deriveSeedKeys() — so unrelated dedup
 * entries (e.g. raw id: fallback keys for un-identified items, which this
 * scan also produces and thus also covers) are handled consistently.
 */
export async function pruneLibrary() {
  const apiKey = process.env.JELLYFIN_API_KEY;
  const baseUrl = process.env.JELLYFIN_BASE_URL;
  if (!apiKey || !baseUrl) {
    logger.debug("libraryPruner: Jellyfin not configured — skipping prune");
    return;
  }

  logger.info("libraryPruner: starting daily prune scan...");
  try {
    const { libraries } = await fetchLibraryMap();
    const currentKeys = new Set();

    for (const lib of libraries) {
      const items = await jellyfinApi.fetchAllLibraryItems(
        apiKey,
        baseUrl,
        lib.ItemId
      );
      for (const item of items) {
        for (const key of deriveSeedKeys(item)) currentKeys.add(key);
      }
    }

    const removed = deduplicator.store.prune(
      (key) =>
        (key.startsWith("movie:") ||
          key.startsWith("series:") ||
          key.startsWith("id:")) &&
        !currentKeys.has(key)
    );

    logger.info(
      `libraryPruner: prune complete — removed ${removed} stale identity key(s)`
    );
  } catch (err) {
    logger.error(`libraryPruner: prune failed (${err?.message || err})`);
  }
}
