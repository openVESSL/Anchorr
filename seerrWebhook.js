import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { tmdbGetDetails, findBestBackdrop } from "./api/tmdb.js";
import { fetchOMDbData } from "./api/omdb.js";
import { fetchLibraries, findItemByTmdbId, findLibraryByAncestors } from "./api/jellyfin.js";
import { getLibraryChannels } from "./jellyfin/libraryResolver.js";
import { minutesToHhMm } from "./utils/time.js";
import { isValidUrl } from "./utils/url.js";
import logger from "./utils/logger.js";

/**
 * Build a Jellyfin search URL for the given title using the configured base URL.
 */
function buildJellyfinSearchUrl(title) {
  const base = process.env.JELLYFIN_BASE_URL;
  if (!base || !title) return null;
  try {
    const u = new URL(base);
    let p = u.pathname || "/";
    if (!p.endsWith("/")) p += "/";
    u.pathname = p + "web/index.html";
    u.hash = `!/search?query=${encodeURIComponent(title)}`;
    return u.toString();
  } catch (_e) {
    const baseNoSlash = String(base).replace(/\/+$/, "");
    return `${baseNoSlash}/web/index.html#!/search?query=${encodeURIComponent(title)}`;
  }
}

// Cache resolved library list to avoid N+1 Jellyfin API calls on every webhook
const libraryResolutionCache = { data: null, timestamp: null, errorTimestamp: null };
const LIBRARY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LIBRARY_CACHE_ERROR_COOLDOWN_MS = 60 * 1000; // 60 seconds backoff after a failed fetch

/**
 * Resolve the Discord channel ID for a given media item.
 * Looks up the item in Jellyfin by TMDB ID, then uses ancestor-based library
 * detection (same as the Jellyfin webhook) to find the exact library and its
 * mapped channel. Falls back to JELLYFIN_CHANNEL_ID if the item is not yet
 * in Jellyfin or no mapping is configured.
 */
async function resolveChannel(tmdbId, mediaType) {
  const defaultChannelId = process.env.JELLYFIN_CHANNEL_ID || null;
  const libraryChannels = getLibraryChannels();

  if (!Object.keys(libraryChannels).length) {
    logger.info(`[SEERR WEBHOOK] No library channel mapping configured, using default channel`);
    return defaultChannelId;
  }

  const apiKey = process.env.JELLYFIN_API_KEY;
  const baseUrl = process.env.JELLYFIN_BASE_URL;
  if (!apiKey || !baseUrl) {
    logger.warn("[SEERR WEBHOOK] Library channels are configured but JELLYFIN_API_KEY or JELLYFIN_BASE_URL is missing — cannot resolve library-based channel, using default");
    return defaultChannelId;
  }

  let libraries;
  try {
    const now = Date.now();
    if (libraryResolutionCache.data && now - libraryResolutionCache.timestamp < LIBRARY_CACHE_TTL_MS) {
      libraries = libraryResolutionCache.data;
    } else if (libraryResolutionCache.errorTimestamp && now - libraryResolutionCache.errorTimestamp < LIBRARY_CACHE_ERROR_COOLDOWN_MS) {
      logger.info(`[SEERR WEBHOOK] Skipping library fetch — in error cooldown, using default channel`);
      return defaultChannelId;
    } else {
      libraries = await fetchLibraries(apiKey, baseUrl);
      libraryResolutionCache.data = libraries;
      libraryResolutionCache.timestamp = now;
      libraryResolutionCache.errorTimestamp = null;
    }
  } catch (e) {
    libraryResolutionCache.errorTimestamp = Date.now();
    logger.warn(`[SEERR WEBHOOK] Could not fetch Jellyfin libraries, using default: ${e?.message || e}`);
    return defaultChannelId;
  }

  if (!Array.isArray(libraries)) {
    logger.error(`[SEERR WEBHOOK] fetchLibraries returned non-array (${typeof libraries}), falling back to default channel`);
    return defaultChannelId;
  }

  const libraryMap = new Map();
  for (const lib of libraries) {
    libraryMap.set(lib.CollectionId, lib);
    if (lib.ItemId !== lib.CollectionId) libraryMap.set(lib.ItemId, lib);
  }

  // Look up the item in Jellyfin by TMDB ID, then find its library via ancestors
  if (tmdbId) {
    const jellyfinItemId = await findItemByTmdbId(tmdbId, mediaType, apiKey, baseUrl);
    if (jellyfinItemId) {
      const itemType = mediaType === "movie" ? "Movie" : "Series";
      const libraryItemId = await findLibraryByAncestors(jellyfinItemId, apiKey, baseUrl, libraryMap, itemType);
      if (!libraryItemId) {
        logger.warn(`[SEERR WEBHOOK] Could not determine library for Jellyfin item ${jellyfinItemId} (TMDB ID ${tmdbId}), falling back to default channel`);
      } else {
        const channelId = libraryChannels[libraryItemId];
        if (channelId) {
          logger.info(`[SEERR WEBHOOK] Resolved channel via item lookup: Jellyfin item ${jellyfinItemId} → library ${libraryItemId} → channel ${channelId}`);
          return channelId;
        }
        logger.warn(`[SEERR WEBHOOK] Library ${libraryItemId} resolved for TMDB ID ${tmdbId} but has no channel mapping — falling back to default channel`);
      }
    } else {
      logger.info(`[SEERR WEBHOOK] Item with TMDB ID ${tmdbId} not yet found in Jellyfin, falling back to default channel`);
    }
  }

  logger.info(`[SEERR WEBHOOK] Falling back to default channel (${defaultChannelId})`);
  return defaultChannelId;
}

