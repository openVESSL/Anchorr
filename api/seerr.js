/**
 * Seerr API Client
 * Handles all Seerr API interactions
 */

import crypto from "node:crypto";
import http from "../utils/http.js";
import * as mokaApi from "./moka.js";
import logger from "../utils/logger.js";
import { TIMEOUTS, CACHE_TTL } from "../lib/constants.js";
import { getSeerrApiUrl } from "../utils/seerrUrl.js";

// Cache for tags, quality profiles, and servers
let tagsCache = null;
let tagsCacheTime = 0;
let qualityProfilesCache = null;
let qualityProfilesCacheTime = 0;
let serversCache = null;
let serversCacheTime = 0;

/**
 * Ensures the URL has the correct API v1 suffix
 * @param {string} url - The base URL
 * @returns {string} The normalized API URL
 */
function normalizeApiUrl(url) {
  if (!url) return url;
  return getSeerrApiUrl(url);
}

/**
 * Fetch data from Radarr/Sonarr servers
 * @param {string} seerrUrl - Seerr API URL
 * @param {string} apiKey - Seerr API key
 * @param {boolean} fetchDetails - Whether to fetch detailed info for each server
 * @param {Function} extractData - Function to extract data from server/details response
 * @returns {Promise<Array>} Extracted data
 */
async function fetchFromServers(seerrUrl, apiKey, fetchDetails, extractData) {
  const results = [];
  const safeApiUrl = new URL(normalizeApiUrl(seerrUrl));
  const basePath = safeApiUrl.pathname.replace(/\/$/, "");
  const buildUrl = (suffix) => {
    const u = new URL(safeApiUrl.href);
    u.pathname = basePath + suffix;
    return u.href;
  };

  // Fetch from Radarr servers
  try {
    const radarrListResponse = await http.get(
      buildUrl("/service/radarr"),
      {
        headers: { "X-Api-Key": apiKey },
        timeout: TIMEOUTS.SEERR_API,
      }
    );

    for (const server of radarrListResponse.data) {
      try {
        if (fetchDetails) {
          const serverId = parseInt(server.id, 10);
          const detailsResponse = await http.get(
            buildUrl(`/service/radarr/${serverId}`),
            {
              headers: { "X-Api-Key": apiKey },
              timeout: TIMEOUTS.SEERR_API,
            }
          );
          const data = extractData(server, detailsResponse.data, "radarr");
          if (data) results.push(...(Array.isArray(data) ? data : [data]));
        } else {
          const data = extractData(server, null, "radarr");
          if (data) results.push(...(Array.isArray(data) ? data : [data]));
        }
      } catch (err) {
        logger.warn(
          `Failed to fetch Radarr ${server.id} details:`,
          err?.message
        );
      }
    }
  } catch (err) {
    logger.warn("Failed to fetch Radarr servers:", err?.message);
  }

  // Fetch from Sonarr servers
  try {
    const sonarrListResponse = await http.get(
      buildUrl("/service/sonarr"),
      {
        headers: { "X-Api-Key": apiKey },
        timeout: TIMEOUTS.SEERR_API,
      }
    );

    for (const server of sonarrListResponse.data) {
      try {
        if (fetchDetails) {
          const serverId = parseInt(server.id, 10);
          const detailsResponse = await http.get(
            buildUrl(`/service/sonarr/${serverId}`),
            {
              headers: { "X-Api-Key": apiKey },
              timeout: TIMEOUTS.SEERR_API,
            }
          );
          const data = extractData(server, detailsResponse.data, "sonarr");
          if (data) results.push(...(Array.isArray(data) ? data : [data]));
        } else {
          const data = extractData(server, null, "sonarr");
          if (data) results.push(...(Array.isArray(data) ? data : [data]));
        }
      } catch (err) {
        logger.warn(
          `Failed to fetch Sonarr ${server.id} details:`,
          err?.message
        );
      }
    }
  } catch (err) {
    logger.warn("Failed to fetch Sonarr servers:", err?.message);
  }

  return results;
}

