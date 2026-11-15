import * as jellyfinApi from "../api/jellyfin.js";
import {
  fetchLibraryMap,
  buildIdentityKey,
  deduplicator,
} from "./libraryResolver.js";
import { updateConfig } from "../utils/configFile.js";
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";

// Shared flag: prevents concurrent seed and prune scans from running simultaneously.
let scanInProgress = false;

export function isScanInProgress() {
  return scanInProgress;
}

export function setScanInProgress(value) {
  scanInProgress = value;
}

/**
 * Synchronous pre-flight for seedLibrary(). Callers that fire the scan without
 * awaiting it (the dashboard route) use this to report a rejection instead of
 * claiming a scan started.
 * @returns {{ok: boolean, reason: string|null}}
 */
export function checkSeedPreconditions() {
  if (scanInProgress) {
    return { ok: false, reason: "a library scan is already running" };
  }
  if (!settings.JELLYFIN_API_KEY || !settings.JELLYFIN_BASE_URL) {
    return { ok: false, reason: "Jellyfin URL or API key is not configured" };
  }
  return { ok: true, reason: null };
}

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
    // An episode's ProviderIds.Tmdb is the *episode's* TMDB id, not the
    // series' — using it here would build series keys that match nothing.
    const seriesKeyPart = item.SeriesId
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
  const pre = checkSeedPreconditions();
  if (!pre.ok) {
    logger.warn(`librarySeeder: ${pre.reason} — skipping library seed`);
    return;
  }

  const apiKey = settings.JELLYFIN_API_KEY;
  const baseUrl = settings.JELLYFIN_BASE_URL;

  scanInProgress = true;
  logger.info("librarySeeder: starting library seed scan...");
  try {
    const result = await fetchLibraryMap();
    const libraries = result?.libraries;
    if (!Array.isArray(libraries)) {
      throw new Error("fetchLibraryMap returned unexpected shape — cannot seed");
    }
    let totalKeys = 0;

    for (const lib of libraries) {
      const { items, complete } = await jellyfinApi.fetchAllLibraryItems(
        apiKey,
        baseUrl,
        lib.ItemId
      );
      if (!complete) {
        throw new Error(
          `incomplete fetch for library "${lib.Name}" — aborting seed`
        );
      }
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

    if (!deduplicator.store.flush()) {
      throw new Error(
        "dedup store could not be written to disk — not marking library as seeded"
      );
    }

    if (!updateConfig({ LIBRARY_SEEDED: "true" })) {
      throw new Error("failed to persist LIBRARY_SEEDED flag to config.json");
    }

    logger.info(
      `librarySeeder: seed complete — ${totalKeys} identity keys stored across ${libraries.length} libraries`
    );
  } catch (err) {
    logger.error(
      `librarySeeder: seed failed (${err?.message || err}) — LIBRARY_SEEDED left unset, will retry on next start`
    );
  } finally {
    scanInProgress = false;
  }
}
