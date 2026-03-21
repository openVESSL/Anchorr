import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import axios from "axios";
import debounce from "lodash.debounce";
import { minutesToHhMm } from "./utils/time.js";
import logger from "./utils/logger.js";
import { fetchOMDbData } from "./api/omdb.js";
import { findBestBackdrop } from "./api/tmdb.js";
import { isValidUrl } from "./utils/url.js";

const debouncedSenders = new Map();
const sentNotifications = new Map();
const episodeMessages = new Map(); // Track Discord messages for editing: SeriesId -> { messageId, channelId }
const creatingDebouncers = new Set(); // Prevent race condition: track SeriesIds currently creating debouncers

// API response cache to reduce external API calls
const apiCache = new Map(); // tmdbId -> { data, timestamp }
const API_CACHE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours

// Library cache to avoid repeated API calls at webhook time
const libraryCache = {
  data: null,
  timestamp: null,
  isValid: function () {
    return (
      this.data &&
      this.timestamp &&
      Date.now() - this.timestamp < 15 * 60 * 1000
    ); // 15 min cache
  },
  set: function (libraries) {
    this.data = libraries;
    this.timestamp = Date.now();
  },
  get: function () {
    return this.isValid() ? this.data : null;
  },
};

// Cleanup configuration
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_DEBOUNCE_MS = 60000; // 60 seconds
const NEW_SERIES_DEBOUNCE_MS = 120000; // 2 minutes - longer debounce for episodes/seasons of new series
const SEASON_NOTIFICATION_DELAY_MS = 3 * 60 * 1000; // 3 minutes - allow season notifications after this delay

// Periodic cleanup for old debouncer entries and API cache (prevent memory leaks on long-running servers)
setInterval(() => {
  const now = Date.now();
  const sevenDaysAgo = now - CLEANUP_THRESHOLD_MS;

  let cleanedDebouncers = 0;
  for (const [seriesId, data] of debouncedSenders.entries()) {
    // Check if debouncer has a timestamp and is older than 7 days
    if (data.timestamp && data.timestamp < sevenDaysAgo) {
      debouncedSenders.delete(seriesId);
      creatingDebouncers.delete(seriesId); // Also cleanup from creatingDebouncers
      cleanedDebouncers++;
    }
  }

  // Clean up old API cache entries
  let cleanedCache = 0;
  for (const [key, cached] of apiCache.entries()) {
    if (now - cached.timestamp > API_CACHE_DURATION_MS) {
      apiCache.delete(key);
      cleanedCache++;
    }
  }

  if (cleanedDebouncers > 0 || cleanedCache > 0) {
    logger.debug(
      `Periodic cleanup: Removed ${cleanedDebouncers} old debouncer(s), ${cleanedCache} expired cache entries`
    );
  }
}, CLEANUP_INTERVAL_MS);

function getItemLevel(itemType) {
  switch (itemType) {
    case "Series":
      return 3;
    case "Season":
      return 2;
    case "Episode":
      return 1;
    default:
      return 0;
  }
}

// Build a Jellyfin URL that preserves a potential subpath (e.g., /jellyfin)
// and appends the provided path and optional hash fragment safely.
// Always uses the configured JELLYFIN_BASE_URL — the webhook-provided ServerUrl
// is not trusted as it could be poisoned via Jellyfin metadata.
function buildJellyfinUrl(_baseUrl, appendPath, hash) {
  const effectiveBaseUrl = process.env.JELLYFIN_BASE_URL;

  try {
    const u = new URL(effectiveBaseUrl);
    let p = u.pathname || "/";
    if (!p.endsWith("/")) p += "/";
    const pathClean = String(appendPath || "").replace(/^\/+/, "");
    u.pathname = p + pathClean;
    if (hash != null) {
      const h = String(hash);
      u.hash = h.startsWith("#") ? h.slice(1) : h;
    }
    return u.toString();
  } catch (_e) {
    const baseNoSlash = String(effectiveBaseUrl || "").replace(/\/+$/, "");
    const pathNoLead = String(appendPath || "").replace(/^\/+/, "");
    const h = hash
      ? String(hash).startsWith("#")
        ? String(hash)
        : `#${hash}`
      : "";
    return `${baseNoSlash}/${pathNoLead}${h}`;
  }
}

/**
 * Clean title by removing Jellyfin/TMDB metadata like [tvdbid-123], [imdbid-123], (?), etc.
 * @param {string} title - Original title from Jellyfin
 * @returns {string} Cleaned title
 */
function cleanTitle(title) {
  if (!title) return title;

  // Remove metadata patterns like [tvdbid-123], [imdbid-123], (?)
  return title
    .replace(/\[tvdbid-\d+\]/gi, "")
    .replace(/\[imdbid-\d+\]/gi, "")
    .replace(/\(\?\)$/, "")
    .trim();
}