/**
 * Check if media exists and is available in Seerr
 * @param {number} tmdbId - TMDB ID
 * @param {string} mediaType - 'movie' or 'tv'
 * @param {Array} requestedSeasons - Season numbers or ['all']
 * @param {string} seerrUrl - Seerr API URL
 * @param {string} apiKey - Seerr API key
 * @returns {Promise<Object>} Status object { exists, available, status?, data? }
 * @throws {Error} For network errors, authentication failures, or 5xx responses
 */
export async function checkMediaStatus(
  tmdbId,
  mediaType,
  requestedSeasons = [],
  seerrUrl,
  apiKey
) {
  if (mokaApi.isMokaMode()) return mokaApi.mediaStatus(tmdbId, mediaType);
  const apiUrl = normalizeApiUrl(seerrUrl);
  try {
    const url =
      mediaType === "movie"
        ? `${apiUrl}/movie/${tmdbId}`
        : `${apiUrl}/tv/${tmdbId}`;

    const response = await http.get(url, {
      headers: { "X-Api-Key": apiKey },
      timeout: TIMEOUTS.SEERR_API,
    });

    // For movies, simple check
    if (mediaType === "movie") {
      return {
        exists: true,
        available:
          response.data.mediaInfo?.status === 5 ||
          response.data.mediaInfo?.status === 4,
        status: response.data.mediaInfo?.status,
        data: response.data,
      };
    }

    // For TV shows, check specific seasons
    if (mediaType === "tv" && requestedSeasons.length > 0) {
      const seasonStatuses = response.data.mediaInfo?.seasons || [];

      // If requesting all seasons
      if (requestedSeasons.includes("all")) {
        if (seasonStatuses.length === 0) {
          return {
            exists: true,
            available: false,
            status: response.data.mediaInfo?.status,
            data: response.data,
          };
        }

        const allAvailable = seasonStatuses.every(
          (s) => s.status === 5 || s.status === 4
        );
        return {
          exists: true,
          available: allAvailable,
          status: response.data.mediaInfo?.status,
          data: response.data,
        };
      }

      // If requesting specific seasons
      const requestedSeasonNums = requestedSeasons.map((s) => parseInt(s, 10));
      const requestedSeasonAvailable = seasonStatuses.some(
        (s) =>
          requestedSeasonNums.includes(s.seasonNumber) &&
          (s.status === 5 || s.status === 4)
      );

      return {
        exists: true,
        available: requestedSeasonAvailable,
        status: response.data.mediaInfo?.status,
        data: response.data,
      };
    }

    // If no specific seasons requested, check overall status
    return {
      exists: true,
      available:
        response.data.mediaInfo?.status === 5 ||
        response.data.mediaInfo?.status === 4,
      status: response.data.mediaInfo?.status,
      data: response.data,
    };
  } catch (err) {
    // If 404, media doesn't exist in Seerr — this is an expected state, not an error
    if (err.response && err.response.status === 404) {
      return { exists: false, available: false };
    }
    // For all other errors (network, auth, 5xx) propagate so callers can surface them
    logger.error("Error checking media status:", err?.message || err);
    throw err;
  }
}

/**
 * Fetch tags from Radarr/Sonarr via Seerr
 * @param {string} seerrUrl - Seerr API URL
 * @param {string} apiKey - Seerr API key
 * @returns {Promise<Array>} Tags
 */
export async function fetchTags(seerrUrl, apiKey) {
  // Moka picks servers, profiles and tags itself
  if (mokaApi.isMokaMode()) return [];
  const now = Date.now();

  // Return cached tags if still valid
  if (tagsCache && now - tagsCacheTime < CACHE_TTL.TAGS) {
    return tagsCache;
  }

  try {
    const tags = await fetchFromServers(
      seerrUrl,
      apiKey,
      true,
      (server, details, type) => {
        if (!details?.tags) return [];
        return details.tags.map((tag) => ({
          id: tag.id,
          label: tag.label,
          serverId: server.id,
          serverName: server.name || `${type === "radarr" ? "Radarr" : "Sonarr"} ${server.id}`,
          type,
        }));
      }
    );

    tagsCache = tags;
    tagsCacheTime = now;

    logger.info(`✅ Fetched ${tags.length} tags from Seerr`);
    return tags;
  } catch (err) {
    logger.warn("Failed to fetch tags:", err?.message);
    return tagsCache || [];
  }
}

