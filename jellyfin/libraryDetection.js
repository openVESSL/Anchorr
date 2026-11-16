/**
 * Which Jellyfin library an item belongs to, and so which Discord channel announces it.
 */
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";
import { getLibraryAnimeFlag, getLibraryChannels, resolveTargetChannel } from "./libraryResolver.js";

// Libraries change rarely: the dashboard fills this when it lists them, items reuse it
export const libraryCache = {
  data: null,
  timestamp: null,
  isValid() {
    return this.data && this.timestamp && Date.now() - this.timestamp < 15 * 60 * 1000;
  },
  set(libraries) {
    this.data = libraries;
    this.timestamp = Date.now();
  },
  get() {
    return this.isValid() ? this.data : null;
  },
};

// Only known cross-type mismatches are rejected; "mixed" and custom collection types
// (for example anime libraries) accept anything.
function typeMatches(itemType, collectionType) {
  const item = itemType?.toLowerCase();
  const lib = collectionType?.toLowerCase();
  if (item === "movie" && lib === "tvshows") return false;
  if (["series", "season", "episode"].includes(item) && lib === "movies") return false;
  return true;
}

/** Finds the library from the item's path, then from its ancestors. */
async function detectLibraryId(data) {
  const apiKey = settings.JELLYFIN_API_KEY;
  const baseUrl = settings.JELLYFIN_BASE_URL;
  if (!apiKey || !baseUrl) {
    logger.warn("Cannot detect library: JELLYFIN_API_KEY or JELLYFIN_BASE_URL not configured");
    return null;
  }
  const jellyfin = await import("../api/jellyfin.js");
  const libraries = libraryCache.get() ?? (await jellyfin.fetchLibraries(apiKey, baseUrl));

  if (data.Path) {
    const itemPath = data.Path.replace(/\\/g, "/").toLowerCase();
    for (const lib of libraries) {
      const inLibrary = (lib.Locations ?? []).some((location) => itemPath.startsWith(location.replace(/\\/g, "/").toLowerCase()));
      if (inLibrary && typeMatches(data.ItemType, lib.CollectionType)) {
        logger.debug(`✅ Library detected via Path matching: ${lib.ItemId} (${lib.Name})`);
        return lib.ItemId;
      }
    }
  }

  // Both ids point to the library: items may report either
  const libraryMap = new Map();
  for (const lib of libraries) {
    libraryMap.set(lib.CollectionId, lib);
    if (lib.ItemId !== lib.CollectionId) libraryMap.set(lib.ItemId, lib);
  }
  const libraryId = await jellyfin.findLibraryByAncestors(data.ItemId, apiKey, baseUrl, libraryMap, data.ItemType);
  if (libraryId) logger.debug(`✅ Library detected via Ancestors: ${libraryId}`);
  return libraryId;
}

/**
 * The library channel for an item: { channelId, isAnime }, or null when its library is
 * turned off. Test items always go to the default channel.
 */
export async function chooseLibraryChannel(data, isTest) {
  if (isTest) {
    logger.info(`🧪 Test notification detected. Using default channel: ${settings.JELLYFIN_CHANNEL_ID}`);
    return { channelId: settings.JELLYFIN_CHANNEL_ID, isAnime: false };
  }

  let libraryId = data.LibraryId || data.CollectionId || data.Library_Id;
  if (!libraryId) {
    try {
      libraryId = await detectLibraryId(data);
    } catch (err) {
      logger.warn(`Advanced library detection failed:`, err?.message || err);
    }
  }
  // Items may carry the CollectionId while the config is keyed by the VirtualFolder ItemId
  const match = libraryId && libraryCache.get()?.find((lib) => lib.CollectionId === libraryId);
  if (match) {
    logger.debug(`🔄 Resolved CollectionId ${libraryId} → ItemId ${match.ItemId}`);
    libraryId = match.ItemId;
  }

  const libraries = getLibraryChannels();
  const configured = Object.keys(libraries).length > 0;
  logger.debug(`Configured libraries: ${JSON.stringify(libraries)}`);

  if (configured && libraryId) {
    const channelId = resolveTargetChannel(libraryId, libraries);
    if (channelId === null) return null; // resolveTargetChannel logged the skip
    const isAnime = getLibraryAnimeFlag(libraryId, libraries);
    logger.info(`✅ Using channel: ${channelId} for configured library: ${libraryId}${isAnime ? " [anime]" : ""}`);
    return { channelId, isAnime };
  }
  if (configured) {
    logger.warn(`⚠️ Could not detect library for item "${data.Name}". Using default channel: ${settings.JELLYFIN_CHANNEL_ID}`);
  } else {
    logger.debug(`No library filtering configured. Using default channel: ${settings.JELLYFIN_CHANNEL_ID}`);
  }
  return { channelId: settings.JELLYFIN_CHANNEL_ID, isAnime: false };
}