async function processAndSendNotification(
  data,
  client,
  pendingRequests,
  targetChannelId = null,
  episodeCount = 0,
  episodeDetails = null,
  seasonCount = 0,
  seasonDetails = null,
  isTestNotif = false,
  onPendingRequestsChanged = null
) {
  const {
    ItemType,
    ItemId,
    SeasonId,
    SeriesId,
    Name,
    SeriesName,
    IndexNumber,
    Year,
    Overview,
    RunTime,
    Genres,
    Provider_imdb: imdbIdFromWebhook, // Renamed to avoid conflict
    ServerUrl,
    ServerId,
    SeasonNumber,
    EpisodeNumber,
    Video_0_Height,
    Video_0_Codec,
    Video_0_VideoRange,
    Audio_0_Codec,
    Audio_0_Channels,
    Audio_0_Language,
  } = data;

  // We need to fetch details from TMDB to get the backdrop
  const tmdbId = data.Provider_tmdb;

  const testPrefix = isTestNotif ? "[TEST NOTIFICATION] " : "";

  logger.info(
    `${testPrefix}Webhook received: ItemType=${ItemType}, Name=${Name}, tmdbId=${tmdbId}, Provider_imdb=${data.Provider_imdb}`
  );

  // Get embed customization settings from environment
  const showBackdrop = process.env.EMBED_SHOW_BACKDROP !== "false";
  const showOverview = process.env.EMBED_SHOW_OVERVIEW !== "false";
  const showGenre = process.env.EMBED_SHOW_GENRE !== "false";
  const showRuntime = process.env.EMBED_SHOW_RUNTIME !== "false";
  const showRating = process.env.EMBED_SHOW_RATING !== "false";
  const showButtonLetterboxd = process.env.EMBED_SHOW_BUTTON_LETTERBOXD !== "false";
  const showButtonImdb = process.env.EMBED_SHOW_BUTTON_IMDB !== "false";
  const showButtonWatch = process.env.EMBED_SHOW_BUTTON_WATCH !== "false";

  // Check if anyone requested this content
  const notifyEnabled = process.env.NOTIFY_ON_AVAILABLE === "true";
  let usersToNotify = [];

  if (notifyEnabled && tmdbId && pendingRequests) {
    const movieKey = `${tmdbId}-movie`;
    const tvKey = `${tmdbId}-tv`;

    logger.debug(
      `Checking pending requests. notifyEnabled=${notifyEnabled}, tmdbId=${tmdbId}`
    );
    logger.debug(`Pending requests keys:`, Array.from(pendingRequests.keys()));

    if (ItemType === "Movie" && pendingRequests.has(movieKey)) {
      usersToNotify = Array.from(pendingRequests.get(movieKey));
      pendingRequests.delete(movieKey);
      if (onPendingRequestsChanged) onPendingRequestsChanged();
      logger.info(
        `Found ${usersToNotify.length} users to notify for movie ${tmdbId}`
      );
    } else if (
      (ItemType === "Series" ||
        ItemType === "Season" ||
        ItemType === "Episode") &&
      pendingRequests.has(tvKey)
    ) {
      usersToNotify = Array.from(pendingRequests.get(tvKey));
      pendingRequests.delete(tvKey);
      if (onPendingRequestsChanged) onPendingRequestsChanged();
      logger.info(
        `Found ${usersToNotify.length} users to notify for TV show ${tmdbId}`
      );
    } else {
      logger.debug(`No matching pending requests found for ${tmdbId}`);
    }
  } else {
    logger.debug(
      `Notification check skipped: notifyEnabled=${notifyEnabled}, tmdbId=${tmdbId}, hasPendingRequests=${!!pendingRequests}`
    );
  }
  let details = null;
  if (tmdbId) {
    // Check cache first
    const cacheKey = `tmdb-${ItemType}-${tmdbId}`;
    const cached = apiCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.timestamp < API_CACHE_DURATION_MS) {
      details = cached.data;
      logger.debug(`Using cached TMDB data for ${tmdbId}`);
    } else {
      try {
        const tmdbIdNum = parseInt(tmdbId, 10);
        const res = await axios.get(
          `https://api.themoviedb.org/3/${
            ItemType === "Movie" ? "movie" : "tv"
          }/${tmdbIdNum}`,
          {
            params: {
              api_key: process.env.TMDB_API_KEY,
              append_to_response: "images,external_ids",
            },
          }
        );
        details = res.data;
        // Cache the response
        apiCache.set(cacheKey, { data: details, timestamp: now });
        logger.debug(`Cached TMDB data for ${tmdbId}`);
      } catch (e) {
        logger.warn(`Could not fetch TMDB details for ${tmdbId}`);
      }
    }
  }



  // Prioritize IMDb ID from TMDB, fallback to webhook
  const imdbId = details?.external_ids?.imdb_id || imdbIdFromWebhook;

  const omdb = imdbId ? await fetchOMDbData(imdbId) : null;

  let runtime = "Unknown";
  // Prioritize webhook runtime data for episodes
  if (ItemType === "Episode" && RunTime) {
    runtime = RunTime; // Webhook already provides formatted runtime like "00:25:02"
  } else if (omdb?.Runtime && omdb.Runtime !== "N/A") {
    const match = String(omdb.Runtime).match(/(\d+)/);
    if (match) runtime = minutesToHhMm(parseInt(match[1], 10));
  } else if (ItemType === "Movie" && details?.runtime > 0) {
    runtime = minutesToHhMm(details.runtime);
  } else if (
    (ItemType === "Series" || ItemType === "Season") &&
    details &&
    Array.isArray(details.episode_run_time) &&
    details.episode_run_time.length > 0
  ) {
    runtime = minutesToHhMm(details.episode_run_time[0]);
  }

  const rating = omdb?.imdbRating ? `${omdb.imdbRating}/10` : "N/A";
  const genreList = Array.isArray(Genres)
    ? Genres.join(", ")
    : Genres || omdb?.Genre || "Unknown";
  let overviewText =
    Overview?.trim() || omdb?.Plot || "No description available.";

  let headerLine = "Summary";
  if (omdb) {
    if (ItemType === "Movie" && omdb.Director && omdb.Director !== "N/A") {
      headerLine = `Directed by ${omdb.Director}`;
    } else if (omdb.Writer && omdb.Writer !== "N/A") {
      const creator = omdb.Writer.split(",")[0].trim();
      headerLine = `Created by ${creator}`;
    }
  }

  // Build quality info from webhook data
  let qualityInfo = "";
  if (Video_0_Height && Video_0_Codec) {
    const videoQuality =
      Video_0_Height >= 2160
        ? "4K"
        : Video_0_Height >= 1440
        ? "1440p"
        : Video_0_Height >= 1080
        ? "1080p"
        : Video_0_Height >= 720
        ? "720p"
        : `${Video_0_Height}p`;

    const videoCodec = Video_0_Codec.toUpperCase();
    const hdr =
      Video_0_VideoRange && Video_0_VideoRange !== "SDR"
        ? ` ${Video_0_VideoRange}`
        : "";

    qualityInfo = `${videoQuality} ${videoCodec}${hdr}`;

    if (Audio_0_Codec && Audio_0_Channels) {
      const audioCodec = Audio_0_Codec.toUpperCase();
      const channels =
        Audio_0_Channels === 6
          ? "5.1"
          : Audio_0_Channels === 8
          ? "7.1"
          : Audio_0_Channels === 2
          ? "Stereo"
          : `${Audio_0_Channels}ch`;
      qualityInfo += ` • ${audioCodec} ${channels}`;
    }
  }

  let embedTitle = "";
  let authorName = "";

  // Clean names from Jellyfin metadata
  const cleanedName = cleanTitle(Name);
  // For Series items, SeriesName might be undefined, so fallback to Name
  const cleanedSeriesName = cleanTitle(SeriesName || Name);

  switch (ItemType) {
    case "Movie":
      authorName = "🎬 New movie added!";
      embedTitle = `${cleanedName || "Unknown Title"} (${Year || "?"})`;
      break;
    case "Series":
      authorName = "📺 New TV show added!";
      embedTitle = `${cleanedSeriesName || "Unknown Series"} (${Year || "?"})`;
      break;
    case "Season":
      if (seasonCount > 1 && seasonDetails) {
        authorName = `📺 ${seasonCount} new seasons added!`;
        embedTitle = `${cleanedSeriesName || "Unknown Series"} (${Year || "?"})`;
      } else {
        authorName = "📺 New season added!";
        embedTitle = `${cleanedSeriesName || "Unknown Series"} - Season ${SeasonNumber || IndexNumber || "?"}`;
      }
      break;
    case "Episode":
      if (episodeCount > 1 && episodeDetails) {
        authorName = `📺 ${episodeCount} new episodes added!`;
        embedTitle = `${cleanedSeriesName || "Unknown Series"} (${Year || "?"})`;
      } else {
        authorName = "📺 New episode added!";
        const season = String(SeasonNumber || 1).padStart(2, "0");
        const episode = String(EpisodeNumber || IndexNumber || 1).padStart(
          2,
          "0"
        );
        embedTitle = `${
          cleanedSeriesName || "Unknown Series"
        } - S${season}E${episode}`;
      }
      break;
    default:
      authorName = "✨ New item added";
      embedTitle = cleanedName || "Unknown Title";
  }

  // Smart color coding based on content type and count
  // Use custom colors from config or fallback to defaults
  let embedColor = process.env.EMBED_COLOR_EPISODE_SINGLE || "#89b4fa"; // Default blue for episodes
  if (ItemType === "Movie") {
    embedColor = process.env.EMBED_COLOR_MOVIE || "#cba6f7"; // Purple/Mauve for movies
  } else if (ItemType === "Series") {
    embedColor = process.env.EMBED_COLOR_SERIES || "#cba6f7"; // Purple/Mauve for new series
  } else if (ItemType === "Season") {
    embedColor = process.env.EMBED_COLOR_SEASON || "#89b4fa"; // Blue for seasons
  } else if (ItemType === "Episode") {
    if (episodeCount > 5) {
      embedColor = process.env.EMBED_COLOR_EPISODE_MANY || "#89b4fa"; // Blue for many episodes
    } else if (episodeCount > 1) {
      embedColor = process.env.EMBED_COLOR_EPISODE_FEW || "#89b4fa"; // Blue for few episodes
    } else {
      embedColor = process.env.EMBED_COLOR_EPISODE_SINGLE || "#89b4fa"; // Blue for single episode
    }
  }

  const embed = new EmbedBuilder()
    .setAuthor({ name: authorName })
    .setTitle(embedTitle);

  // Only set URL if ServerUrl is valid
  const jellyfinUrl = buildJellyfinUrl(
    ServerUrl,
    "web/index.html",
    `!/details?id=${ItemId}&serverId=${ServerId}`
  );
  if (isValidUrl(jellyfinUrl)) {
    embed.setURL(jellyfinUrl);
  }

  embed.setColor(embedColor);

  // Add fields based on ItemType
  if (ItemType === "Episode" && episodeCount <= 1) {
    // Single episode: show overview
    if (showOverview && overviewText) {
      embed.addFields({ name: "Episode Summary", value: overviewText });
    }
  } else if (ItemType === "Season") {
    // Seasons: no fields
  } else {
    // Movies and Series: Summary, Genre, Runtime, Rating
    const fields = [];
    
    if (showOverview) {
      fields.push({ name: headerLine, value: overviewText || "No description available." });
    }
    
    if (showGenre) {
      fields.push({ name: "Genre", value: genreList || "Unknown", inline: true });
    }
    
    if (showRuntime) {
      fields.push({ name: "Runtime", value: runtime || "Unknown", inline: true });
    }
    
    if (showRating) {
      fields.push({ name: "Rating", value: rating || "N/A", inline: true });
    }
    
    if (fields.length > 0) {
      embed.addFields(...fields);
    }
  }

  // Add season list for multiple seasons
  if (ItemType === "Season" && seasonCount > 1 && seasonDetails && seasonDetails.seasons.length <= 10) {
    const seasonList = seasonDetails.seasons
      .sort(
        (a, b) =>
          (a.SeasonNumber || a.IndexNumber || 0) -
          (b.SeasonNumber || b.IndexNumber || 0)
      )
      .map((s) => {
        const seasonNum = s.SeasonNumber || s.IndexNumber || "?";
        return `**Season ${seasonNum}**: ${s.Name || `Season ${seasonNum}`}`;
      })
      .join("\n");

    embed.addFields({
      name: "Seasons Added",
      value: seasonList,
      inline: false,
    });
  } else if (ItemType === "Season" && seasonCount > 10) {
    embed.addFields({
      name: "Seasons Added",
      value: `${seasonCount} seasons (too many to list individually)`,
      inline: false,
    });
  }

  // Add episode list for multiple episodes
  if (ItemType === "Episode") {
    if (
      episodeCount > 1 &&
      episodeDetails &&
      episodeDetails.episodes.length <= 10
    ) {
      const episodeList = episodeDetails.episodes
        .sort((a, b) => (a.EpisodeNumber || 0) - (b.EpisodeNumber || 0))
        .map((ep) => {
          const seasonNum = String(ep.SeasonNumber || 1).padStart(2, "0");
          const epNum = String(ep.EpisodeNumber || 0).padStart(2, "0");
          return `**S${seasonNum}E${epNum}**: ${ep.Name || "Unknown Episode"}`;
        })
        .join("\n");

      embed.addFields({
        name: "Episodes Added",
        value: episodeList,
        inline: false,
      });
    } else if (episodeCount > 10) {
      embed.addFields({
        name: "Episodes Added",
        value: `${episodeCount} episodes (too many to list individually)`,
        inline: false,
      });
    }
  }

  const backdropPath = details ? findBestBackdrop(details) : null;
  const backdrop = backdropPath
    ? `https://image.tmdb.org/t/p/w1280${backdropPath}`
    : buildJellyfinUrl(ServerUrl, `Items/${ItemId}/Images/Backdrop`);
  
  if (showBackdrop && isValidUrl(backdrop)) {
    embed.setImage(backdrop);
  }

  // Series poster thumbnail for single episode notifications
  if (ItemType === "Episode" && episodeCount <= 1 && details?.poster_path) {
    const posterUrl = `https://image.tmdb.org/t/p/w500${details.poster_path}`;
    if (isValidUrl(posterUrl)) embed.setThumbnail(posterUrl);
  }

  const buttonComponents = [];

  if (imdbId) {
    if (showButtonLetterboxd) {
      const letterboxdUrl = `https://letterboxd.com/imdb/${imdbId}`;
      if (isValidUrl(letterboxdUrl)) {
        buttonComponents.push(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("Letterboxd")
            .setURL(letterboxdUrl)
        );
      }
    }
    
    if (showButtonImdb) {
      const imdbUrl = `https://www.imdb.com/title/${imdbId}/`;
      if (isValidUrl(imdbUrl)) {
        buttonComponents.push(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("IMDb")
            .setURL(imdbUrl)
        );
      }
    }
  }

  if (showButtonWatch) {
    const watchUrl = buildJellyfinUrl(
      ServerUrl,
      "web/index.html",
      `!/details?id=${ItemId}&serverId=${ServerId}`
    );
    if (isValidUrl(watchUrl)) {
      buttonComponents.push(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("▶ Watch Now!")
          .setURL(watchUrl)
      );
    } else {
      logger.warn(`Invalid watch URL generated: ${watchUrl}. Skipping watch button.`);
    }
  }

  const buttons = buttonComponents.length > 0 ? new ActionRowBuilder().addComponents(buttonComponents) : null;

  // Select channel with priority hierarchy:
  // 1. Episode/Season specific channel (if enabled and configured)
  // 2. Library-specific channel (targetChannelId)
  // 3. Default Jellyfin channel
  let channelId;
  
  if (ItemType === "Episode") {
    const episodeNotifyEnabled = process.env.JELLYFIN_NOTIFY_EPISODES === "true";
    const episodeChannelId = process.env.JELLYFIN_EPISODE_CHANNEL_ID;
    
    if (episodeNotifyEnabled && episodeChannelId) {
      // Episode notifications enabled with specific channel - use it
      channelId = episodeChannelId;
      logger.debug(`Using episode-specific channel: ${channelId}`);
    } else if (episodeNotifyEnabled && !episodeChannelId) {
      // Episode notifications enabled but no specific channel - fallback to library or default
      channelId = targetChannelId || process.env.JELLYFIN_CHANNEL_ID;
      logger.debug(`Episode notifications enabled, using fallback channel: ${channelId}`);
    } else if (!episodeNotifyEnabled) {
      // Episode notifications disabled - skip
      logger.info(`Episode notifications disabled. Skipping notification for: ${data.Name}`);
      return;
    }
  } else if (ItemType === "Season") {
    const seasonNotifyEnabled = process.env.JELLYFIN_NOTIFY_SEASONS === "true";
    const seasonChannelId = process.env.JELLYFIN_SEASON_CHANNEL_ID;
    
    if (seasonNotifyEnabled && seasonChannelId) {
      // Season notifications enabled with specific channel - use it
      channelId = seasonChannelId;
      logger.debug(`Using season-specific channel: ${channelId}`);
    } else if (seasonNotifyEnabled && !seasonChannelId) {
      // Season notifications enabled but no specific channel - fallback to library or default
      channelId = targetChannelId || process.env.JELLYFIN_CHANNEL_ID;
      logger.debug(`Season notifications enabled, using fallback channel: ${channelId}`);
    } else if (!seasonNotifyEnabled) {
      // Season notifications disabled - skip
      logger.info(`Season notifications disabled. Skipping notification for: ${data.Name}`);
      return;
    }
  } else {
    // For movies, series, etc. - use library channel or default
    channelId = targetChannelId || process.env.JELLYFIN_CHANNEL_ID;
  }

  if (!channelId) {
    logger.error(`❌ No Discord channel configured for ${ItemType} "${data.Name}" — set JELLYFIN_CHANNEL_ID or configure a library channel in the dashboard`);
    return;
  }

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (error) {
    logger.error(`❌ Failed to fetch Discord channel ${channelId} for "${data.Name}" (${ItemType}): ${error.message}`);
    throw new Error(`Discord channel ${channelId} not accessible`);
  }

  // Check if this is a batched episode notification and we have an existing message to edit
  if (
    ItemType === "Episode" &&
    episodeCount > 1 &&
    episodeDetails &&
    SeriesId
  ) {
    const existingMessage = episodeMessages.get(SeriesId);

    if (existingMessage) {
      try {
        const channel = await client.channels.fetch(existingMessage.channelId);
        const message = await channel.messages.fetch(existingMessage.messageId);
        await message.edit({ embeds: [embed], components: [buttons] });
        logger.info(
          `Updated existing message for: ${embedTitle} (${episodeCount} episodes total)`
        );
        return; // Early return, don't send a new message
      } catch (err) {
        logger.warn(
          `Failed to edit existing message for ${SeriesId}, sending new one:`,
          err
        );
        // Continue to send new message
      }
    }
  }

  let sentMessage;
  try {
    const messageOptions = {
      embeds: [embed],
    };
    
    if (buttons) {
      messageOptions.components = [buttons];
    }
    
    sentMessage = await channel.send(messageOptions);
  } catch (error) {
    logger.error(`Failed to send Discord message:`, error);
    throw new Error(`Failed to send Discord notification: ${error.message}`);
  }

  // Store message reference for future edits (batched episodes only)
  if (
    ItemType === "Episode" &&
    episodeCount > 1 &&
    episodeDetails &&
    SeriesId
  ) {
    episodeMessages.set(SeriesId, {
      messageId: sentMessage.id,
      channelId: channel.id,
    });

    // Clean up message reference after some time (prevent memory leaks)
    setTimeout(() => {
      episodeMessages.delete(SeriesId);
      logger.debug(`Cleaned up message reference for SeriesId: ${SeriesId}`);
    }, 6 * 60 * 60 * 1000); // 6 hours
  }
  
  logger.info(`${testPrefix}Sent notification for: ${embedTitle}`);

  // Send DMs to users who requested this content
  if (usersToNotify.length > 0) {
    for (const userId of usersToNotify) {
      try {
        const user = await client.users.fetch(userId);
        const dmEmbed = new EmbedBuilder()
          .setAuthor({ name: "✅ Your request is now available!" })
          .setTitle(embedTitle);

        const dmJellyfinUrl = buildJellyfinUrl(
          ServerUrl,
          "web/index.html",
          `!/details?id=${ItemId}&serverId=${ServerId}`
        );
        if (isValidUrl(dmJellyfinUrl)) {
          dmEmbed.setURL(dmJellyfinUrl);
        }
        dmEmbed
          .setColor(process.env.EMBED_COLOR_SUCCESS || "#a6e3a1")
          .setDescription(
            `${
              Name || SeriesName || "Your requested content"
            } is now available on Jellyfin!`
          )
          .addFields(
            { name: "Genre", value: genreList, inline: true },
            { name: "Runtime", value: runtime, inline: true },
            { name: "Rating", value: rating, inline: true }
          );

        if (backdropPath) {
          const backdropUrl = `https://image.tmdb.org/t/p/w1280${backdropPath}`;
          if (isValidUrl(backdropUrl)) {
            dmEmbed.setImage(backdropUrl);
          }
        }

        const dmButtons = isValidUrl(dmJellyfinUrl) ? new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("▶ Watch Now!")
            .setURL(dmJellyfinUrl)
        ) : null;

        const messageOptions = { embeds: [dmEmbed] };
        if (dmButtons) {
          messageOptions.components = [dmButtons];
        }
        await user.send(messageOptions);
        logger.info(`Sent DM notification to user ${userId} for ${embedTitle}`);
      } catch (err) {
        logger.error(
          `Failed to send DM to user ${userId}:`,
          err?.message || err
        );
      }
    }
  }
}