/**
 * Fetch servers (Radarr/Sonarr) via Seerr
 * @param {string} seerrUrl - Seerr API URL
 * @param {string} apiKey - Seerr API key
 * @returns {Promise<Array>} Servers list
 */
export async function fetchServers(seerrUrl, apiKey) {
  // Moka picks servers, profiles and tags itself
  if (mokaApi.isMokaMode()) return [];
  const now = Date.now();

  // Return cached servers if still valid
  if (serversCache && now - serversCacheTime < CACHE_TTL.SERVERS) {
    return serversCache;
  }

  try {
    const servers = await fetchFromServers(
      seerrUrl,
      apiKey,
      false,
      (server, _details, type) => ({
        id: server.id,
        name: server.name || `${type === "radarr" ? "Radarr" : "Sonarr"} ${server.id}`,
        isDefault: server.isDefault || false,
        type,
      })
    );

    serversCache = servers;
    serversCacheTime = now;

    logger.info(`✅ Fetched ${servers.length} servers from Seerr`);
    return servers;
  } catch (err) {
    logger.warn("Failed to fetch servers:", err?.message);
    return serversCache || [];
  }
}

/**
 * Fetch quality profiles from Radarr/Sonarr via Seerr
 * @param {string} seerrUrl - Seerr API URL
 * @param {string} apiKey - Seerr API key
 * @returns {Promise<Array>} Quality profiles
 */
export async function fetchQualityProfiles(seerrUrl, apiKey) {
  // Moka picks servers, profiles and tags itself
  if (mokaApi.isMokaMode()) return [];
  const now = Date.now();

  // Return cached profiles if still valid
  if (qualityProfilesCache && now - qualityProfilesCacheTime < CACHE_TTL.QUALITY_PROFILES) {
    return qualityProfilesCache;
  }

  try {
    const profiles = await fetchFromServers(
      seerrUrl,
      apiKey,
      true,
      (server, details, type) => {
        if (!details?.profiles) return [];
        return details.profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          serverId: server.id,
          serverName: server.name || `${type === "radarr" ? "Radarr" : "Sonarr"} ${server.id}`,
          type,
        }));
      }
    );

    qualityProfilesCache = profiles;
    qualityProfilesCacheTime = now;

    logger.info(`✅ Fetched ${profiles.length} quality profiles from Seerr`);
    return profiles;
  } catch (err) {
    logger.warn("Failed to fetch quality profiles:", err?.message);
    return qualityProfilesCache || [];
  }
}

/** Thrown when a Discord user has no Seerr account to request with (not mapped, no guest). */
export class NoSeerrUserError extends Error {
  constructor(discordUserId) {
    super(`No Seerr user to request with for Discord user ${discordUserId}`);
    this.name = "NoSeerrUserError";
  }
}

const isSeerrUserId = (id) => /^\d+$/.test(String(id ?? "")) && Number(id) > 0;

function findMappedSeerrUserId(discordUserId, userMappings) {
  let mappings = userMappings;
  if (typeof mappings === "string") {
    try {
      mappings = JSON.parse(mappings);
    } catch (err) {
      logger.error(`[SEERR] Failed to parse USER_MAPPINGS: ${err.message}`);
      return null;
    }
  }
  if (Array.isArray(mappings)) {
    return mappings.find((m) => String(m.discordUserId) === String(discordUserId))?.seerrUserId ?? null;
  }
  if (mappings && typeof mappings === "object") return mappings[discordUserId] ?? null;
  return null;
}

