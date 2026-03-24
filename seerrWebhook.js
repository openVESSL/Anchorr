import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { tmdbGetDetails, findBestBackdrop } from "./api/tmdb.js";
import { fetchOMDbData } from "./api/omdb.js";
import { fetchLibraries } from "./api/jellyfin.js";
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
const libraryResolutionCache = { data: null, timestamp: null };
const LIBRARY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Resolve the Discord channel ID for a given media type.
 * Prefers a library-mapped channel (JELLYFIN_NOTIFICATION_LIBRARIES) matched by
 * CollectionType ("movies" / "tvshows"), falling back to JELLYFIN_CHANNEL_ID.
 * Results are cached for 10 minutes to avoid repeated Jellyfin API calls.
 */
async function resolveChannelForMediaType(mediaType) {
  const defaultChannelId = process.env.JELLYFIN_CHANNEL_ID || null;
  const libraryChannels = getLibraryChannels();

  if (!Object.keys(libraryChannels).length) {
    logger.info(`[SEERR WEBHOOK] No library channel mapping configured, using default channel`);
    return defaultChannelId;
  }

  logger.info(`[SEERR WEBHOOK] Library channels configured: ${JSON.stringify(libraryChannels)}`);
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
    } else {
      libraries = await fetchLibraries(apiKey, baseUrl);
      libraryResolutionCache.data = libraries;
      libraryResolutionCache.timestamp = now;
    }
  } catch (e) {
    logger.warn(`[SEERR WEBHOOK] Could not fetch Jellyfin libraries for channel resolution, using default: ${e.message}`);
    return defaultChannelId;
  }

  if (!Array.isArray(libraries)) {
    logger.error(`[SEERR WEBHOOK] fetchLibraries returned non-array (${typeof libraries}), falling back to default channel`);
    return defaultChannelId;
  }

  const targetType = mediaType === "movie" ? "movies" : "tvshows";
  if (mediaType !== "movie" && mediaType !== "tv") {
    logger.warn(`[SEERR WEBHOOK] Unexpected mediaType "${mediaType}", defaulting targetType to "tvshows"`);
  }
  logger.info(`[SEERR WEBHOOK] Looking for library with CollectionType="${targetType}" among: ${libraries.map(l => `${l.Name}(${l.CollectionType},itemId=${l.ItemId},collectionId=${l.CollectionId})`).join(", ")}`);
  for (const lib of libraries) {
    if (lib.CollectionType === targetType) {
      const channelId = libraryChannels[lib.ItemId] || libraryChannels[lib.CollectionId];
      if (channelId) {
        logger.info(`[SEERR WEBHOOK] Resolved channel via library mapping: ${lib.Name} → ${channelId}`);
        return channelId;
      }
    }
  }

  logger.info(`[SEERR WEBHOOK] No library channel match found for type "${targetType}", falling back to default channel (${defaultChannelId})`);
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
  const channelId = await resolveChannelForMediaType(mediaType);
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
