import * as jellyfinApi from "../api/jellyfin.js";
import logger from "../utils/logger.js";
import { PersistentMap } from "../utils/persistentMap.js";

const SEEN_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — survive Sonarr/Radarr upgrade cycles

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
    const parsed = typeof raw === "object" ? raw : JSON.parse(raw);
    // Legacy: array of library IDs — convert to object mapped to default channel
    if (Array.isArray(parsed)) {
      const defaultCh = process.env.JELLYFIN_CHANNEL_ID || "";
      return Object.fromEntries(parsed.map((id) => [id, defaultCh]));
    }
    return parsed;
  } catch (e) {
    logger.warn("Failed to parse JELLYFIN_NOTIFICATION_LIBRARIES:", e);
    return {};
  }
}

/**
 * Resolves the target Discord channel for a given configLibraryId.
 * Supports both legacy string format ({ libraryId: channelId }) and
 * new object format ({ libraryId: { channel, isAnime } }).
 * Returns null if the library is not in the notification list.
 */
export function resolveTargetChannel(configLibraryId, libraryChannels) {
  const defaultChannelId = process.env.JELLYFIN_CHANNEL_ID;
  const libConfig = libraryChannels[configLibraryId];
  if (Object.keys(libraryChannels).length > 0 && libConfig === undefined) {
    logger.info(`❌ Skipping item from library ${configLibraryId} (not in notification list)`);
    logger.info(`   Available libraries: ${Object.keys(libraryChannels).join(", ")}`);
    return null;
  }
  const channelId =
    typeof libConfig === "object" && libConfig !== null
      ? libConfig.channel
      : libConfig;
  const resolved = channelId || defaultChannelId || null;
  if (resolved === null) {
    logger.warn(
      `⚠️ Library ${configLibraryId} is in the notification list but no channel is configured and no default channel is set — notification will be skipped.`
    );
  }
  return resolved;
}

/**
 * Returns whether the given library is marked as an anime library.
 * Only meaningful with the new object format; returns false for legacy configs.
 */
export function getLibraryAnimeFlag(configLibraryId, libraryChannels) {
  const libConfig = libraryChannels[configLibraryId];
  if (typeof libConfig === "object" && libConfig !== null) {
    return !!libConfig.isAnime;
  }
  return false;
}

/**
 * Build a stable identity key for an item that survives Sonarr/Radarr upgrades.
 *
 * File replacements give the item a new Jellyfin ItemId, so dedup by ItemId
 * misfires. This key is keyed off content identity (TMDB/SeriesId + S/E)
 * instead of file identity.
 *
 * Accepts both:
 *   - Webhook payload shape: { ItemType, Provider_tmdb, SeriesId, Name, Year,
 *     SeasonNumber, EpisodeNumber, IndexNumber, ParentIndexNumber, ItemId }
 *   - Jellyfin API shape:    { Type, ProviderIds: { Tmdb }, SeriesId, Name,
 *     ProductionYear, IndexNumber, ParentIndexNumber, Id }
 *
 * Falls back to `id:{ItemId}` if no stable identity is derivable — that
 * preserves legacy behavior for unidentified items rather than silently
 * grouping them.
 */
export function buildIdentityKey(item) {
  if (!item) return null;

  const type = item.ItemType || item.Type;
  const tmdb = item.Provider_tmdb || item.ProviderIds?.Tmdb;
  const seriesId = item.SeriesId;
  const seasonNum = item.SeasonNumber ?? item.ParentIndexNumber;
  const episodeNum = item.EpisodeNumber ?? item.IndexNumber;
  const name = item.Name;
  const year = item.Year || item.ProductionYear;
  const itemId = item.ItemId || item.Id;

  switch (type) {
    case "Movie":
      if (tmdb) return `movie:tmdb:${tmdb}`;
      if (name) return `movie:name:${name}:${year ?? "?"}`;
      return itemId ? `id:${itemId}` : null;

    case "Series":
      if (tmdb) return `series:tmdb:${tmdb}`;
      if (seriesId) return `series:id:${seriesId}`;
      if (name) return `series:name:${name}`;
      return itemId ? `id:${itemId}` : null;

    case "Season": {
      const seriesKey = tmdb
        ? `tmdb:${tmdb}`
        : seriesId
        ? `id:${seriesId}`
        : name
        ? `name:${name}`
        : null;
      if (seriesKey && seasonNum != null) return `series:${seriesKey}:s${seasonNum}`;
      return itemId ? `id:${itemId}` : null;
    }

    case "Episode": {
      const seriesKey = tmdb
        ? `tmdb:${tmdb}`
        : seriesId
        ? `id:${seriesId}`
        : item.SeriesName
        ? `name:${item.SeriesName}`
        : null;
      if (seriesKey && seasonNum != null && episodeNum != null) {
        return `series:${seriesKey}:s${seasonNum}e${episodeNum}`;
      }
      return itemId ? `id:${itemId}` : null;
    }

    default:
      return itemId ? `id:${itemId}` : null;
  }
}

/**
 * Persistent deduplication store for seen Jellyfin items.
 * Shared between the poller and WebSocket client so that an item
 * detected by both within SEEN_THRESHOLD_MS is only notified once.
 *
 * State is persisted to disk so it survives container restarts —
 * otherwise a restart would re-notify everything in the recently-added
 * window via the next poll/WS reconnect.
 */
export class ItemDeduplicator {
  constructor() {
    this.store = new PersistentMap("seen-items", SEEN_THRESHOLD_MS);
  }

  /**
   * Returns true if the item was seen recently (within SEEN_THRESHOLD_MS).
   * Accepts either an item object (poller/WS pass the raw Jellyfin item)
   * or a pre-built identity key string.
   *
   * If no stable key can be derived, falls back to logging a warning and
   * returning false so we never silently skip dedup entirely.
   */
  checkAndRecord(itemOrKey) {
    let key;
    if (typeof itemOrKey === "string") {
      key = itemOrKey;
    } else {
      key = buildIdentityKey(itemOrKey);
      if (!key) {
        const type = itemOrKey?.Type || itemOrKey?.ItemType;
        const name = itemOrKey?.Name;
        logger.warn(
          `ItemDeduplicator.checkAndRecord: un-keyable input (Type=${type}, Name=${name}); dedup bypassed for this item`
        );
        return false;
      }
    }
    if (this.store.has(key)) return true;
    this.store.set(key, true);
    return false;
  }

  cleanup() {
    this.store.cleanup();
  }
}

/** Singleton deduplicator shared by poller and WebSocket client. */
export const deduplicator = new ItemDeduplicator();