/**
 * Create a media request on behalf of a Discord user. It always runs as a Seerr user
 * (x-api-user): the mapped account, or the guest account for unmapped users, so Seerr
 * applies that user's permissions, quota and auto-approval. Never as the API key owner.
 * @param {number|string|Function} [params.guestUserId] guest account id, or an async resolver ({ seerrUrl, apiKey })
 * @throws {NoSeerrUserError} when the user is not mapped and there is no guest account
 */
export async function sendRequest({
  tmdbId,
  mediaType,
  seasons = [],
  discordUserId = null,
  rootFolder = null,
  serverId = null,
  profileId = null,
  tags = null,
  isAnime = false,
  seerrUrl,
  apiKey,
  userMappings = {},
  guestUserId = null,
}) {
  if (mokaApi.isMokaMode()) return mokaApi.requestAs({ tmdbId, mediaType, seasons, discordUserId });
  let mappedUserId = discordUserId ? findMappedSeerrUserId(discordUserId, userMappings) : null;
  // Seerr runs a request with an empty or non-numeric x-api-user as its admin (user 1)
  if (mappedUserId !== null && !isSeerrUserId(mappedUserId)) {
    logger.warn(`[SEERR] Ignoring the link of Discord user ${discordUserId}: "${mappedUserId}" is not a Seerr user id`);
    mappedUserId = null;
  }
  // guestUserId may be a resolver, only called when the user has no mapping; it asks the Seerr this request goes to
  const guest = mappedUserId === null && typeof guestUserId === "function" ? await guestUserId({ seerrUrl, apiKey }) : guestUserId;
  const seerrUserId = mappedUserId ?? (isSeerrUserId(guest) ? guest : null);
  if (seerrUserId === null) throw new NoSeerrUserError(discordUserId);

  const payload = {
    mediaType,
    mediaId: parseInt(tmdbId, 10),
    ...(isAnime && { isAnime: true }),
  };
  // TV: an empty list requests every season
  if (mediaType === "tv" && Array.isArray(seasons) && seasons.length > 0) {
    payload.seasons = seasons.includes("all") ? [] : seasons.map((s) => parseInt(s, 10));
  }
  if (Array.isArray(tags) && tags.length > 0) payload.tags = tags.map((t) => parseInt(t, 10));
  // Seerr only honors these for users allowed advanced requests
  if (serverId !== null && serverId !== undefined) payload.serverId = parseInt(serverId, 10);
  if (profileId !== null && profileId !== undefined) payload.profileId = parseInt(profileId, 10);
  if (rootFolder) payload.rootFolder = rootFolder;

  logger.info(
    `[SEERR] Requesting ${mediaType} ${tmdbId} for Discord user ${discordUserId} as Seerr user ${seerrUserId}${mappedUserId === null ? " (guest)" : ""}`
  );
  try {
    const response = await http.post(`${normalizeApiUrl(seerrUrl)}/request`, payload, {
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json", "x-api-user": String(seerrUserId) },
      timeout: TIMEOUTS.SEERR_POST,
    });
    return response.data;
  } catch (err) {
    const status = err?.response?.status;
    const details = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
    logger.error(`[SEERR] Request failed${status ? ` (HTTP ${status})` : ""}: ${details}`);
    throw err;
  }
}

// ----- Guest account for Discord users without a mapping -----

const PERMISSION_REQUEST = 32;
const PERMISSION_AUTO_APPROVE = 128;
export const GUEST_EMAIL = "discord@anchorr.invalid";
export const GUEST_USERNAME = "Discord (Anchorr)";

function seerrCall(method, seerrUrl, apiKey, path, data) {
  return http.request({
    method,
    url: `${normalizeApiUrl(seerrUrl)}${path}`,
    data,
    headers: { "X-Api-Key": apiKey },
    timeout: TIMEOUTS.SEERR_API,
  });
}

/**
 * Returns the guest account id, creating it when missing. The account can only request
 * (plus auto-approve if asked); the admin tunes quota and permissions in Seerr.
 * Its password is random and never stored: nobody signs in with it.
 */
