import * as jellyfinApi from "../api/jellyfin.js";
import logger from "../utils/logger.js";

const SEEN_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Fetches all libraries from Jellyfin and returns the library array,
 * a Set of all known IDs (both VirtualFolder and Collection), and a
 * Map of CollectionId → VirtualFolderItemId for config lookups.
 */
export async function fetchLibraryMap() {
  const apiKey = process.env.JELLYFIN_API_KEY;
  const baseUrl = process.env.JELLYFIN_BASE_URL;
  const libraries = await jellyfinApi.fetchLibraries(apiKey, baseUrl);

  const libraryIdMap = new Map(); // CollectionId → VirtualFolderItemId
  const libraryIds = new Set(); // all known IDs for fast membership checks

  for (const lib of libraries) {
    libraryIds.add(lib.ItemId);
    if (lib.CollectionId && lib.CollectionId !== lib.ItemId) {
      libraryIds.add(lib.CollectionId);
      libraryIdMap.set(lib.CollectionId, lib.ItemId);
      logger.debug(
        `📚 Library "${lib.Name}": CollectionId=${lib.CollectionId} → VirtualFolderId=${lib.ItemId}`
      );
    }
  }

  return { libraries, libraryIds, libraryIdMap };
}

/**
 * Given a raw libraryId (may be CollectionId or VirtualFolderId),
 * returns the VirtualFolderId used for config lookups.
 */
export function resolveConfigLibraryId(libraryId, libraryIdMap) {
  if (libraryIdMap.has(libraryId)) {
    const mapped = libraryIdMap.get(libraryId);
    logger.info(`🔄 Mapped collection ID ${libraryId} -> virtual folder ID ${mapped}`);
    return mapped;
  }
  return libraryId;
}

/**
 * Parses JELLYFIN_NOTIFICATION_LIBRARIES from env.
 * Returns an object mapping libraryId → channelId, or {} if not configured.
 */
export function getLibraryChannels() {
  try {
    const raw = process.env.JELLYFIN_NOTIFICATION_LIBRARIES;
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    return JSON.parse(raw);
  } catch (e) {
    logger.warn("Failed to parse JELLYFIN_NOTIFICATION_LIBRARIES:", e);
    return {};
  }
}

/**
 * Resolves the target Discord channel for a given configLibraryId.
 * Returns null if the library is not in the notification list.
 */
export function resolveTargetChannel(configLibraryId, libraryChannels) {
  const defaultChannelId = process.env.JELLYFIN_CHANNEL_ID;
  if (Object.keys(libraryChannels).length > 0 && !libraryChannels[configLibraryId]) {
    logger.info(`❌ Skipping item from library ${configLibraryId} (not in notification list)`);
    logger.info(`   Available libraries: ${Object.keys(libraryChannels).join(", ")}`);
    return null;
  }
  return libraryChannels[configLibraryId] || defaultChannelId || null;
}

/**
 * Shared in-memory deduplication store for seen Jellyfin item IDs.
 * Shared between the poller and WebSocket client so that an item
 * detected by both within 24 hours is only notified once.
 */
export class ItemDeduplicator {
  constructor() {
    this.seenItems = new Map(); // itemId → timestamp
  }

  /**
   * Returns true if the item was seen recently (within SEEN_THRESHOLD_MS).
   * If not seen recently, records it and returns false.
   */
  checkAndRecord(itemId) {
    const now = Date.now();
    const lastSeen = this.seenItems.get(itemId);
    if (lastSeen && now - lastSeen < SEEN_THRESHOLD_MS) {
      return true; // already seen
    }
    this.seenItems.set(itemId, now);
    return false;
  }

  /** Remove entries older than 7 days to prevent unbounded growth. */
  cleanup() {
    const cutoff = Date.now() - CLEANUP_AGE_MS;
    for (const [id, ts] of this.seenItems) {
      if (ts < cutoff) this.seenItems.delete(id);
    }
  }
}

/** Singleton deduplicator shared by poller and WebSocket client. */
export const deduplicator = new ItemDeduplicator();
