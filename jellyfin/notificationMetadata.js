import axios from "axios";
import { jellyfinAuthHeaders } from "../api/jellyfin.js";
import logger from "../utils/logger.js";

const CACHE_DURATION_MS = 6 * 60 * 60 * 1000;
// Short, so a series whose TMDB ID Jellyfin adds later is picked up soon.
const MISSING_TMDB_CACHE_MS = 15 * 60 * 1000;
const SERIES_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const FALLBACK_EFFECT =
  "the notification uses Jellyfin artwork, skips request DM matching and deduplicates by Jellyfin SeriesId";
const seriesProviderCache = new Map();
let missingConfigWarned = false;

function cacheSeriesProviderIds(seriesId, providerIds, ttlMs) {
  const now = Date.now();
  for (const [key, entry] of seriesProviderCache) {
    if (entry.expiresAt <= now) seriesProviderCache.delete(key);
  }
  seriesProviderCache.set(seriesId, { data: providerIds, expiresAt: now + ttlMs });
}

export function isSeriesChild(itemType) {
  return itemType === "Season" || itemType === "Episode";
}

/**
 * Return the TMDB ID appropriate for the endpoint used by notifications.
 * Item-level TMDB IDs for seasons and episodes are not TV-series IDs.
 */
export function getNotificationTmdbId(data) {
  return isSeriesChild(data?.ItemType)
    ? data.SeriesProvider_tmdb || null
    : data?.Provider_tmdb || null;
}

export function getBackdropItemId(data) {
  return isSeriesChild(data?.ItemType) && data.SeriesId
    ? data.SeriesId
    : data.ItemId;
}

/**
 * Fill parent-series provider IDs when the webhook did not include them.
 * The Jellyfin collection endpoint is used because it works with API-key-only
 * clients across supported Jellyfin versions.
 */
export async function resolveSeriesProviderIds(
  data,
  {
    apiKey = process.env.JELLYFIN_API_KEY,
    baseUrl = process.env.JELLYFIN_BASE_URL,
    httpClient = axios,
  } = {}
) {
  if (!data || !isSeriesChild(data.ItemType) || !data.SeriesId) return null;

  if (data.SeriesProvider_tmdb) {
    return {
      Tmdb: data.SeriesProvider_tmdb || null,
      Imdb: data.SeriesProvider_imdb || null,
    };
  }

  if (typeof data.SeriesId !== "string" || !SERIES_ID_PATTERN.test(data.SeriesId)) {
    logger.warn(
      `Ignoring malformed SeriesId on ${data.ItemType} "${data.Name}"; ${FALLBACK_EFFECT}`
    );
    return null;
  }

  const cached = seriesProviderCache.get(data.SeriesId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  if (!apiKey || !baseUrl) {
    if (!missingConfigWarned) {
      missingConfigWarned = true;
      logger.warn(
        `Cannot resolve parent series metadata: JELLYFIN_API_KEY or JELLYFIN_BASE_URL is missing. For every season/episode, ${FALLBACK_EFFECT}. This warning is shown once.`
      );
    }
    return null;
  }

  try {
    const itemUrl = new URL(baseUrl);
    itemUrl.pathname = itemUrl.pathname.replace(/\/$/, "") + "/Items";
    const response = await httpClient.get(itemUrl.href, {
      headers: jellyfinAuthHeaders(apiKey),
      params: {
        Ids: data.SeriesId,
        Fields: "ProviderIds",
        Limit: 1,
      },
      timeout: 5000,
    });
    const providerIds = response.data?.Items?.[0]?.ProviderIds || null;
    if (!providerIds?.Tmdb) {
      logger.warn(
        `Parent series of ${data.ItemType} "${data.Name}" (SeriesId=${data.SeriesId}) ${providerIds ? "has no TMDB ID in Jellyfin" : "was not found in Jellyfin"}; ${FALLBACK_EFFECT}`
      );
    }
    cacheSeriesProviderIds(
      data.SeriesId,
      providerIds,
      providerIds?.Tmdb ? CACHE_DURATION_MS : MISSING_TMDB_CACHE_MS
    );
    return providerIds;
  } catch (error) {
    logger.warn(
      `Could not resolve parent series metadata for ${data.ItemType} "${data.Name}" (SeriesId=${data.SeriesId}): ${error?.message || error}; ${FALLBACK_EFFECT}`
    );
    return null;
  }
}

/**
 * Attach parent-series provider IDs to a season/episode payload in place.
 * Runs at most once per payload: undefined means "not resolved yet", null
 * means "resolved, nothing found".
 */
export async function applySeriesProviderIds(data, options) {
  if (!data || !isSeriesChild(data.ItemType)) return;
  if (data.SeriesProvider_tmdb !== undefined) return;
  const providerIds = await resolveSeriesProviderIds(data, options);
  data.SeriesProvider_tmdb = providerIds?.Tmdb || null;
  data.SeriesProvider_imdb = providerIds?.Imdb || data.SeriesProvider_imdb || null;
}
