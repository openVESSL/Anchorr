import axios from "axios";
import { jellyfinAuthHeaders } from "../api/jellyfin.js";
import logger from "../utils/logger.js";

const CACHE_DURATION_MS = 6 * 60 * 60 * 1000;
const seriesProviderCache = new Map();

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

  if (data.SeriesProvider_tmdb || data.SeriesProvider_imdb) {
    return {
      Tmdb: data.SeriesProvider_tmdb || null,
      Imdb: data.SeriesProvider_imdb || null,
    };
  }

  const cached = seriesProviderCache.get(data.SeriesId);
  const now = Date.now();
  if (cached && now - cached.timestamp < CACHE_DURATION_MS) {
    return cached.data;
  }

  if (!apiKey || !baseUrl) {
    logger.warn(
      `Cannot resolve parent series metadata for ${data.ItemType} "${data.Name}": JELLYFIN_API_KEY or JELLYFIN_BASE_URL is missing`
    );
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
    seriesProviderCache.set(data.SeriesId, {
      data: providerIds,
      timestamp: now,
    });
    return providerIds;
  } catch (error) {
    logger.warn(
      `Could not resolve parent series metadata for ${data.ItemType} "${data.Name}" (SeriesId=${data.SeriesId}): ${error?.message || error}`
    );
    return null;
  }
}