export { processAndSendNotification, libraryCache };

export async function handleJellyfinWebhook(req, res, client, pendingRequests, onPendingRequestsChanged) {
  try {
    const data = req.body;
    if (!data || !data.ItemId) {
      if (res) return res.status(400).send("No valid data");
      return; // If no res object, just return
    }

    // Allow episodes and seasons with enhanced debouncing

    // Get library ID - try multiple sources from webhook data
    let libraryId = data.LibraryId || data.CollectionId || data.Library_Id;

    // Check if this is a test notification
    const isTestNotification = data.ItemId && (data.ItemId.startsWith("test-") || data.ItemId.startsWith("batch-"));

    // If no library ID in webhook, use advanced detection (traverse parent chain)
    // Skip library detection for test notifications
    if (!libraryId && data.ItemId && !isTestNotification) {
      try {
        const apiKey = process.env.JELLYFIN_API_KEY;
        const baseUrl = process.env.JELLYFIN_BASE_URL;

        if (!apiKey || !baseUrl) {
          logger.warn(
            "Cannot detect library: JELLYFIN_API_KEY or JELLYFIN_BASE_URL not configured"
          );
        } else {
          // Try to use cached libraries first (to avoid timeout issues at webhook time)
          let libraries = libraryCache.get();

          if (!libraries) {
            // Cache is invalid, fetch fresh libraries
            const { fetchLibraries } = await import(
              "./api/jellyfin.js"
            );
            libraries = await fetchLibraries(apiKey, baseUrl);
          }

          const libraryMap = new Map();
          for (const lib of libraries) {
            // Map both CollectionId and ItemId to the library object
            libraryMap.set(lib.CollectionId, lib);
            if (lib.ItemId !== lib.CollectionId) {
              libraryMap.set(lib.ItemId, lib);
            }
          }

          // First try: Check if item's Path directly matches a library location
          if (data.Path) {
            const normalizedItemPath = data.Path.replace(/\\/g, "/").toLowerCase();
            for (const lib of libraries) {
              if (lib.Locations && lib.Locations.length > 0) {
                for (const location of lib.Locations) {
                  const normalizedLocation = location.replace(/\\/g, "/").toLowerCase();
                  if (normalizedItemPath.startsWith(normalizedLocation)) {
                    // Verify type matches
                    const itemTypeLower = data.ItemType?.toLowerCase();
                    const libTypeLower = lib.CollectionType?.toLowerCase();
                    
                    let typeMatch = true;
                    if (itemTypeLower === "movie" && libTypeLower !== "movies") typeMatch = false;
                    if ((itemTypeLower === "series" || itemTypeLower === "season" || itemTypeLower === "episode") && libTypeLower !== "tvshows") typeMatch = false;
                    
                    if (typeMatch) {
                      libraryId = lib.ItemId;
                      logger.debug(`✅ Library detected via Path matching: ${libraryId} (${lib.Name})`);
                      break;
                    }
                  }
                }
              }
              if (libraryId) break;
            }
          }

          // Second try: Use ancestor-based detection
          if (!libraryId) {
            const { findLibraryByAncestors } = await import("./api/jellyfin.js");
            libraryId = await findLibraryByAncestors(
              data.ItemId,
              apiKey,
              baseUrl,
              libraryMap,
              data.ItemType
            );
            if (libraryId) {
              logger.debug(`✅ Library detected via Ancestors: ${libraryId}`);
            }
          }
        }
      } catch (err) {
        if (!isTestNotification) {
          logger.warn(`Advanced library detection failed:`, err?.message || err);
        }
      }
    }

    // Parse notification libraries from config (supports both array and object format)
    let notificationLibraries = {};
    let libraryChannelId = null;

    // Check if this is a test notification - if so, use default channel
    if (isTestNotification) {
      libraryChannelId = process.env.JELLYFIN_CHANNEL_ID;
      logger.info(`🧪 Test notification detected. Using default channel: ${libraryChannelId}`);
    } else {
      // Normal library checking logic
      try {
        const parsedLibraries = JSON.parse(
          process.env.JELLYFIN_NOTIFICATION_LIBRARIES || "{}"
        );

        // Handle both array (legacy) and object format
        if (Array.isArray(parsedLibraries)) {
          // Convert array to object with default channel
          parsedLibraries.forEach((libId) => {
            notificationLibraries[libId] = process.env.JELLYFIN_CHANNEL_ID || "";
          });
        } else {
          notificationLibraries = parsedLibraries;
        }
      } catch (e) {
        logger.error("Error parsing JELLYFIN_NOTIFICATION_LIBRARIES:", e);
        notificationLibraries = {};
      }

      logger.debug(
        `Configured libraries: ${JSON.stringify(notificationLibraries)}`
      );

      // Check if library is enabled and get specific channel
      const libraryKeys = Object.keys(notificationLibraries);
      if (
        libraryKeys.length > 0 &&
        libraryId &&
        libraryId in notificationLibraries
      ) {
        // Library found in configuration - use its specific channel or default if empty
        libraryChannelId =
          notificationLibraries[libraryId] || process.env.JELLYFIN_CHANNEL_ID;
        logger.info(
          `✅ Using channel: ${libraryChannelId} for configured library: ${libraryId}`
      );
    } else if (libraryKeys.length > 0 && libraryId) {
      // Library detected but not in configuration - disable notifications
      logger.info(
        `🚫 Library ${libraryId} not enabled in JELLYFIN_NOTIFICATION_LIBRARIES. Skipping notification.`
      );
      if (res) {
        return res
          .status(200)
          .send("OK: Notification skipped for disabled library.");
      }
      return;
    } else if (libraryKeys.length > 0 && !libraryId) {
      // Libraries are configured but we couldn't detect which library this item belongs to
      // Use default channel instead of skipping to ensure notification is sent
      libraryChannelId = process.env.JELLYFIN_CHANNEL_ID;
      if (!isTestNotification) {
        logger.warn(
          `⚠️ Could not detect library for item "${data.Name}". Using default channel: ${libraryChannelId}`
        );
      }
    } else {
      // No library filtering configured - use default channel
      libraryChannelId = process.env.JELLYFIN_CHANNEL_ID;
      logger.debug(
        `No library filtering configured. Using default channel: ${libraryChannelId}`
      );
      }
    }

    if (data.ItemType === "Movie") {
      const { ItemId } = data;
      const isTestMovie = ItemId && ItemId.startsWith("test-");

      // Check if we already sent a notification for this movie
      if (sentNotifications.has(ItemId)) {
        logger.debug(
          `Duplicate movie notification detected for: ${data.Name} (${ItemId}). Skipping.`
        );
        if (res) {
          return res
            .status(200)
            .send(`OK: Duplicate movie notification skipped for ${data.Name}.`);
        }
        return;
      }

      await processAndSendNotification(
        data,
        client,
        pendingRequests,
        libraryChannelId,
        0,
        null,
        0,
        null,
        isTestMovie,
        onPendingRequestsChanged
      );

      // Mark this movie as notified
      const cleanupTimer = setTimeout(() => {
        sentNotifications.delete(ItemId);
        logger.debug(
          `Cleaned up movie notification state for ItemId: ${ItemId}`
        );
      }, 24 * 60 * 60 * 1000); // 24 hours

      sentNotifications.set(ItemId, {
        level: 0, // Movies don't have hierarchy levels
        cleanupTimer: cleanupTimer,
      });

      if (res) return res.status(200).send("OK: Movie notification sent.");
      return; // Exit early to prevent fallthrough to unknown item type handler
    }

    if (
      data.ItemType === "Series" ||
      data.ItemType === "Season" ||
      data.ItemType === "Episode"
    ) {
      // For Series type, SeriesId is undefined, so use ItemId instead
      const SeriesId =
        data.SeriesId || (data.ItemType === "Series" ? data.ItemId : null);
      
      // Initialize variables outside the if block so they're accessible later
      let sentNotificationData = null;
      let sentLevel = 0;
      let sentTimestamp = 0;
      let currentLevel = 0;
      let shouldBlock = false;
      
      // Only skip duplicate check for individual test notifications (not batch tests)
      const skipDuplicateCheck = data.ItemId && data.ItemId.startsWith("test-");
      
      if (!skipDuplicateCheck) {
        sentNotificationData = sentNotifications.get(SeriesId);
        sentLevel = sentNotificationData ? sentNotificationData.level : 0;
        sentTimestamp = sentNotificationData
          ? sentNotificationData.timestamp
          : 0;
        currentLevel = getItemLevel(data.ItemType);

        logger.info(
          `[DUPLICATE CHECK] ${data.ItemType} "${
            data.Name
          }" - SeriesId: ${SeriesId}, sentLevel: ${sentLevel}, currentLevel: ${currentLevel}, has debouncer: ${debouncedSenders.has(
            SeriesId
          )}`
        );

      // Smart blocking logic: Allow season notifications after a delay from series notifications

      // If sentLevel === -1 (temporary marker), it means notification is being processed
      // Only block if there's no active debouncer (which would allow batching)
      if (sentLevel === -1) {
        if (!debouncedSenders.has(SeriesId)) {
          shouldBlock = true;
          logger.debug(`[BLOCKED] Notification for ${data.ItemType} "${data.Name}" blocked: already processing this series with no active debouncer (sentLevel: ${sentLevel})`);
        } else {
          shouldBlock = false;
          logger.debug(`[ALLOWED] Notification for ${data.ItemType} "${data.Name}" allowed: adding to existing debouncer batch (sentLevel: ${sentLevel})`);
        }
      }
      // If a notification was already sent (sentLevel > 0), apply blocking rules
      else if (sentLevel > 0 && currentLevel <= sentLevel) {
        // For season notifications after a series notification, allow if enough time has passed
        if (currentLevel === 2 && sentLevel === 3) {
          // Season after Series
          const timeSinceLastNotification = Date.now() - sentTimestamp;
          if (timeSinceLastNotification > SEASON_NOTIFICATION_DELAY_MS) {
            logger.info(
              `[ALLOWED] Season notification allowed: ${Math.round(
                timeSinceLastNotification / 1000 / 60
              )} minutes since series notification`
            );
            shouldBlock = false; // Don't block
          } else {
            logger.info(
              `[TIME BLOCKED] Season notification blocked: only ${Math.round(
                timeSinceLastNotification / 1000 / 60
              )} minutes since series notification (need ${
                SEASON_NOTIFICATION_DELAY_MS / 1000 / 60
              })`
            );
            shouldBlock = true; // Block
          }
        }
        // For all other cases, use original logic (block)
        else {
          shouldBlock = true;
        }
      }

      if (shouldBlock) {
        logger.info(
          `[BLOCKED] Skipping ${data.ItemType} notification for ${data.Name}: already sent level ${sentLevel} (current level: ${currentLevel})`
        );
        if (res) {
          return res
            .status(200)
            .send(
              `OK: Notification for ${data.Name} skipped, a higher-level notification was already sent.`
            );
        }
        return;
      }
      } // Close the if (!skipDuplicateCheck) block

      if (!SeriesId) {
        await processAndSendNotification(
          data,
          client,
          pendingRequests,
          libraryChannelId,
          0,
          null,
          0,
          null,
          isTestNotification,
          onPendingRequestsChanged
        );
        if (res)
          return res
            .status(200)
            .send("OK: TV notification sent (no SeriesId).");
      }

      // Skip debouncing and caching logic for individual test notifications (not batch tests)
      const isIndividualTest = data.ItemId && data.ItemId.startsWith("test-");
      if (isIndividualTest) {
        // For individual test notifications, send immediately without debouncing
        await processAndSendNotification(
          data,
          client,
          pendingRequests,
          libraryChannelId,
          0,
          null,
          0,
          null,
          isTestNotification,
          onPendingRequestsChanged
        );
        if (res)
          return res
            .status(200)
            .send("OK: Test notification sent.");
        return;
      }

      // If we don't have a debounced function for this series yet, create one.
      // BUT: If we already sent a notification (sentLevel > 0), don't create a new debouncer
      // This prevents duplicate notifications from delayed webhooks
      // ALSO: Check if we're already creating a debouncer to prevent race condition
      if (
        !debouncedSenders.has(SeriesId) &&
        !creatingDebouncers.has(SeriesId)
      ) {
        // Check if we already sent a notification for this series
        if (sentLevel > 0) {
          logger.debug(
            `Already sent notification for SeriesId ${SeriesId} (level: ${sentLevel}). Skipping new debouncer creation.`
          );
          if (res) {
            return res
              .status(200)
              .send(
                `OK: Notification for ${data.Name} skipped, notification already sent.`
              );
          }
          return;
        }

        // Mark this SeriesId as currently creating a debouncer
        creatingDebouncers.add(SeriesId);

        // Check if this is a batch test notification
        const isBatchTest = data.ItemId && data.ItemId.startsWith("batch-");

        // Use longer debounce for episodes/seasons of completely new series
        // This gives the series notification more time to arrive first
        const isNewSeries = sentLevel === 0; // No previous notifications for this series
        const isLowerLevel = currentLevel < 3; // Episode (1) or Season (2), not Series (3)
        const shouldUseLongerDebounce = isNewSeries && isLowerLevel;

        const debounceMs = isBatchTest
          ? 3000 // Force 3 seconds for batch test notifications
          : shouldUseLongerDebounce
          ? NEW_SERIES_DEBOUNCE_MS
          : parseInt(process.env.WEBHOOK_DEBOUNCE_MS) || DEFAULT_DEBOUNCE_MS;

        logger.info(
          `[DEBOUNCER] Creating debouncer for ${data.ItemType} "${data.Name}" with ${debounceMs}ms timeout (new series: ${isNewSeries}, lower level: ${isLowerLevel}${isBatchTest ? ', batch test' : ''})`
        );

        const newDebouncedSender = debounce(
          async (
            latestData,
            episodeCount = 0,
            episodeDetails = null,
            seasonCount = 0,
            seasonDetails = null
          ) => {
            try {
              logger.info(`[DEBOUNCER] Firing debouncer for SeriesId: ${SeriesId} after ${debounceMs}ms wait. Episodes: ${episodeCount}, Seasons: ${seasonCount}`);
              const isBatchTestNotif = latestData.ItemId && latestData.ItemId.startsWith("batch-");
              await processAndSendNotification(
                latestData,
                client,
                pendingRequests,
                libraryChannelId,
                episodeCount,
                episodeDetails,
                seasonCount,
                seasonDetails,
                isBatchTestNotif,
                onPendingRequestsChanged
              );

              const levelSent = getItemLevel(latestData.ItemType);

              // Clear any existing cleanup timer (from temporary marker)
              if (sentNotifications.has(SeriesId)) {
                const existingNotification = sentNotifications.get(SeriesId);
                if (existingNotification.cleanupTimer) {
                  clearTimeout(existingNotification.cleanupTimer);
                }
              }

              // Set a cleanup timer for the 'sent' notification state
              // Use a longer duration to prevent duplicate notifications from delayed webhooks
              const cleanupTimer = setTimeout(() => {
                sentNotifications.delete(SeriesId);
                logger.debug(
                  `Cleaned up sent notification state for SeriesId: ${SeriesId}`
                );
              }, 2 * 60 * 60 * 1000); // 2 hours instead of 24 hours - enough to block duplicates but not too long

              sentNotifications.set(SeriesId, {
                level: levelSent,
                timestamp: Date.now(),
                cleanupTimer: cleanupTimer,
              });
              logger.info(
                `[SENT NOTIFICATION] Set sentLevel=${levelSent} for SeriesId ${SeriesId} (${latestData.Name})`
              );

              // The debounced function has fired, we can remove it.
              debouncedSenders.delete(SeriesId);
              creatingDebouncers.delete(SeriesId); // Also cleanup from creatingDebouncers
            } catch (error) {
              logger.error(
                `Error in debounced notification for series ${SeriesId}:`,
                error
              );
              // Cleanup all maps on error so future webhooks for this series are not blocked
              debouncedSenders.delete(SeriesId);
              creatingDebouncers.delete(SeriesId);
              // Clear temp marker (-1) so the series is not blocked for 24h after a failed notification
              if (sentNotifications.has(SeriesId)) {
                const existing = sentNotifications.get(SeriesId);
                if (existing.cleanupTimer) clearTimeout(existing.cleanupTimer);
                if (existing.level === -1) sentNotifications.delete(SeriesId);
              }
            }
          },
          debounceMs
        );

        debouncedSenders.set(SeriesId, {
          sender: newDebouncedSender,
          latestData: data,
          episodeCount: 0,
          episodes: [], // Track individual episodes - will be added below
          firstEpisode: null,
          lastEpisode: null,
          seasonCount: 0,
          seasons: [], // Track individual seasons - will be added below
          timestamp: Date.now(), // Track creation time for periodic cleanup
        });

        // Remove from creatingDebouncers now that it's been added to debouncedSenders
        creatingDebouncers.delete(SeriesId);

        // Mark this series as being processed immediately to prevent duplicate debouncers
        // This will be updated with the final level once the debounced notification is sent
        const tempCleanupTimer = setTimeout(() => {
          // Only clean up if debouncer is no longer active
          if (
            !debouncedSenders.has(SeriesId) &&
            sentNotifications.has(SeriesId)
          ) {
            const notification = sentNotifications.get(SeriesId);
            // Only delete if this is still the temp marker (level: -1)
            if (notification.level === -1) {
              sentNotifications.delete(SeriesId);
              logger.debug(
                `Cleaned up temporary notification marker for SeriesId: ${SeriesId}`
              );
            }
          }
        }, 5 * 60 * 1000); // 5 minutes — short enough that a failed debounce doesn't block the series for long

        sentNotifications.set(SeriesId, {
          level: -1, // Temporary marker indicating processing is in progress
          timestamp: Date.now(),
          cleanupTimer: tempCleanupTimer,
        });
      }

      // Update the data to be sent with the highest-level notification received so far.
      logger.info(`[DEBOUNCER] Getting existing debouncer for SeriesId: ${SeriesId}, exists: ${debouncedSenders.has(SeriesId)}`);
      const debouncer = debouncedSenders.get(SeriesId);
      
      if (!debouncer) {
        logger.error(`[DEBOUNCER] ERROR: Debouncer not found for SeriesId: ${SeriesId} even though has() returned ${debouncedSenders.has(SeriesId)}`);
        if (res) return res.status(500).send("Internal error: debouncer not found");
        return;
      }
      
      const existingLevel = getItemLevel(debouncer.latestData.ItemType);

      // Always prefer higher-level notifications (Series > Season > Episode)
      // This ensures we send the most comprehensive notification
      if (currentLevel > existingLevel) {
        debouncer.latestData = data;
        logger.debug(
          `Updated debouncer for ${SeriesId}: ${debouncer.latestData.ItemType} -> ${data.ItemType} (higher priority)`
        );
      } else if (currentLevel === existingLevel) {
        // Same level - update to keep latest data
        debouncer.latestData = data;
      }

      // Track season count for better notifications
      if (data.ItemType === "Season") {
        logger.info(`[DEBOUNCER] Processing season update for "${data.Name}", SeasonNumber: ${data.SeasonNumber}, IndexNumber: ${data.IndexNumber}, existing seasons: ${debouncer.seasonCount || 0}`);
        debouncer.seasons = debouncer.seasons || [];
        
        // Log existing seasons for debugging
        if (debouncer.seasons.length > 0) {
          logger.info(`[DEBOUNCER] Existing seasons in array: ${debouncer.seasons.map(s => `S${s.SeasonNumber} (idx:${s.IndexNumber}, name:"${s.Name}")`).join(', ')}`);
        }

        // Check for duplicates by SeasonNumber before adding
        const existingSeason = debouncer.seasons.find(
          (s) =>
            (s.SeasonNumber !== undefined && s.SeasonNumber === data.SeasonNumber) ||
            (s.IndexNumber !== undefined && s.IndexNumber === data.IndexNumber)
        );

        if (existingSeason) {
          // Duplicate season - skip processing to avoid double notifications
          logger.info(
            `[DEBOUNCER] Duplicate season detected! Incoming: S${data.SeasonNumber} (idx:${data.IndexNumber}, name:"${data.Name}"), Existing: S${existingSeason.SeasonNumber} (idx:${existingSeason.IndexNumber}, name:"${existingSeason.Name}")`
          );
          if (res) {
            return res
              .status(200)
              .send(`OK: Duplicate season ${data.Name} skipped.`);
          }
          return;
        }

        logger.info(`[DEBOUNCER] Adding season "${data.Name}" (SeasonNumber: ${data.SeasonNumber}) to batch, new count: ${(debouncer.seasonCount || 0) + 1}`);
        // Only increment count and add season if it's not a duplicate
        debouncer.seasonCount = (debouncer.seasonCount || 0) + 1;
        debouncer.seasons.push(data);
        logger.info(`[DEBOUNCER] Season added successfully. Total seasons in debouncer: ${debouncer.seasons.length}, seasons: [${debouncer.seasons.map(s => `S${s.SeasonNumber}`).join(', ')}]`);

        // Smart rate limiting: if many seasons are coming in at once, fire debouncer faster
        if (debouncer.seasonCount > 10) {
          // If 10+ seasons, fire immediately
          debouncer.sender.flush?.();
          logger.debug(
            `Rate limiting: Firing debouncer immediately for ${debouncer.seasonCount} seasons`
          );
        }
      }

      // Track episode count for better notifications
      if (data.ItemType === "Episode") {
        logger.info(`[DEBOUNCER] Processing episode update for "${data.Name}", SeasonNumber: ${data.SeasonNumber}, EpisodeNumber: ${data.EpisodeNumber}, existing episodes: ${debouncer.episodeCount || 0}`);
        debouncer.episodes = debouncer.episodes || [];
        
        // Log existing episodes for debugging
        if (debouncer.episodes.length > 0) {
          logger.info(`[DEBOUNCER] Existing episodes in array: ${debouncer.episodes.map(ep => `S${ep.SeasonNumber}E${ep.EpisodeNumber} ("${ep.Name}")`).join(', ')}`);
        }

        // Check for duplicates by EpisodeNumber before adding
        const existingEpisode = debouncer.episodes.find(
          (ep) =>
            ep.EpisodeNumber !== undefined && 
            data.EpisodeNumber !== undefined &&
            ep.EpisodeNumber === data.EpisodeNumber &&
            ep.SeasonNumber === data.SeasonNumber
        );

        if (existingEpisode) {
          // Duplicate episode - skip processing to avoid double notifications
          logger.info(
            `[DEBOUNCER] Duplicate episode detected! Incoming: S${data.SeasonNumber}E${data.EpisodeNumber} ("${data.Name}"), Existing: S${existingEpisode.SeasonNumber}E${existingEpisode.EpisodeNumber} ("${existingEpisode.Name}")`
          );
          if (res) {
            return res
              .status(200)
              .send(`OK: Duplicate episode ${data.Name} skipped.`);
          }
          return;
        }

        logger.info(`[DEBOUNCER] Adding episode "${data.Name}" (S${data.SeasonNumber}E${data.EpisodeNumber}) to batch, new count: ${(debouncer.episodeCount || 0) + 1}`);

        // Only increment count and add episode if it's not a duplicate
        debouncer.episodeCount = (debouncer.episodeCount || 0) + 1;
        debouncer.episodes.push(data);
        
        logger.info(`[DEBOUNCER] Episode added successfully. Total episodes in debouncer: ${debouncer.episodes.length}, episodes: [${debouncer.episodes.map(ep => `S${ep.SeasonNumber}E${ep.EpisodeNumber}`).join(', ')}]`);

        // Track first and last episode for range display
        if (
          !debouncer.firstEpisode ||
          data.EpisodeNumber < debouncer.firstEpisode.EpisodeNumber
        ) {
          debouncer.firstEpisode = data;
        }
        if (
          !debouncer.lastEpisode ||
          data.EpisodeNumber > debouncer.lastEpisode.EpisodeNumber
        ) {
          debouncer.lastEpisode = data;
        }

        // Smart rate limiting: if many episodes are coming in at once, fire debouncer faster
        // This prevents unnecessary delays when bulk importing episodes
        if (debouncer.episodeCount > 30) {
          // If 30+ episodes, fire immediately (don't wait full debounce time)
          debouncer.sender.flush?.();
          logger.debug(
            `Rate limiting: Firing debouncer immediately for ${debouncer.episodeCount} episodes`
          );
        } else if (debouncer.episodeCount > 10) {
          // If 10-30 episodes, reduce remaining wait time
          debouncer.sender.reset?.();
          logger.debug(
            `Rate limiting: Resetting debouncer timeout for ${debouncer.episodeCount} episodes (will fire in reduced time)`
          );
        }
      }

      // Call the debounced function. It will only execute after the configured debounce period of inactivity.
      const episodeDetails = debouncer.episodes
        ? {
            episodes: debouncer.episodes,
            firstEpisode: debouncer.firstEpisode,
            lastEpisode: debouncer.lastEpisode,
          }
        : null;

      const seasonDetails = debouncer.seasons
        ? {
            seasons: debouncer.seasons,
          }
        : null;

      logger.info(`[DEBOUNCER] Calling debouncer.sender() for SeriesId: ${SeriesId}, episodeCount: ${debouncer.episodeCount || 0}, seasonCount: ${debouncer.seasonCount || 0}`);
      
      // Log the actual seasons being sent
      if (seasonDetails && seasonDetails.seasons) {
        logger.info(`[DEBOUNCER] Seasons in batch: ${seasonDetails.seasons.map(s => `S${s.SeasonNumber} (${s.Name})`).join(', ')}`);
      }
      
      debouncer.sender(
        debouncer.latestData,
        debouncer.episodeCount || 0,
        episodeDetails,
        debouncer.seasonCount || 0,
        seasonDetails
      );
      
      logger.info(`[DEBOUNCER] Debouncer.sender() called successfully for SeriesId: ${SeriesId}`);

      if (res) {
        return res
          .status(200)
          .send(`OK: TV notification for ${SeriesId} is debounced.`);
      }
      return;
    }

    // If we reach here, it's an unknown item type - process it normally
    const isUnknownTest = data.ItemId && (data.ItemId.startsWith("test-") || data.ItemId.startsWith("batch-"));
    await processAndSendNotification(
      data,
      client,
      pendingRequests,
      libraryChannelId,
      0,
      null,
      0,
      null,
      isUnknownTest,
      onPendingRequestsChanged
    );
    if (res) return res.status(200).send("OK: Notification sent.");
  } catch (err) {
    logger.error("Error handling Jellyfin webhook:", err);
    // Make sure we haven't already sent a response
    if (res && !res.headersSent) {
      res.status(500).send("Error");
    }
  }
}
