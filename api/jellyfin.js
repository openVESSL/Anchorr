import axios from "axios";
import logger from "../utils/logger.js";

/**
 * Fetch all libraries from Jellyfin
 * @param {string} apiKey - Jellyfin API key
 * @param {string} baseUrl - Jellyfin base URL
 * @returns {Promise<Array>} Array of library objects with Id and Name
 */
export async function fetchLibraries(apiKey, baseUrl) {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/Library/VirtualFolders`;
    const response = await axios.get(url, {
      headers: { "X-MediaBrowser-Token": apiKey },
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
        const itemsUrl = `${baseUrl.replace(/\/$/, "")}/Items`;
        const itemsResponse = await axios.get(itemsUrl, {
          headers: { "X-MediaBrowser-Token": apiKey },
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

    const response = await axios.get(ancestorsUrl, {
      headers: { "X-MediaBrowser-Token": apiKey },
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
          const libResponse = await axios.get(libItemsUrl, {
            headers: { "X-MediaBrowser-Token": apiKey },
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
          // Silent fail for recursive search
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

/**
 * Find library ID for an item by traversing up the parent chain
 * @param {string} itemId - Item ID to find library for
 * @param {string} apiKey - Jellyfin API key
 * @param {string} baseUrl - Jellyfin base URL
 * @param {Map} libraryMap - Map of library CollectionId -> library object
 * @returns {Promise<string|null>} Library ItemId (for config matching) or null
 */
export async function findLibraryId(
  itemId,
  apiKey,
  baseUrl,
  libraryMap,
  depth = 0
) {
  // Prevent infinite recursion
  if (depth > 5) {
    logger.debug(`Max recursion depth reached for item ${itemId}`);
    return null;
  }

  try {
    logger.info(`[Depth ${depth}] Finding library for item: ${itemId}`);

    // Use the /Items endpoint without userId to avoid 400 errors
    const url = `${baseUrl.replace(/\/$/, "")}/Items`;
    const response = await axios.get(url, {
      headers: { "X-MediaBrowser-Token": apiKey },
      params: {
        Ids: itemId,
        Fields: "ParentId,Path", // Request Path to help identify library
      },
      timeout: 5000,
    });

    // Response is {Items: [...]}
    const items = response.data?.Items || [];
    if (items.length === 0) {
      logger.info(`No item found for ID: ${itemId}`);
      return null;
    }

    const item = items[0];
    logger.info(
      `[Depth ${depth}] Item ${itemId} has ParentId: ${item.ParentId}`
    );
    if (item.Path) {
      logger.debug(`[Depth ${depth}] Item path: ${item.Path}`);
    }

    // Check if current item's ParentId matches any library's CollectionId
    if (item.ParentId) {
      for (const [collectionId, library] of libraryMap.entries()) {
        if (
          item.ParentId === collectionId ||
          item.ParentId === library.ItemId
        ) {
          logger.info(
            `✅ Found library: ${library.Name} (ItemId: ${library.ItemId}) for item ${itemId}`
          );
          return library.ItemId; // Return ItemId for config matching
        }
      }
    }

    // Check if item itself is a library
    for (const [collectionId, library] of libraryMap.entries()) {
      if (itemId === collectionId || itemId === library.ItemId) {
        logger.info(`✅ Item ${itemId} is itself library: ${library.Name}`);
        return library.ItemId;
      }
    }

    // If item has no parent, check if it's actually a library
    if (!item.ParentId || item.ParentId === null) {
      // Check if this item is a library
      for (const [collectionId, library] of libraryMap.entries()) {
        if (itemId === collectionId || itemId === library.ItemId) {
          logger.info(
            `✅ Item ${itemId} has no parent and is library: ${library.Name}`
          );
          return library.ItemId;
        }
      }

      logger.warn(
        `⚠️ Item ${itemId} has no parent but is NOT a library. This might be a folder or collection.`
      );
      logger.warn(
        `   Known libraries: ${Array.from(libraryMap.values())
          .map((lib) => `${lib.Name} (${lib.ItemId})`)
          .join(", ")}`
      );

      // REVERSE LOOKUP: Check if any library has THIS item as its parent
      // This handles cases where libraries are nested inside collections/folders
      logger.info(`   Checking if any library is a child of this folder...`);
      for (const [collectionId, library] of libraryMap.entries()) {
        try {
          const libResponse = await axios.get(url, {
            headers: { "X-MediaBrowser-Token": apiKey },
            params: { Ids: library.ItemId, Fields: "ParentId" },
            timeout: 5000,
          });
          const libItems = libResponse.data?.Items || [];
          if (libItems.length > 0 && libItems[0].ParentId === itemId) {
            logger.info(
              `   ✅ Library ${library.Name} has this folder as parent! Returning library: ${library.ItemId}`
            );
            return library.ItemId;
          }
        } catch (err) {
          logger.debug(
            `   Failed to check library ${library.Name}: ${err.message}`
          );
        }
      }

      return null;
    }

    // Recursively check parent
    if (item.ParentId) {
      logger.info(`[Depth ${depth}] Checking parent: ${item.ParentId}`);
      return await findLibraryId(
        item.ParentId,
        apiKey,
        baseUrl,
        libraryMap,
        depth + 1
      );
    }

    logger.info(`No parent found for item ${itemId}`);
    return null;
  } catch (err) {
    logger.warn(
      `Failed to find library for item ${itemId}:`,
      err?.message || err
    );
    return null;
  }
}

/**
 * Fetch recently added items from Jellyfin
 * @param {string} apiKey - Jellyfin API key
 * @param {string} baseUrl - Jellyfin base URL
 * @param {number} limit - Maximum number of items to fetch
 * @returns {Promise<Array>} Array of recently added items
 */
export async function fetchRecentlyAdded(apiKey, baseUrl, limit = 50) {
  try {
    // Use /Items endpoint with SortBy=DateCreated for recently added items
    // Note: /Items/Latest requires userId and has compatibility issues with API keys
    const url = `${baseUrl.replace(/\/$/, "")}/Items`;
    const response = await axios.get(url, {
      headers: { "X-MediaBrowser-Token": apiKey },
      params: {
        SortBy: "DateCreated",
        SortOrder: "Descending",
        Limit: limit,
        Fields: "ProviderIds,Overview,Genres,RunTimeTicks,ParentId",
        IncludeItemTypes: "Movie,Series,Season,Episode",
        Recursive: true,
      },
      timeout: 10000,
    });

    // Handle both direct array response and Items property
    const items = response.data?.Items || response.data || [];

    logger.debug(`Fetched ${items.length} recently added items from Jellyfin`);

    // Log first item's library info for debugging
    if (items.length > 0) {
      const firstItem = items[0];
      logger.debug(
        `First item: ${firstItem.Name} (Type: ${firstItem.Type}, ParentId: ${firstItem.ParentId})`
      );
    }

    return items;
  } catch (err) {
    logger.error(
      "Failed to fetch recently added items from Jellyfin:",
      err?.message || err
    );
    // Return empty array instead of failing
    return [];
  }
}

/**
 * Fetch detailed information about a specific item
 * @param {string} itemId - Jellyfin item ID
 * @param {string} apiKey - Jellyfin API key
 * @param {string} baseUrl - Jellyfin base URL
 * @returns {Promise<Object|null>} Item details or null if failed
 */
export async function fetchItemDetails(itemId, apiKey, baseUrl) {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/Items/${itemId}`;
    const response = await axios.get(url, {
      headers: { "X-MediaBrowser-Token": apiKey },
      timeout: 5000,
    });

    return response.data;
  } catch (err) {
    logger.warn(
      `Failed to fetch item details for ${itemId}:`,
      err?.message || err
    );
    return null;
  }
}

