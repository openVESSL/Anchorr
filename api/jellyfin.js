import http from "../utils/http.js";
import { createRequire } from "module";
import logger from "../utils/logger.js";

const require = createRequire(import.meta.url);
const APP_VERSION = require("../package.json").version || "0.0.0";

// Jellyfin 12 disables legacy authorization by default, which kills the old
// X-MediaBrowser-Token header. The standard Authorization header with the
// MediaBrowser scheme works on 10.10.x and 12.x alike.
export function jellyfinAuthHeaders(apiKey) {
  const key = String(apiKey ?? "").trim();
  if (!key) {
    throw new Error("Jellyfin API key is missing - cannot build an Authorization header");
  }
  // Quotes, commas and control chars would break the header's own syntax.
  // Stripping them silently would send a wrong token and surface as a generic
  // 401, so reject instead and name the real problem.
  if (/["'\\,\x00-\x1f\x7f]/.test(key)) {
    throw new Error(
      "Jellyfin API key contains characters that are invalid in an Authorization header (quotes, comma, backslash or control characters)"
    );
  }
  return {
    Authorization: `MediaBrowser Client="Anchorr", Device="Anchorr", DeviceId="anchorr-bot", Version="${APP_VERSION}", Token="${key}"`,
  };
}

/**
 * Fetch all libraries from Jellyfin
 * @param {string} apiKey - Jellyfin API key
 * @param {string} baseUrl - Jellyfin base URL
 * @returns {Promise<Array>} Array of library objects with Id and Name
 */
export async function fetchLibraries(apiKey, baseUrl) {
  try {
    const safeBase = new URL(baseUrl);
    const basePathNoSlash = safeBase.pathname.replace(/\/$/, "");
    safeBase.pathname = basePathNoSlash + "/Library/VirtualFolders";
    const url = safeBase.href;
    const response = await http.get(url, {
      headers: jellyfinAuthHeaders(apiKey),
      timeout: 5000,
    });

    const virtualFolders = response.data || [];
    logger.debug(
      `Fetched ${virtualFolders.length} virtual folders from Jellyfin`
    );

    // For each virtual folder, fetch the actual library item to get the real collection ID
    const libraries = [];
    for (const vf of virtualFolders) {
      try {
        // Query the Items endpoint to find the actual library collection
        const itemsUrlObj = new URL(baseUrl);
        itemsUrlObj.pathname = basePathNoSlash + "/Items";
        const itemsUrl = itemsUrlObj.href;
        const itemsResponse = await http.get(itemsUrl, {
          headers: jellyfinAuthHeaders(apiKey),
          params: {
            Ids: vf.ItemId,
            Fields: "Path,LibraryOptions",
          },
          timeout: 5000,
        });

        const items = itemsResponse.data?.Items || [];
        if (items.length > 0) {
          const actualLibrary = items[0];
          libraries.push({
            ...vf,
            ItemId: vf.ItemId, // Virtual folder ID (for UI/config)
            CollectionId: actualLibrary.Id, // Actual collection ID (for matching content)
            Name: vf.Name,
            CollectionType: vf.CollectionType,
            Path: actualLibrary.Path || null,
            Locations: vf.Locations || [], // Add locations from VirtualFolder
          });
          logger.debug(
            `Library "${vf.Name}": Locations=[${vf.Locations?.join(", ")}]`
          );
        } else {
          // Fallback: if we can't get the collection ID, use the virtual folder ID
          libraries.push({
            ...vf,
            ItemId: vf.ItemId,
            CollectionId: vf.ItemId,
            Name: vf.Name,
          });
          logger.warn(
            `Could not fetch collection ID for library "${vf.Name}", using virtual folder ID`
          );
        }
      } catch (err) {
        logger.warn(
          `Failed to fetch collection ID for library "${vf.Name}":`,
          err?.message || err
        );
        // Fallback: use virtual folder ID as collection ID
        libraries.push({
          ...vf,
          ItemId: vf.ItemId,
          CollectionId: vf.ItemId,
          Name: vf.Name,
        });
      }
    }

    return libraries;
  } catch (err) {
    logger.error(
      "Failed to fetch libraries from Jellyfin:",
      err?.message || err
    );
    throw err;
  }
}

/**
 * Find a Jellyfin item by its TMDB provider ID
 * @param {string} tmdbId - TMDB ID to search for
 * @param {string} mediaType - "movie" or "tv"
 * @param {string} apiKey - Jellyfin API key
 * @param {string} baseUrl - Jellyfin base URL
 * @returns {Promise<string|null>} Jellyfin item ID or null if not found
 */
export async function findItemByTmdbId(tmdbId, mediaType, apiKey, baseUrl) {
  try {
    const itemType = mediaType === "movie" ? "Movie" : "Series";
    const safeBase = new URL(baseUrl);
    safeBase.pathname = safeBase.pathname.replace(/\/$/, "") + "/Items";
    const url = safeBase.href;
    const response = await http.get(url, {
      headers: jellyfinAuthHeaders(apiKey),
      params: {
        Recursive: true,
        AnyProviderIdEquals: `Tmdb.${tmdbId}`,
        IncludeItemTypes: itemType,
        Limit: 1,
        Fields: "ProviderIds",
      },
      timeout: 5000,
    });
    const items = response.data?.Items || [];
    return items.length > 0 ? items[0].Id : null;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
      logger.error(`[findItemByTmdbId] Jellyfin rejected request for TMDB ID ${tmdbId} (HTTP ${status}) — check JELLYFIN_API_KEY`);
    } else if (status >= 500) {
      logger.error(`[findItemByTmdbId] Jellyfin server error for TMDB ID ${tmdbId} (HTTP ${status}): ${err?.message || err}`);
    } else {
      logger.warn(`[findItemByTmdbId] Could not look up TMDB ID ${tmdbId} in Jellyfin: ${err?.message || err}${err?.code ? ` (${err.code})` : ""}`);
    }
    return null;
  }
}

