import * as jellyfinApi from "../api/jellyfin.js";
import { fetchLibraryMap, deduplicator } from "./libraryResolver.js";
import { deriveSeedKeys, isScanInProgress, setScanInProgress } from "./librarySeeder.js";
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";

/**
 * Daily background scan: re-enumerates every Jellyfin library and removes
 * dedup-store keys for items that no longer exist (i.e. were deleted from
 * Jellyfin). Re-asserts keys for surviving items so their TTL is refreshed
 * and long-lived library items stay suppressed indefinitely. Only touches
 * movie:/series:/id: identity keys — the same format produced by
 * buildIdentityKey()/deriveSeedKeys().
 *
 * Aborts without removing any keys if any library page fetch is incomplete,
 * to avoid falsely expiring keys due to a transient Jellyfin outage.
 */
export async function pruneLibrary() {
  if (isScanInProgress()) {
    logger.warn("libraryPruner: seed scan in progress — skipping prune cycle");
    return;
  }

  const apiKey = settings.JELLYFIN_API_KEY;
  const baseUrl = settings.JELLYFIN_BASE_URL;
  if (!apiKey || !baseUrl) {
    logger.warn("libraryPruner: Jellyfin not configured — skipping prune");
    return;
  }

  setScanInProgress(true);
  logger.info("libraryPruner: starting daily prune scan...");
  try {
    const result = await fetchLibraryMap();
    const libraries = result?.libraries;
    if (!Array.isArray(libraries)) {
      throw new Error("fetchLibraryMap returned unexpected shape — cannot prune");
    }
    const currentKeys = new Set();

    for (const lib of libraries) {
      const { items, complete } = await jellyfinApi.fetchAllLibraryItems(
        apiKey,
        baseUrl,
        lib.ItemId
      );
      if (!complete) {
        logger.error(
          `libraryPruner: incomplete fetch for library "${lib.Name}" — aborting prune run, no keys removed (will retry next cycle)`
        );
        return;
      }
      for (const item of items) {
        for (const key of deriveSeedKeys(item)) currentKeys.add(key);
      }
    }

    // Re-assert surviving keys so their TTL resets — without this, seeded
    // keys expire after 7 days and old items would be announced as new again.
    for (const key of currentKeys) {
      deduplicator.store.set(key, true);
    }

    // Deliberately not pruning "id:" keys: they can come from item types
    // fetchAllLibraryItems does not enumerate, so they would be removed here
    // and re-notified on the next poll. They expire via TTL instead.
    const removed = deduplicator.store.prune(
      (key) =>
        (key.startsWith("movie:") || key.startsWith("series:")) &&
        !currentKeys.has(key)
    );

    if (!deduplicator.store.flush()) {
      logger.error(
        `libraryPruner: prune ran (refreshed ${currentKeys.size} key(s), removed ${removed} stale key(s)) but the dedup store could not be written to disk — the result is memory-only and will be lost on restart`
      );
      return;
    }

    logger.info(
      `libraryPruner: prune complete — refreshed ${currentKeys.size} key(s), removed ${removed} stale identity key(s)`
    );
  } catch (err) {
    logger.error(`libraryPruner: prune failed (${err?.message || err})`);
  } finally {
    setScanInProgress(false);
  }
}