/**
 * Transform Jellyfin item to webhook-compatible format
 * @param {Object} item - Jellyfin item object
 * @param {string} baseUrl - Jellyfin base URL
 * @param {string} serverId - Jellyfin server ID
 * @returns {Object} Webhook-compatible data object
 */
export function transformToWebhookFormat(item, baseUrl, serverId) {
  const data = {
    ItemType: item.Type,
    ItemId: item.Id,
    Name: item.Name,
    Year: item.ProductionYear,
    Overview: item.Overview,
    Genres: item.Genres || [],
    ServerUrl: baseUrl,
    ServerId: serverId,
  };

  // Add TMDB ID if available
  if (item.ProviderIds?.Tmdb) {
    data.Provider_tmdb = item.ProviderIds.Tmdb;
  }

  // Add IMDb ID if available
  if (item.ProviderIds?.Imdb) {
    data.Provider_imdb = item.ProviderIds.Imdb;
  }

  // Add runtime in ticks (convert to minutes for display)
  if (item.RunTimeTicks) {
    data.RunTime = Math.round(item.RunTimeTicks / 600000000); // Convert ticks to minutes
  }

  // For TV shows, add series-specific data
  if (item.Type === "Series") {
    data.SeriesId = item.Id;
    data.SeriesName = item.Name;
  } else if (item.Type === "Season") {
    data.SeriesId = item.SeriesId;
    data.SeriesName = item.SeriesName;
    data.SeasonId = item.Id;
    data.IndexNumber = item.IndexNumber;
  } else if (item.Type === "Episode") {
    data.SeriesId = item.SeriesId;
    data.SeriesName = item.SeriesName;
    data.SeasonId = item.SeasonId;
    data.IndexNumber = item.IndexNumber;
    data.ParentIndexNumber = item.ParentIndexNumber;
  }

  // Add library ID - use ParentIds[0] if available (most reliable), otherwise fallback to ParentId
  if (
    item.ParentIds &&
    Array.isArray(item.ParentIds) &&
    item.ParentIds.length > 0
  ) {
    data.LibraryId = item.ParentIds[0]; // First ParentId is the library
  } else {
    data.LibraryId = item.ParentId;
  }

  return data;
}