/**
 * Find library for an item by querying Jellyfin's ancestor endpoint
 * This is more reliable than traversing parent chain
 * @param {string} itemId - Item ID to find library for
 * @param {string} apiKey - Jellyfin API key
 * @param {string} baseUrl - Jellyfin base URL
 * @param {Map} libraryMap - Map of library CollectionId -> library object
 * @returns {Promise<string|null>} Library ItemId (for config matching) or null
 */
export async function findLibraryByAncestors(
  itemId,
  apiKey,
  baseUrl,
  libraryMap,
  itemType
) {
  try {
    // Use the Ancestors endpoint to get all parents of the item
    const ancestorsUrl = `${baseUrl.replace(
      /\/$/,
      ""
    )}/Items/${itemId}/Ancestors`;

    const response = await http.get(ancestorsUrl, {
      headers: jellyfinAuthHeaders(apiKey),
      timeout: 5000,
    });

    const ancestors = response.data || [];

    // Helper function to check if library type matches item type
    const isTypeMatch = (libType, itemType) => {
      if (!libType || !itemType) return true;
      const lib = libType.toLowerCase();
      const item = itemType.toLowerCase();

      if (item === "movie" && lib === "movies") return true;
      if (
        (item === "series" || item === "season" || item === "episode") &&
        lib === "tvshows"
      )
        return true;
      if (item === "audio" && lib === "music") return true;

      if (item === "movie" && lib === "tvshows") return false;
      if (
        (item === "series" || item === "season" || item === "episode") &&
        lib === "movies"
      )
        return false;

      return true;
    };

    // Check each ancestor to see if it matches a library by ID or Path
    for (const ancestor of ancestors) {
      for (const [mapKey, library] of libraryMap.entries()) {
        // 1. Check ID match
        if (
          ancestor.Id === library.CollectionId ||
          ancestor.Id === library.ItemId
        ) {
          if (isTypeMatch(library.CollectionType, itemType)) {
            return library.ItemId;
          }
        }

        // 2. Check Path match (Robust for Docker/Virtual folders)
        if (
          ancestor.Path &&
          library.Locations &&
          library.Locations.length > 0
        ) {
          for (const loc of library.Locations) {
            const normAncestorPath = ancestor.Path.replace(
              /\\/g,
              "/"
            ).toLowerCase();
            const normLibPath = loc.replace(/\\/g, "/").toLowerCase();

            if (
              normAncestorPath === normLibPath ||
              normAncestorPath.startsWith(normLibPath)
            ) {
              if (isTypeMatch(library.CollectionType, itemType)) {
                return library.ItemId;
              }
            }
          }
        }
      }
    }

    // Fallback: Recursive search (only if path matching failed)
    for (const ancestor of ancestors) {
      if (ancestor.Type === "AggregateFolder") continue;

      for (const [mapKey, library] of libraryMap.entries()) {
        if (!isTypeMatch(library.CollectionType, itemType)) continue;

        try {
          const libItemsUrl = `${baseUrl.replace(/\/$/, "")}/Items`;
          const libResponse = await http.get(libItemsUrl, {
            headers: jellyfinAuthHeaders(apiKey),
            params: {
              ParentId: library.ItemId,
              Recursive: true,
              Ids: ancestor.Id,
              Limit: 1,
            },
            timeout: 5000,
          });

          if (libResponse.data?.Items?.length > 0) {
            return library.ItemId;
          }
        } catch (err) {
          logger.warn(
            `findLibraryByAncestors: ancestor check failed for item ${itemId} in library ${library.Name}: ${err?.message || err}`
          );
        }
      }
    }

    logger.warn(`Could not determine library for item ${itemId}`);
    return null;
  } catch (err) {
    logger.error(
      `Failed to find library by ancestors for item ${itemId}:`,
      err?.message || err
    );
    return null;
  }
}

