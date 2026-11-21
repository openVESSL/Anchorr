import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";

/**
 * Parses JELLYFIN_NOTIFICATION_LIBRARIES from env.
 * Returns an object mapping libraryId → channelId, or {} if not configured.
 */
export function getLibraryChannels() {
  try {
    const raw = settings.JELLYFIN_NOTIFICATION_LIBRARIES;
    if (!raw) return {};
    const parsed = typeof raw === "object" ? raw : JSON.parse(raw);
    // Legacy: array of library IDs — convert to object mapped to default channel
    if (Array.isArray(parsed)) {
      const defaultCh = settings.JELLYFIN_CHANNEL_ID || "";
      return Object.fromEntries(parsed.map((id) => [id, defaultCh]));
    }
    return parsed;
  } catch (e) {
    logger.warn(`Failed to parse JELLYFIN_NOTIFICATION_LIBRARIES: ${e?.message || e}`);
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
  const defaultChannelId = settings.JELLYFIN_CHANNEL_ID;
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
 *   - Webhook payload shape: { ItemType, Provider_tmdb,
 *     SeriesProvider_tmdb, SeriesId, Name, Year, SeasonNumber, EpisodeNumber,
 *     IndexNumber, ParentIndexNumber, ItemId }
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
  const seriesTmdb = item.SeriesProvider_tmdb;
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
      const seriesKey = seriesTmdb
        ? `tmdb:${seriesTmdb}`
        : seriesId
        ? `id:${seriesId}`
        : name
        ? `name:${name}`
        : null;
      if (seriesKey && seasonNum != null) return `series:${seriesKey}:s${seasonNum}`;
      return itemId ? `id:${itemId}` : null;
    }

    case "Episode": {
      const seriesKey = seriesTmdb
        ? `tmdb:${seriesTmdb}`
        : seriesId
        ? `id:${seriesId}`
        : item.SeriesName
        ? `name:${item.SeriesName}`
        : null;
      if (seriesKey && seasonNum != null && episodeNum != null) {
        const epEnd = item.IndexNumberEnd ?? item.EpisodeNumberEnd;
        const epSuffix =
          epEnd != null && epEnd !== episodeNum
            ? `e${episodeNum}-${epEnd}`
            : `e${episodeNum}`;
        return `series:${seriesKey}:s${seasonNum}${epSuffix}`;
      }
      return itemId ? `id:${itemId}` : null;
    }

    default:
      return itemId ? `id:${itemId}` : null;
  }
}

/**
 * Reproduce the pre-SeriesProvider identity for an existing persisted entry.
 * This is used only to migrate old keys on first access after an upgrade.
 */
export function buildLegacyChildIdentityKey(item) {
  if (!item) return null;
  const type = item.ItemType || item.Type;
  if (type !== "Season" && type !== "Episode") return null;

  const tmdb = item.Provider_tmdb || item.ProviderIds?.Tmdb;
  const seasonNum = item.SeasonNumber ?? item.ParentIndexNumber;
  if (!tmdb || seasonNum == null) return null;

  if (type === "Season") return `series:tmdb:${tmdb}:s${seasonNum}`;

  const episodeNum = item.EpisodeNumber ?? item.IndexNumber;
  if (episodeNum == null) return null;
  const epEnd = item.IndexNumberEnd ?? item.EpisodeNumberEnd;
  const epSuffix =
    epEnd != null && epEnd !== episodeNum
      ? `e${episodeNum}-${epEnd}`
      : `e${episodeNum}`;
  return `series:tmdb:${tmdb}:s${seasonNum}${epSuffix}`;
}