export async function handleSeerrWebhook(data, client, pendingRequests, onPendingRequestsChanged) {
  const { notification_type, subject, message, image, media } = data;

  if (notification_type !== "MEDIA_AVAILABLE") {
    logger.debug(`[SEERR WEBHOOK] Ignoring notification_type: ${notification_type}`);
    return;
  }

  const mediaType = media?.media_type; // "movie" or "tv"
  const tmdbId = media?.tmdbId ? String(media.tmdbId) : null;

  logger.info(`[SEERR WEBHOOK] MEDIA_AVAILABLE: ${subject} (tmdbId=${tmdbId}, type=${mediaType})`);

  // Check pending DM requests
  const notifyEnabled = process.env.NOTIFY_ON_AVAILABLE === "true";
  let usersToNotify = [];

  if (notifyEnabled && tmdbId && pendingRequests) {
    const key = `${tmdbId}-${mediaType}`;
    if (pendingRequests.has(key)) {
      usersToNotify = Array.from(pendingRequests.get(key));
      pendingRequests.delete(key);
      if (onPendingRequestsChanged) onPendingRequestsChanged();
      logger.info(`[SEERR WEBHOOK] Found ${usersToNotify.length} users to notify for ${key}`);
    }
  }

  // Fetch TMDB details for backdrop, genres, runtime, external IDs
  let details = null;
  if (tmdbId && process.env.TMDB_API_KEY) {
    try {
      details = await tmdbGetDetails(tmdbId, mediaType, process.env.TMDB_API_KEY);
    } catch (err) {
      logger.warn(`[SEERR WEBHOOK] Could not fetch TMDB details for ${tmdbId}: ${err?.message || err}`);
    }
  }

  const imdbId = details?.external_ids?.imdb_id || null;
  const omdb = imdbId ? await fetchOMDbData(imdbId) : null;

  // Title and year from TMDB (more reliable than Jellyseerr subject)
  const rawTitle = details
    ? (mediaType === "movie" ? details.title : details.name) || subject
    : subject;
  const title = rawTitle?.slice(0, 250) ?? subject?.slice(0, 250) ?? "";
  const year = details
    ? (mediaType === "movie"
        ? details.release_date?.slice(0, 4)
        : details.first_air_date?.slice(0, 4))
    : null;

  // Runtime
  let runtime = "Unknown";
  if (omdb?.Runtime && omdb.Runtime !== "N/A") {
    const match = String(omdb.Runtime).match(/(\d+)/);
    if (match) runtime = minutesToHhMm(parseInt(match[1], 10));
  } else if (mediaType === "movie" && details?.runtime > 0) {
    runtime = minutesToHhMm(details.runtime);
  } else if (mediaType === "tv" && details?.episode_run_time?.length > 0) {
    runtime = minutesToHhMm(details.episode_run_time[0]);
  }

  const rating = omdb?.imdbRating ? `${omdb.imdbRating}/10` : "N/A";

  const genres = details?.genres?.map((g) => g.name).join(", ")
    || omdb?.Genre
    || "Unknown";

  const overview = (message?.trim() || details?.overview || omdb?.Plot || "No description available.").slice(0, 1024);

  let headerLine = "Summary";
  if (omdb) {
    if (mediaType === "movie" && omdb.Director && omdb.Director !== "N/A") {
      headerLine = `Directed by ${omdb.Director}`;
    } else if (omdb.Writer && omdb.Writer !== "N/A") {
      const creator = omdb.Writer.split(",")[0].trim();
      headerLine = `Created by ${creator}`;
    }
  }

  // Embed customization from env
  const showBackdrop = process.env.EMBED_SHOW_BACKDROP !== "false";
  const showOverview = process.env.EMBED_SHOW_OVERVIEW !== "false";
  const showGenre = process.env.EMBED_SHOW_GENRE !== "false";
  const showRuntime = process.env.EMBED_SHOW_RUNTIME !== "false";
  const showRating = process.env.EMBED_SHOW_RATING !== "false";
  const showButtonLetterboxd = process.env.EMBED_SHOW_BUTTON_LETTERBOXD !== "false";
  const showButtonImdb = process.env.EMBED_SHOW_BUTTON_IMDB !== "false";
  const showButtonWatch = process.env.EMBED_SHOW_BUTTON_WATCH !== "false";

  const embedColor = mediaType === "movie"
    ? (process.env.EMBED_COLOR_MOVIE || "#cba6f7")
    : (process.env.EMBED_COLOR_SERIES || "#cba6f7");

  const authorName = mediaType === "movie" ? "🎬 New movie added!" : "📺 New TV show added!";
  const embedTitle = year ? `${title} (${year})` : title;

  const embed = new EmbedBuilder()
    .setAuthor({ name: authorName })
    .setTitle(embedTitle)
    .setColor(embedColor);

  // Poster from TMDB or Jellyseerr payload
  const posterPath = details?.poster_path;
  const posterUrl = posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : (image || null);
  if (posterUrl && isValidUrl(posterUrl)) {
    embed.setThumbnail(posterUrl);
  }

  // Fields
  const fields = [];
  if (showOverview) fields.push({ name: headerLine, value: overview });
  if (showGenre) fields.push({ name: "Genre", value: genres, inline: true });
  if (showRuntime) fields.push({ name: "Runtime", value: runtime, inline: true });
  if (showRating) fields.push({ name: "Rating", value: rating, inline: true });
  if (fields.length > 0) embed.addFields(...fields);

  // Backdrop
  const backdropPath = details ? findBestBackdrop(details) : null;
  if (showBackdrop && backdropPath) {
    const backdropUrl = `https://image.tmdb.org/t/p/w1280${backdropPath}`;
    if (isValidUrl(backdropUrl)) embed.setImage(backdropUrl);
  }

  // Buttons
  const buttonComponents = [];

  if (imdbId) {
    if (showButtonLetterboxd && mediaType === "movie") {
      const url = `https://letterboxd.com/imdb/${imdbId}`;
      if (isValidUrl(url)) {
        buttonComponents.push(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Letterboxd").setURL(url)
        );
      }
    }
    if (showButtonImdb) {
      const url = `https://www.imdb.com/title/${imdbId}/`;
      if (isValidUrl(url)) {
        buttonComponents.push(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("IMDb").setURL(url)
        );
      }
    }
  }

  if (showButtonWatch) {
    const watchUrl = buildJellyfinSearchUrl(title);
    if (watchUrl && isValidUrl(watchUrl)) {
      buttonComponents.push(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("▶ Watch Now!").setURL(watchUrl)
      );
    }
  }

  const buttons = buttonComponents.length > 0
    ? new ActionRowBuilder().addComponents(buttonComponents)
    : null;

  // Channel — prefer library-mapped channel, fall back to JELLYFIN_CHANNEL_ID
  const channelId = await resolveChannel(tmdbId, mediaType);
  if (!channelId) {
    logger.error("[SEERR WEBHOOK] ❌ No Discord channel configured — set JELLYFIN_CHANNEL_ID or configure library channels");
    return;
  }

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    logger.error(`[SEERR WEBHOOK] ❌ Failed to fetch Discord channel ${channelId}: ${err.message}`);
    return;
  }

  const messageOptions = { embeds: [embed] };
  if (buttons) messageOptions.components = [buttons];

  try {
    await channel.send(messageOptions);
    logger.info(`[SEERR WEBHOOK] Sent notification for: ${embedTitle}`);
  } catch (err) {
    logger.error(`[SEERR WEBHOOK] Failed to send Discord message: ${err.message}`);
    return;
  }

  // DMs
  if (usersToNotify.length > 0) {
    const watchUrl = buildJellyfinSearchUrl(title);

    for (const userId of usersToNotify) {
      try {
        const user = await client.users.fetch(userId);
        const dmEmbed = new EmbedBuilder()
          .setAuthor({ name: "✅ Your request is now available!" })
          .setTitle(embedTitle)
          .setColor(process.env.EMBED_COLOR_SUCCESS || "#a6e3a1")
          .setDescription(`${title} is now available on Jellyfin!`)
          .addFields(
            { name: "Genre", value: genres, inline: true },
            { name: "Runtime", value: runtime, inline: true },
            { name: "Rating", value: rating, inline: true }
          );

        if (backdropPath) {
          const backdropUrl = `https://image.tmdb.org/t/p/w1280${backdropPath}`;
          if (isValidUrl(backdropUrl)) dmEmbed.setImage(backdropUrl);
        }

        const dmMessageOptions = { embeds: [dmEmbed] };
        if (watchUrl && isValidUrl(watchUrl)) {
          dmMessageOptions.components = [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("▶ Watch Now!").setURL(watchUrl)
            ),
          ];
        }

        await user.send(dmMessageOptions);
        logger.info(`[SEERR WEBHOOK] Sent DM to user ${userId} for ${embedTitle}`);
      } catch (err) {
        logger.error(`[SEERR WEBHOOK] Failed to send DM to user ${userId}: ${err?.message || err}`);
      }
    }
  }
}