const FETCH_RECENTLY_ADDED_MAX_TOTAL = 5000;

/**
 * Fetch recently added items. With `minDateCreated`, paginates via
 * StartIndex/Limit and breaks early once items fall below the cutoff
 * (results are DateCreated desc). Server-side filter is `MinDateLastSaved`
 * — Jellyfin silently ignores `MinDateCreated` — so callers must still
 * filter by `DateCreated` client-side.
 *
 * Returns { items, complete, truncated }. `complete` is false if a page fetch
 * failed partway through — retryable. `truncated` is true if the maxTotal cap
 * cut the window short — NOT retryable, a retry truncates identically, so
 * callers should disclose it rather than fail. Both are absent/false on the
 * unpaginated path (no minDateCreated), which simply caps at `limit`.
 */
export async function fetchRecentlyAdded(
  apiKey,
  baseUrl,
  limit = 50,
  minDateCreated,
  parentId,
  maxTotal = FETCH_RECENTLY_ADDED_MAX_TOTAL
) {
  try {
    const safeBase = new URL(baseUrl);
    safeBase.pathname = safeBase.pathname.replace(/\/$/, "") + "/Items";
    const url = safeBase.href;
    const baseParams = {
      SortBy: "DateCreated",
      SortOrder: "Descending",
      Limit: limit,
      Fields: "ProviderIds,Overview,Genres,RunTimeTicks,ParentId,DateCreated,SeriesName,SeasonName,IndexNumber,ParentIndexNumber,AncestorIds,ProductionYear",
      IncludeItemTypes: "Movie,Series,Season,Episode",
      Recursive: true,
    };
    if (minDateCreated) {
      baseParams.MinDateLastSaved = minDateCreated;
    }
    if (parentId) {
      baseParams.ParentId = parentId;
    }

    if (!minDateCreated) {
      const response = await http.get(url, {
        headers: jellyfinAuthHeaders(apiKey),
        params: baseParams,
        timeout: 10000,
      });
      const items = response.data?.Items || response.data || [];
      logger.debug(
        `Fetched ${items.length} recently added items from Jellyfin`
      );
      return { items, complete: true, truncated: false };
    }

    const cutoffMs = new Date(minDateCreated).getTime();
    const collected = [];
    let startIndex = 0;
    let stopReason = "loop-exit";
    let complete = true;
    let truncated = false;
    while (collected.length < maxTotal) {
      const params = { ...baseParams, StartIndex: startIndex };
      let page;
      try {
        const response = await http.get(url, {
          headers: jellyfinAuthHeaders(apiKey),
          params,
          timeout: 10000,
        });
        const body = response.data;
        if (!body || !Array.isArray(body.Items)) {
          logger.warn(
            `fetchRecentlyAdded: unexpected response shape from Jellyfin (StartIndex=${startIndex}) — stopping pagination`
          );
          stopReason = "page-error";
          complete = false;
          break;
        }
        page = body.Items;
      } catch (err) {
        if (!err?.isAxiosError) throw err;
        logger.warn(
          `fetchRecentlyAdded: page at StartIndex=${startIndex} failed (${err?.message || err}); returning ${collected.length} items collected so far (incomplete)`
        );
        stopReason = "page-error";
        complete = false;
        break;
      }
      if (page.length === 0) {
        stopReason = "empty-page";
        break;
      }

      let stop = false;
      for (const item of page) {
        const created = item.DateCreated
          ? new Date(item.DateCreated).getTime()
          : NaN;
        if (Number.isFinite(created) && created < cutoffMs) {
          stop = true;
          stopReason = "cutoff-hit";
          break;
        }
        collected.push(item);
        if (collected.length >= maxTotal) {
          stop = true;
          stopReason = "max-total-hit";
          truncated = true;
          logger.warn(
            `fetchRecentlyAdded: hit maxTotal=${maxTotal} cap; older items in this window were truncated`
          );
          break;
        }
      }
      if (stop) break;
      if (page.length < limit) {
        stopReason = "short-page";
        break;
      }
      startIndex += page.length;
    }

    logger.debug(
      `Fetched ${collected.length} recently added items from Jellyfin (since ${minDateCreated}, paginated, stop=${stopReason}, complete=${complete}, truncated=${truncated})`
    );
    return { items: collected, complete, truncated };
  } catch (err) {
    logger.error(
      "Failed to fetch recently added items from Jellyfin:",
      err?.message || err
    );
    throw err;
  }
}