export async function ensureGuestUser({ seerrUrl, apiKey, guestUserId = null, autoApprove = false }) {
  if (guestUserId) {
    try {
      const { data: user } = await seerrCall("get", seerrUrl, apiKey, `/user/${parseInt(guestUserId, 10)}`);
      // After a Seerr reinstall the saved id can belong to a real person
      if (user?.email === GUEST_EMAIL) return Number(guestUserId);
      logger.warn(`[SEERR] Seerr user ${guestUserId} is not the guest account (Seerr was reset?), looking for the guest again`);
    } catch (err) {
      if (err?.response?.status !== 404) throw err;
      logger.warn(`[SEERR] Guest user ${guestUserId} no longer exists in Seerr, creating a new one`);
    }
  }

  const permissions = PERMISSION_REQUEST | (autoApprove ? PERMISSION_AUTO_APPROVE : 0);
  try {
    const { data } = await seerrCall("post", seerrUrl, apiKey, "/user", {
      email: GUEST_EMAIL,
      username: GUEST_USERNAME,
      password: crypto.randomBytes(24).toString("base64url"),
      permissions,
    });
    logger.info(`[SEERR] Created guest user "${GUEST_USERNAME}" (id ${data.id}) for Discord users without a linked account`);
    return data.id;
  } catch (err) {
    if (err?.response?.status !== 409) throw err;
    // Left over from an earlier install: reuse it
    const { data } = await seerrCall("get", seerrUrl, apiKey, "/user?take=1000&skip=0");
    const existing = data?.results?.find((u) => u.email === GUEST_EMAIL);
    if (!existing) throw err;
    logger.info(`[SEERR] Reusing existing guest user (id ${existing.id})`);
    return existing.id;
  }
}

/** Turns the guest's AUTO_APPROVE permission on or off and leaves its other permissions alone. */
export async function setGuestAutoApprove({ seerrUrl, apiKey, guestUserId, autoApprove }) {
  const id = parseInt(guestUserId, 10);
  const { data: user } = await seerrCall("get", seerrUrl, apiKey, `/user/${id}`);
  if (user?.email !== GUEST_EMAIL) throw new Error(`Seerr user ${id} is not the guest account, its permissions were left alone`);
  const current = Number(user.permissions) || 0;
  const next = autoApprove ? current | PERMISSION_AUTO_APPROVE : current & ~PERMISSION_AUTO_APPROVE;
  if (next !== current) await seerrCall("put", seerrUrl, apiKey, `/user/${id}`, { permissions: next });
  return next;
}

// ----- setup -----

/** Seerr version for a URL + API key (throws on a wrong key or URL). */
/** False while Seerr's own setup is unfinished; its other endpoints answer 500 until then. */
export async function isSeerrInitialized(seerrUrl) {
  const { data } = await http.get(`${normalizeApiUrl(seerrUrl)}/settings/public`, { timeout: TIMEOUTS.SEERR_API });
  return data?.initialized !== false;
}

export async function getSeerrVersion(seerrUrl, apiKey) {
  const { data } = await http.get(`${normalizeApiUrl(seerrUrl)}/settings/about`, {
    headers: { "X-Api-Key": apiKey },
    timeout: TIMEOUTS.SEERR_API,
  });
  return data?.version ?? null;
}

/**
 * Reads Seerr's API key by signing in with a Jellyfin account (Seerr admins sign in this way).
 * The Seerr session is closed right after; the password is not kept.
 */
export async function getApiKeyWithJellyfinLogin(seerrUrl, username, password) {
  const base = normalizeApiUrl(seerrUrl);
  const login = await http.post(`${base}/auth/jellyfin`, { username, password }, { timeout: TIMEOUTS.SEERR_API });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("Seerr did not start a session");
  try {
    const { data } = await http.get(`${base}/settings/main`, { headers: { Cookie: cookie }, timeout: TIMEOUTS.SEERR_API });
    if (!data?.apiKey) throw new Error("This Seerr account cannot read the API key");
    return data.apiKey;
  } finally {
    await http.post(`${base}/auth/logout`, undefined, { headers: { Cookie: cookie }, timeout: TIMEOUTS.SEERR_API }).catch(() => {});
  }
}
