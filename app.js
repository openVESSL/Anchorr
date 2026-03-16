import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import express from "express";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { handleJellyfinWebhook, libraryCache } from "./jellyfinWebhook.js";
import { configTemplate } from "./lib/config.js";
import axios from "axios";

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require("./package.json");

import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";

// --- MODULE IMPORTS ---
import * as tmdbApi from "./api/tmdb.js";
import * as jellyseerrApi from "./api/jellyseerr.js";
import { registerCommands } from "./discord/commands.js";
import logger from "./utils/logger.js";
import {
  validateBody,
  configSchema,
  userMappingSchema,
} from "./utils/validation.js";
import cache from "./utils/cache.js";
import { COLORS, TIMEOUTS } from "./lib/constants.js";
import {
  login,
  register,
  logout,
  checkAuth,
  authenticateToken,
  WEBHOOK_SECRET,
} from "./utils/auth.js";
import { jellyfinPoller } from "./jellyfinPoller.js";
import JellyfinWebSocketClient from "./jellyfinWebSocket.js";
import { minutesToHhMm } from "./utils/time.js";
import { fetchOMDbData } from "./api/omdb.js";
import {
  CONFIG_PATH,
  readConfig,
  writeConfig,
  loadConfigToEnv,
  getUserMappings,
  saveUserMapping,
  deleteUserMapping,
} from "./utils/configFile.js";

// --- Helper Functions ---
function isValidUrl(string) {
  if (!string || typeof string !== "string") return false;
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

// --- Config Sanitization (Defense-in-depth) ---
const MASKED_PREFIX = "••••••••";
const SENSITIVE_FIELDS = [
  "DISCORD_TOKEN",
  "JELLYSEERR_API_KEY",
  "JELLYFIN_API_KEY",
  "TMDB_API_KEY",
  "OMDB_API_KEY",
];
const STRIPPED_FIELDS = ["JWT_SECRET", "WEBHOOK_SECRET"];

function maskSecret(value) {
  if (!value || typeof value !== "string") return "";
  return value.length > 4
    ? MASKED_PREFIX + value.slice(-4)
    : MASKED_PREFIX;
}

function isMaskedValue(value) {
  return typeof value === "string" && value.startsWith(MASKED_PREFIX);
}

function sanitizeConfigForClient(config) {
  if (!config) return config;
  const sanitized = { ...config };

  for (const field of SENSITIVE_FIELDS) {
    if (sanitized[field]) {
      sanitized[field] = maskSecret(sanitized[field]);
    }
  }
  for (const field of STRIPPED_FIELDS) {
    delete sanitized[field];
  }

  // Strip password hashes from USERS array
  if (Array.isArray(sanitized.USERS)) {
    sanitized.USERS = sanitized.USERS.map(({ password, ...user }) => user);
  }

  return sanitized;
}

// --- CONFIGURATION ---
const ENV_PATH = path.join(process.cwd(), ".env");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const envVars = {};

    content.split("\n").forEach((line) => {
      line = line.trim();
      // Skip empty lines and comments
      if (!line || line.startsWith("#")) return;

      const [key, ...valueParts] = line.split("=");
      const trimmedKey = key.trim();
      const trimmedValue = valueParts.join("=").trim();

      // Remove quotes if present
      const cleanValue = trimmedValue.replace(/^["']|["']$/g, "");

      if (trimmedKey && cleanValue) {
        envVars[trimmedKey] = cleanValue;
      }
    });

    return envVars;
  } catch (error) {
    logger.error("Error reading or parsing .env file:", error);
    return {};
  }
}

function migrateEnvToConfig() {
  // Check if .env exists and config.json doesn't
  if (fs.existsSync(ENV_PATH) && !fs.existsSync(CONFIG_PATH)) {
    logger.info(
      "🔄 Detected .env file. Migrating environment variables to config.json..."
    );

    const envVars = parseEnvFile(ENV_PATH);
    const migratedConfig = { ...configTemplate };

    // Map .env variables to config
    for (const [key, value] of Object.entries(envVars)) {
      if (key in migratedConfig) {
        migratedConfig[key] = value;
      }
    }

    // Save migrated config using centralized writeConfig
    if (writeConfig(migratedConfig)) {
      logger.info("✅ Migration successful! config.json created from .env");
      logger.info(
        "📝 You can now delete the .env file as it's no longer needed."
      );
    } else {
      logger.error("❌ Error saving migrated config - check permissions");
    }
  }
}

function loadConfig() {
  logger.debug("[LOADCONFIG] Checking CONFIG_PATH:", CONFIG_PATH);
  logger.debug("[LOADCONFIG] File exists:", fs.existsSync(CONFIG_PATH));

  // Use centralized loadConfigToEnv (includes all migrations)
  const success = loadConfigToEnv();

  if (success) {
    logger.debug(
      "[LOADCONFIG] Config keys loaded:",
      Object.keys(process.env).filter(
        (k) =>
          k.startsWith("DISCORD") ||
          k.startsWith("JELLYFIN") ||
          k.startsWith("JELLYSEERR")
      ).length
    );
    logger.debug(
      "[LOADCONFIG] DISCORD_TOKEN in process.env:",
      process.env.DISCORD_TOKEN
        ? process.env.DISCORD_TOKEN.slice(0, 6) + "..."
        : "UNDEFINED"
    );
  } else {
    logger.debug("[LOADCONFIG] Config file does not exist or failed to load");
  }

  return success;
}

/**
 * Verify volume persistence configuration for Docker deployments
 * Detects if config directory is mounted as a proper volume and warns if misconfigured
 */
function verifyVolumeConfiguration() {
  const configDir = path.dirname(CONFIG_PATH);

  // Ensure config directory exists
  if (!fs.existsSync(configDir)) {
    try {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o777 });
      logger.info(`✅ Created config directory at ${configDir}`);
    } catch (error) {
      logger.error(
        `❌ Failed to create config directory at ${configDir}:`,
        error
      );
      return;
    }
  }

  // Verify config directory is writable
  try {
    const testFile = path.join(configDir, ".volume-test");
    fs.writeFileSync(testFile, "test", { mode: 0o666 });
    fs.unlinkSync(testFile);
    logger.info(
      `✅ Config directory ${configDir} is properly configured and writable`
    );
  } catch (error) {
    if (error.code === "EACCES") {
      logger.error(
        `❌ CRITICAL: Cannot write to ${configDir} - check Docker volume permissions`
      );
      logger.error(`   On Unraid: Ensure host path is mapped to /config`);
      logger.error(`   On Docker: Verify volume mount in docker-compose.yml`);
      logger.error(`   Current config path: ${CONFIG_PATH}`);
    } else {
      logger.error(`❌ Error verifying volume configuration:`, error);
    }
  }
}

const app = express();
let port = process.env.WEBHOOK_PORT || 8282;

// --- BOT STATE MANAGEMENT ---
let discordClient = null;
let isBotRunning = false;
let jellyfinWebSocketClient = null;

// --- PENDING REQUESTS TRACKING ---
// Map to track user requests: key = "tmdbId-mediaType", value = Set of Discord user IDs
const pendingRequests = new Map();

const PENDING_REQUESTS_PATH = path.join(path.dirname(CONFIG_PATH), "pending-requests.json");

function savePendingRequests() {
  try {
    const serialized = {};
    for (const [key, userSet] of pendingRequests) {
      serialized[key] = Array.from(userSet);
    }
    fs.writeFileSync(PENDING_REQUESTS_PATH, JSON.stringify(serialized, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    logger.warn(`⚠️ Failed to persist pending requests to disk: ${err.message}`);
  }
}

function loadPendingRequests() {
  if (!fs.existsSync(PENDING_REQUESTS_PATH)) return;
  try {
    const raw = fs.readFileSync(PENDING_REQUESTS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    for (const [key, userArray] of Object.entries(parsed)) {
      if (Array.isArray(userArray) && userArray.length > 0) {
        pendingRequests.set(key, new Set(userArray));
      }
    }
    logger.info(`✅ Loaded ${pendingRequests.size} pending request(s) from disk`);
  } catch (err) {
    logger.warn(`⚠️ Failed to load pending requests from disk: ${err.message}`);
  }
}

// --- DAILY RANDOM PICK SCHEDULING ---
let dailyRandomPickTimer = null;

function scheduleDailyRandomPick(client) {
  if (dailyRandomPickTimer) {
    clearInterval(dailyRandomPickTimer);
  }

  const enabled = process.env.DAILY_RANDOM_PICK_ENABLED === "true";
  if (!enabled) {
    return;
  }

  const channelId = process.env.DAILY_RANDOM_PICK_CHANNEL_ID;
  const intervalMinutes = parseInt(process.env.DAILY_RANDOM_PICK_INTERVAL || "1440");

  if (!channelId) {
    logger.warn(
      "Daily Random Pick is enabled but no channel is configured. Skipping."
    );
    return;
  }

  if (intervalMinutes < 1) {
    logger.warn("Daily Random Pick interval must be at least 1 minute. Skipping.");
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  logger.info(
    `📅 Daily Random Pick scheduled every ${intervalMinutes} minute${intervalMinutes !== 1 ? 's' : ''}`
  );

  // Send the first pick immediately
  sendDailyRandomPick(client).catch((err) =>
    logger.error("Error sending initial random pick:", err)
  );

  // Schedule it to repeat at the specified interval
  dailyRandomPickTimer = setInterval(async () => {
    await sendDailyRandomPick(client);
  }, intervalMs);
}

async function sendDailyRandomPick(client) {
  try {
    const TMDB_API_KEY = process.env.TMDB_API_KEY;
    const channelId = process.env.DAILY_RANDOM_PICK_CHANNEL_ID;

    if (!TMDB_API_KEY || !channelId) {
      return;
    }

    // Get random media
    const randomMedia = await tmdbApi.tmdbGetRandomMedia(TMDB_API_KEY);
    if (!randomMedia) {
      logger.warn("Could not fetch random media for daily pick");
      return;
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      logger.warn(`Daily Random Pick channel not found: ${channelId}`);
      return;
    }

    // Build embed
    const mediaType = randomMedia.media_type;
    const isMovie = mediaType === "movie";
    const title = isMovie ? randomMedia.title : randomMedia.name;
    const year = isMovie
      ? randomMedia.release_date?.slice(0, 4)
      : randomMedia.first_air_date?.slice(0, 4);
    const details = randomMedia.details || randomMedia;

    const emoji = isMovie ? "🎬" : "📺";
    const backdrop = randomMedia.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${randomMedia.backdrop_path}`
      : null;

    let overview = randomMedia.overview || "No description available.";
    if (overview.length > 300) {
      overview = overview.substring(0, 297) + "...";
    }

    const embed = new EmbedBuilder()
      .setAuthor({ name: `${emoji} Today's Random Pick` })
      .setTitle(`${title}${year ? ` (${year})` : ""}`)
      .setDescription(overview)
      .setColor("#f5a962")
      .addFields({
        name: "Rating",
        value: randomMedia.vote_average
          ? `⭐ ${randomMedia.vote_average.toFixed(1)}/10`
          : "N/A",
        inline: true,
      });

    if (details.genres && Array.isArray(details.genres)) {
      const genreNames = details.genres.map((g) => g.name).join(", ");
      if (genreNames) {
        embed.addFields({
          name: "Genres",
          value: genreNames,
          inline: true,
        });
      }
    }

    if (backdrop && isValidUrl(backdrop)) {
      embed.setImage(backdrop);
    }

    const buttonComponents = [];

    // Letterboxd button
    if (isMovie) {
      const letterboxdUrl = `https://letterboxd.com/search/${encodeURIComponent(title)}/`;
      if (isValidUrl(letterboxdUrl)) {
        buttonComponents.push(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("Letterboxd")
            .setURL(letterboxdUrl)
        );
      }
    }

    // IMDb button if available
    let imdbId = null;
    if (details.external_ids?.imdb_id) {
      imdbId = details.external_ids.imdb_id;
    }
    if (imdbId) {
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

    // Request button
    buttonComponents.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Primary)
        .setLabel("Request")
        .setCustomId(`request_random_${randomMedia.id}_${mediaType}`)
    );

    const button = new ActionRowBuilder().addComponents(buttonComponents);

    await channel.send({
      embeds: [embed],
      components: [button],
    });

    logger.info(
      `Sent daily random pick: ${title} (${randomMedia.id} - ${mediaType})`
    );
  } catch (error) {
    logger.error(`Failed to send daily random pick: ${error.message}`);
  }
}

async function startBot() {
  if (isBotRunning && discordClient) {
    logger.info("Bot is already running.");
    return { success: true, message: "Bot is already running." };
  }

  // Restore any pending requests that survived a previous restart
  loadPendingRequests();

  // Load the latest config from file
  const configLoaded = loadConfig();
  port = process.env.WEBHOOK_PORT || 8282; // Recalculate port in case it changed
  if (!configLoaded) {
    throw new Error(
      "Configuration file (config.json) not found or is invalid."
    );
  }

  // ----------------- VALIDATE ENV -----------------
  const REQUIRED_DISCORD = ["DISCORD_TOKEN", "BOT_ID"];
  const missing = REQUIRED_DISCORD.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Bot cannot start. Missing required Discord variables: ${missing.join(
        ", "
      )}`
    );
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.Channel],
  });
  discordClient = client; // Store client instance globally

  // ----------------- CONFIG HELPERS (DYNAMIC) -----------------
  const getJellyseerrUrl = () => {
    let url = (process.env.JELLYSEERR_URL || "").replace(/\/$/, "");
    if (url && !url.endsWith("/api/v1")) url += "/api/v1";
    return url;
  };
  const getJellyseerrApiKey = () => process.env.JELLYSEERR_API_KEY;
  const getTmdbApiKey = () => process.env.TMDB_API_KEY;
  const getJellyseerrAutoApprove = () => {
    const val = process.env.JELLYSEERR_AUTO_APPROVE;
    const isAuto = val === "true";
    logger.info(`[CONFIG CHECK] JELLYSEERR_AUTO_APPROVE is currently: ${val} (Evaluated to: ${isAuto})`);
    return isAuto;
  };

  const BOT_ID = process.env.BOT_ID;
  const GUILD_ID = process.env.GUILD_ID;
  const JELLYSEERR_URL = getJellyseerrUrl();
  const JELLYSEERR_API_KEY = getJellyseerrApiKey();
  const TMDB_API_KEY = getTmdbApiKey();

  // ----------------- HELPERS -----------------

  // ----------------- HELPERS -----------------
  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function getOptionStringRobust(
    interaction,
    possibleNames = ["title", "query", "name"]
  ) {
    for (const n of possibleNames) {
      try {
        const v = interaction.options.getString(n);
        if (typeof v === "string" && v.length > 0) return v;
      } catch (e) { }
    }
    try {
      const data = (interaction.options && interaction.options.data) || [];
      if (Array.isArray(data) && data.length > 0) {
        for (const opt of data) {
          if (typeof opt.value !== "undefined" && opt.value !== null)
            return String(opt.value);
        }
      }
    } catch (e) { }
    return null;
  }

  function parseQualityAndServerOptions(options, mediaType) {
    let profileId = null;
    let serverId = null;

    // Parse quality option (format: profileId|serverId|type)
    if (options.quality) {
      const [qProfileId, qServerId, qType] = options.quality.split("|");
      // Only use if matching media type (radarr for movies, sonarr for TV)
      if ((mediaType === "movie" && qType === "radarr") || (mediaType === "tv" && qType === "sonarr")) {
        const parsedProfileId = parseInt(qProfileId, 10);
        const parsedServerId = parseInt(qServerId, 10);

        if (!isNaN(parsedProfileId) && !isNaN(parsedServerId)) {
          profileId = parsedProfileId;
          serverId = parsedServerId;
          logger.debug(`Using quality profile ID: ${profileId} from server ID: ${serverId}`);
        } else {
          logger.warn(`Invalid quality option format - non-numeric values: profileId=${qProfileId}, serverId=${qServerId}`);
        }
      } else {
        logger.debug(`Ignoring quality option - type mismatch (${qType} vs ${mediaType})`);
      }
    }

    // Parse server option (format: serverId|type) - only if not already set from quality
    if (options.server && serverId === null) {
      const [sServerId, sType] = options.server.split("|");
      // Only use if matching media type
      if ((mediaType === "movie" && sType === "radarr") || (mediaType === "tv" && sType === "sonarr")) {
        const parsedServerId = parseInt(sServerId, 10);

        if (!isNaN(parsedServerId)) {
          serverId = parsedServerId;
          logger.debug(`Using server ID: ${serverId} from server option`);
        } else {
          logger.warn(`Invalid server option format - non-numeric serverId: ${sServerId}`);
        }
      } else {
        logger.debug(`Ignoring server option - type mismatch (${sType} vs ${mediaType})`);
      }
    }

    // Apply defaults from config if not specified
    if (profileId === null && serverId === null) {
      // Check for default quality profile
      const defaultQualityConfig = mediaType === "movie"
        ? process.env.DEFAULT_QUALITY_PROFILE_MOVIE
        : process.env.DEFAULT_QUALITY_PROFILE_TV;

      if (defaultQualityConfig) {
        const [dProfileId, dServerId] = defaultQualityConfig.split("|");
        if (dProfileId && dServerId) {
          const parsedProfileId = parseInt(dProfileId, 10);
          const parsedServerId = parseInt(dServerId, 10);

          if (!isNaN(parsedProfileId) && !isNaN(parsedServerId)) {
            profileId = parsedProfileId;
            serverId = parsedServerId;
            logger.debug(`Using default quality profile ID: ${profileId} from config`);
          } else {
            logger.warn(`Invalid default quality config format - non-numeric values: profileId=${dProfileId}, serverId=${dServerId}`);
          }
        }
      }
    }

    if (serverId === null) {
      // Default to configured default server if not set
      const defaultServerConfig = mediaType === "movie"
        ? process.env.DEFAULT_SERVER_MOVIE
        : process.env.DEFAULT_SERVER_TV;

      if (defaultServerConfig) {
        const [dServerId] = defaultServerConfig.split("|");
        if (dServerId) {
          const parsedServerId = parseInt(dServerId, 10);

          if (!isNaN(parsedServerId)) {
            serverId = parsedServerId;
            logger.debug(`Using default server ID: ${serverId} from config`);
          } else {
            logger.warn(`Invalid default server config format - non-numeric serverId: ${dServerId}`);
          }
        }
      }
    }

    return { profileId, serverId };
  }

  // ----------------- EMBED BUILDER -----------------
  function buildNotificationEmbed(
    details,
    mediaType,
    imdbId,
    status = "search",
    omdb = null,
    tmdbId = null
  ) {
    const titleName = details.title || details.name || "Unknown";
    const releaseDate = details.release_date || details.first_air_date || "";
    const year = releaseDate ? releaseDate.slice(0, 4) : "";
    const titleWithYear = year ? `${titleName} (${year})` : titleName;

    const authorName =
      status === "success"
        ? "✅ Successfully requested!"
        : mediaType === "movie"
          ? "🎬 Movie found:"
          : "📺 TV show found:";

    // Generate Jellyseerr URL for the author link
    // Remove /api/v1 from getJellyseerrUrl() to get the base domain
    // Add ?manage=1 only for success status
    let jellyseerrMediaUrl;
    const currentJellyseerrUrl = getJellyseerrUrl();
    if (tmdbId && currentJellyseerrUrl) {
      const jellyseerrDomain = currentJellyseerrUrl.replace(/\/api\/v1\/?$/, "").replace(/\/+$/, "");
      const baseUrl = `${jellyseerrDomain}/${mediaType}/${tmdbId}`;
      jellyseerrMediaUrl =
        status === "success" ? `${baseUrl}?manage=1` : baseUrl;
    }

    const genres =
      (details.genres || []).map((g) => g.name).join(", ") || "Unknown";

    let runtime = "Unknown";
    if (omdb?.Runtime && omdb.Runtime !== "N/A") {
      const match = String(omdb.Runtime).match(/(\d+)/);
      if (match) runtime = minutesToHhMm(parseInt(match[1], 10));
    } else if (mediaType === "movie" && details.runtime > 0) {
      runtime = minutesToHhMm(details.runtime);
    } else if (
      mediaType === "tv" &&
      Array.isArray(details.episode_run_time) &&
      details.episode_run_time.length > 0
    ) {
      runtime = minutesToHhMm(details.episode_run_time[0]);
    }

    const rating = omdb?.imdbRating
      ? `${omdb.imdbRating}/10`
      : typeof details.vote_average === "number" && details.vote_average > 0
        ? `${details.vote_average.toFixed(1)}/10`
        : "N/A";

    let overview =
      (details.overview && details.overview.trim() !== ""
        ? details.overview
        : null) ||
      (omdb?.Plot && omdb.Plot !== "N/A"
        ? omdb.Plot
        : "No description available.");

    let headerLine = "Summary";
    if (omdb) {
      if (mediaType === "movie" && omdb.Director && omdb.Director !== "N/A") {
        headerLine = `Directed by ${omdb.Director}`;
      } else if (mediaType === "tv" && omdb.Writer && omdb.Writer !== "N/A") {
        // OMDb often lists creators under "Writer"
        const creator = omdb.Writer.split(",")[0].trim();
        headerLine = `Created by ${creator}`;
      }
    }

    const embed = new EmbedBuilder()
      .setAuthor({
        name: authorName,
        url: isValidUrl(jellyseerrMediaUrl) ? jellyseerrMediaUrl : undefined,
      })
      .setTitle(titleWithYear)
      .setURL(imdbId ? `https://www.imdb.com/title/${imdbId}/` : undefined)
      .setColor(
        status === "success"
          ? COLORS.SUCCESS
          : status === "search"
            ? COLORS.SEARCH
            : COLORS.DEFAULT
      );

    const backdropPath = tmdbApi.findBestBackdrop(details);
    const backdrop = backdropPath
      ? `https://image.tmdb.org/t/p/w1280${backdropPath}`
      : null;
    const poster = details.poster_path
      ? `https://image.tmdb.org/t/p/w342${details.poster_path}`
      : null;

    if (backdrop && isValidUrl(backdrop)) {
      embed.setImage(backdrop);
    } else if (poster && isValidUrl(poster)) {
      embed.setThumbnail(poster);
    }

    embed.addFields(
      {
        name: headerLine,
        value: overview.length ? overview : "No description available.",
      },
      { name: "Genre", value: genres, inline: true },
      { name: "Runtime", value: runtime, inline: true },
      { name: "Rating", value: rating, inline: true }
    );

    return embed;
  }

  // ----------------- BUTTONS BUILDER -----------------
  function buildButtons(
    tmdbId,
    imdbId,
    requested = false,
    mediaType = "movie",
    details = null,
    requestedSeasons = [],
    requestedTags = [],
    selectedSeasons = [],
    selectedTags = []
  ) {
    const rows = [];
    const buttons = [];

    // Always add IMDB and Letterboxd buttons if available
    if (imdbId) {
      const letterboxdUrl = `https://letterboxd.com/imdb/${imdbId}`;
      const imdbUrl = `https://www.imdb.com/title/${imdbId}/`;

      if (isValidUrl(letterboxdUrl)) {
        buttons.push(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("Letterboxd")
            .setURL(letterboxdUrl)
        );
      }

      if (isValidUrl(imdbUrl)) {
        buttons.push(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("IMDb")
            .setURL(imdbUrl)
        );
      }
    }

    // Add Request button (dynamic label based on selections)
    if (requested) {
      // Show success state with full info
      let successLabel = "Requested";

      // Only show seasons info for TV shows, not for movies
      if (mediaType === "tv" && requestedSeasons.length > 0) {
        if (requestedSeasons.includes("all")) {
          successLabel = "Requested all seasons";
        } else if (requestedSeasons.length === 1) {
          successLabel = `Requested season ${requestedSeasons[0]}`;
        } else {
          const seasons = [...requestedSeasons];
          const lastSeason = seasons.pop();
          successLabel = `Requested seasons ${seasons.join(
            ", "
          )} and ${lastSeason}`;
        }
      }
      if (requestedTags.length > 0) {
        // requestedTags contains tag names when coming from request_btn handler
        const tagLabel =
          requestedTags.length === 1
            ? requestedTags[0]
            : requestedTags.join(", ");
        successLabel += ` with ${tagLabel} tag${requestedTags.length > 1 ? "s" : ""
          }`;
      }

      // Always add "stay tuned!" for all requests
      successLabel += ", stay tuned!";

      buttons.push(
        new ButtonBuilder()
          .setCustomId(`requested|${tmdbId}|${mediaType}`)
          .setLabel(successLabel)
          .setStyle(ButtonStyle.Success)
          .setDisabled(true)
      );
    } else {
      // Show Request button with dynamic label
      let requestLabel = "Request";

      if (mediaType === "tv" && selectedSeasons.length > 0) {
        if (selectedSeasons.includes("all")) {
          requestLabel = "Request all seasons";
        } else if (selectedSeasons.length === 1) {
          requestLabel = `Request season ${selectedSeasons[0]}`;
        } else {
          const seasons = [...selectedSeasons];
          const lastSeason = seasons.pop();
          requestLabel = `Request seasons ${seasons.join(
            ", "
          )} and ${lastSeason}`;
        }
      }

      if (selectedTags.length > 0) {
        // selectedTags contains tag names (not IDs) when coming from select_tags handler
        const tagLabel =
          selectedTags.length === 1 ? selectedTags[0] : selectedTags.join(", ");
        requestLabel += ` with ${tagLabel} tag${selectedTags.length > 1 ? "s" : ""
          }`;
      }

      const seasonsParam =
        selectedSeasons.length > 0 ? selectedSeasons.join(",") : "";
      const tagsParam = selectedTags.length > 0 ? selectedTags.join(",") : "";

      buttons.push(
        new ButtonBuilder()
          .setCustomId(
            `request_btn|${tmdbId}|${mediaType}|${seasonsParam}|${tagsParam}`
          )
          .setLabel(requestLabel)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(mediaType === "tv" && selectedSeasons.length === 0)
      );
    }

    // Add first row with all buttons (IMDB + Letterboxd + Request)
    if (buttons.length > 0) {
      rows.push(new ActionRowBuilder().addComponents(...buttons.slice(0, 5)));
    }

    // Add season selector for TV shows (if not requested, has seasons, and seasons not yet selected)
    if (
      mediaType === "tv" &&
      details?.seasons?.length > 0 &&
      !requested &&
      selectedSeasons.length === 0
    ) {
      const seenSeasons = new Set();
      const uniqueSeasons = details.seasons.filter((s) => {
        if (s.season_number <= 0) return false;
        if (seenSeasons.has(s.season_number)) return false;
        seenSeasons.add(s.season_number);
        return true;
      });

      const tagsParam = selectedTags.length > 0 ? selectedTags.join(",") : "";

      // If we have 24 or fewer seasons, use single dropdown with "All Seasons"
      if (uniqueSeasons.length <= 24) {
        const seasonOptions = [
          { label: "All Seasons", value: "all" },
          ...uniqueSeasons.map((s) => ({
            label: `Season ${s.season_number} (${s.episode_count} episodes)`,
            value: String(s.season_number),
          })),
        ];

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId(`select_seasons|${tmdbId}|${tagsParam}`)
          .setPlaceholder("Select seasons to request...")
          .setMinValues(1)
          .setMaxValues(Math.min(25, seasonOptions.length))
          .addOptions(seasonOptions);

        rows.push(new ActionRowBuilder().addComponents(selectMenu));
      } else {
        // For shows with more than 24 seasons, split into multiple dropdowns
        // We can use up to 4 rows for seasons (leaving 1 for buttons)
        const SEASONS_PER_MENU = 24;
        const MAX_SEASON_MENUS = 4; // Maximum number of season selector rows

        // Add "All Seasons" option to first menu
        const firstBatchSeasons = uniqueSeasons.slice(0, SEASONS_PER_MENU);
        const firstMenuOptions = [
          { label: "All Seasons", value: "all" },
          ...firstBatchSeasons.map((s) => ({
            label: `Season ${s.season_number} (${s.episode_count} episodes)`,
            value: String(s.season_number),
          })),
        ];

        const firstMenu = new StringSelectMenuBuilder()
          .setCustomId(`select_seasons|${tmdbId}|${tagsParam}|0`)
          .setPlaceholder(`Seasons 1-${firstBatchSeasons[firstBatchSeasons.length - 1].season_number}`)
          .setMinValues(0)
          .setMaxValues(firstMenuOptions.length)
          .addOptions(firstMenuOptions);

        rows.push(new ActionRowBuilder().addComponents(firstMenu));

        // Add additional menus for remaining seasons
        let menuIndex = 1;
        let offset = SEASONS_PER_MENU;

        while (offset < uniqueSeasons.length && menuIndex < MAX_SEASON_MENUS) {
          const batchSeasons = uniqueSeasons.slice(offset, offset + SEASONS_PER_MENU);

          if (batchSeasons.length > 0) {
            const batchOptions = batchSeasons.map((s) => ({
              label: `Season ${s.season_number} (${s.episode_count} episodes)`,
              value: String(s.season_number),
            }));

            const batchMenu = new StringSelectMenuBuilder()
              .setCustomId(`select_seasons|${tmdbId}|${tagsParam}|${menuIndex}`)
              .setPlaceholder(
                `Seasons ${batchSeasons[0].season_number}-${batchSeasons[batchSeasons.length - 1].season_number}`
              )
              .setMinValues(0)
              .setMaxValues(batchOptions.length)
              .addOptions(batchOptions);

            rows.push(new ActionRowBuilder().addComponents(batchMenu));
          }

          offset += SEASONS_PER_MENU;
          menuIndex++;
        }

        // Log if we had to truncate seasons
        if (offset < uniqueSeasons.length) {
          logger.warn(
            `[SEASON SELECTOR] Show has ${uniqueSeasons.length} seasons, but Discord limit allows only ${offset} to be shown in ${MAX_SEASON_MENUS} menus`
          );
        }
      }
    }

    // Add tag selector for movies (if not requested and has available tags)
    // For movies, show tags row directly (no season selection needed)
    if (mediaType === "movie" && !requested && selectedTags.length === 0) {
      // Note: Tags are fetched and added dynamically when building components
      // This is a placeholder row that will be populated by the calling code
      // The actual tag options need to be fetched from Jellyseerr
      // This is handled in the search/request handlers
    }

    return rows;
  }

  // ----------------- COMMON SEARCH LOGIC -----------------
  async function handleSearchOrRequest(interaction, rawInput, mode, tags = [], options = {}) {
    // IMPORTANT: Defer reply FIRST to prevent timeout
    const isPrivateMode = process.env.PRIVATE_MESSAGE_MODE === "true";

    try {
      await interaction.deferReply({ ephemeral: isPrivateMode });
    } catch (err) {
      logger.error(`Failed to defer reply: ${err.message}`);
      return;
    }

    let tmdbId, mediaType;

    // Check if input is direct ID (format: "12345|movie")
    if (rawInput.includes("|")) {
      [tmdbId, mediaType] = rawInput.split("|");
    } else {
      // Fallback search if raw text was passed
      const results = await tmdbApi.tmdbSearch(rawInput, getTmdbApiKey());
      const found = results.filter(
        (r) => r.media_type === "movie" || r.media_type === "tv"
      );
      if (found.length) {
        tmdbId = found[0].id;
        mediaType = found[0].media_type;
      }
    }

    if (!tmdbId || !mediaType) {
      if (isPrivateMode) {
        return interaction.editReply({
          content: "⚠️ The title seems to be invalid.",
        });
      } else {
        await interaction.deleteReply();
        return interaction.followUp({
          content: "⚠️ The title seems to be invalid.",
          flags: 64,
        });
      }
    }

    try {
      const details = await tmdbApi.tmdbGetDetails(
        tmdbId,
        mediaType,
        getTmdbApiKey()
      );

      if (mode === "request") {
        // Check if media already exists in Jellyseerr
        const status = await jellyseerrApi.checkMediaStatus(
          tmdbId,
          mediaType,
          ["all"],
          getJellyseerrUrl(),
          getJellyseerrApiKey()
        );

        if (status.exists && status.available) {
          // Media already available - always ephemeral for info messages
          await interaction.editReply({
            content: "✅ This content is already available in your library!",
            components: [],
            embeds: [],
          });
          if (isPrivateMode) {
            await interaction.editReply({
              content: "✅ This content is already available in your library!",
              components: [],
              embeds: [],
            });
          } else {
            // Delete public message and send ephemeral info
            await interaction.deleteReply();
            await interaction.followUp({
              content: "✅ This content is already available in your library!",
              flags: 64,
            });
          }
          return;
        }

        // Convert tag labels to IDs if tags were provided
        let tagIds = [];
        if (tags && tags.length > 0) {
          try {
            const allTags = await jellyseerrApi.fetchTags(
              getJellyseerrUrl(),
              getJellyseerrApiKey()
            );
            // Filter to appropriate type (Sonarr for TV, Radarr for movies)
            // Add defensive check to ensure allTags is an array
            const relevantTags = Array.isArray(allTags)
              ? allTags.filter((tag) =>
                mediaType === "tv" ? tag.type === "sonarr" : tag.type === "radarr"
              )
              : [];

            // Map tag labels to IDs
            tagIds = tags
              .map((tagLabel) => {
                const tag = relevantTags.find(
                  (t) => (t.label || t.name) === tagLabel
                );
                return tag ? tag.id : null;
              })
              .filter((id) => id !== null);

            logger.debug(
              `Converted tag labels ${tags.join(", ")} to IDs: ${tagIds.join(
                ", "
              )}`
            );
          } catch (err) {
            logger.warn("Failed to convert tag labels to IDs:", err?.message);
          }
        }

        // Parse quality and server
        const { profileId, serverId } = parseQualityAndServerOptions(options, mediaType);

        // Resolve "all" seasons to explicit list of season numbers (workaround for empty array issue)
        let seasonsToRequest = ["all"];
        if (mediaType === "tv" && details.seasons) {
          const seasonNumbers = details.seasons
            .filter((s) => s.season_number > 0)
            .map((s) => s.season_number);

          if (seasonNumbers.length > 0) {
            seasonsToRequest = seasonNumbers;
            logger.info(`[REQUEST] Resolved 'all' seasons to explicit list: ${seasonsToRequest.join(", ")}`);
          }
        }

        await jellyseerrApi.sendRequest({
          tmdbId,
          mediaType,
          seasons: seasonsToRequest,
          tags: tagIds,
          profileId,
          serverId,
          jellyseerrUrl: getJellyseerrUrl(),
          apiKey: getJellyseerrApiKey(),
          discordUserId: interaction.user.id,
          userMappings: getUserMappings(),
          isAutoApproved: getJellyseerrAutoApprove(),
        });
        logger.info(`[REQUEST] Discord User ${interaction.user.id} requested ${mediaType} ${tmdbId}. Auto-Approve: ${getJellyseerrAutoApprove()}`);

        // Track request for notifications if enabled
        if (process.env.NOTIFY_ON_AVAILABLE === "true") {
          const requestKey = `${tmdbId}-${mediaType}`;
          if (!pendingRequests.has(requestKey)) {
            pendingRequests.set(requestKey, new Set());
          }
          pendingRequests.get(requestKey).add(interaction.user.id);
          savePendingRequests();
        }
      }

      const imdbId = await tmdbApi.tmdbGetExternalImdb(
        tmdbId,
        mediaType,
        getTmdbApiKey()
      );

      const omdb = imdbId ? await fetchOMDbData(imdbId) : null;

      const embed = buildNotificationEmbed(
        details,
        mediaType,
        imdbId,
        mode === "request" ? "success" : "search",
        omdb,
        tmdbId
      );

      const components = buildButtons(
        tmdbId,
        imdbId,
        mode === "request",
        mediaType,
        details
      );

      // Add tag selector for movies (if in search mode and not already requested)
      if (mediaType === "movie" && mode === "search") {
        try {
          const allTags = await jellyseerrApi.fetchTags(
            getJellyseerrUrl(),
            getJellyseerrApiKey()
          );

          // Filter to only Radarr tags for movies
          // Add defensive check to ensure allTags is an array
          const radarrTags = Array.isArray(allTags)
            ? allTags.filter((tag) => tag.type === "radarr")
            : [];

          if (radarrTags && radarrTags.length > 0) {
            // Deduplicate tags by ID
            const uniqueTags = [];
            const seenIds = new Set();

            for (const tag of radarrTags) {
              if (!seenIds.has(tag.id)) {
                seenIds.add(tag.id);
                uniqueTags.push(tag);
              }
            }

            const tagOptions = uniqueTags.slice(0, 25).map((tag) => ({
              label: tag.label || tag.name || `Tag ${tag.id}`,
              value: tag.id.toString(),
            }));

            const tagMenu = new StringSelectMenuBuilder()
              .setCustomId(`select_tags|${tmdbId}|`)
              .setPlaceholder("Select tags (optional)")
              .addOptions(tagOptions)
              .setMinValues(0)
              .setMaxValues(Math.min(5, tagOptions.length));

            const tagRow = new ActionRowBuilder().addComponents(tagMenu);
            components.push(tagRow);
          }
        } catch (err) {
          logger.debug(
            "Failed to fetch tags for movie tag selector:",
            err?.message
          );
          // Continue without tag selector if fetch fails
        }
      }

      // Success - just edit the original reply directly (already public or ephemeral based on mode)
      await interaction.editReply({ embeds: [embed], components });
    } catch (err) {
      logger.error("Error in handleSearchOrRequest:", err);

      // Extract a user-friendly error message if possible
      let errorMessage = "⚠️ An error occurred.";
      if (err.response && err.response.data && err.response.data.message) {
        errorMessage = `⚠️ Jellyseerr error: ${err.response.data.message}`;
      } else if (err.message) {
        // Special handling for quota errors or other common ones
        if (err.message.includes("403")) {
          errorMessage = "⚠️ Request failed: You might have exceeded your quota or don't have permission.";
        } else {
          errorMessage = `⚠️ Error: ${err.message}`;
        }
      }

      // Error messages should always be ephemeral
      if (isPrivateMode) {
        // Already ephemeral, just edit
        await interaction.editReply({
          content: errorMessage,
          components: [],
          embeds: [],
        });
      } else {
        // Was public, delete and send ephemeral error
        try {
          await interaction.deleteReply();
        } catch (e) {
          // Ignore delete errors if it was already deleted
        }
        await interaction.followUp({
          content: errorMessage,
          flags: 64,
        });
      }
    }
  }

  // ----------------- REGISTER COMMANDS -----------------
  // Înregistrează comenzile global sau guild-specific
  logger.debug(
    `[REGISTER COMMANDS] Attempting to register commands for BOT_ID: ${BOT_ID}`
  );
  logger.debug(
    `[REGISTER COMMANDS] DISCORD_TOKEN available: ${!!process.env
      .DISCORD_TOKEN}`
  );
  logger.debug(
    `[REGISTER COMMANDS] DISCORD_TOKEN value: ${process.env.DISCORD_TOKEN
      ? process.env.DISCORD_TOKEN.slice(0, 10) + "..."
      : "UNDEFINED"
    }`
  );

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  logger.debug(`[REGISTER COMMANDS] REST token set: ${!!rest.token}`);
  logger.debug(
    `[REGISTER COMMANDS] REST token value: ${rest.token ? rest.token.slice(0, 10) + "..." : "UNDEFINED"
    }`
  );

  try {
    await registerCommands(rest, BOT_ID, GUILD_ID, logger);
  } catch (err) {
    logger.error(
      `[REGISTER COMMANDS] Failed to register Discord commands:`,
      err
    );
    throw new Error(`Failed to register Discord commands: ${err.message}`);
  }

  // ----------------- EVENTS -----------------

  // Helper function to check if user has permission based on role allowlist/blocklist
  function checkRolePermission(member) {
    if (!member || !member.roles) return true; // No member info, allow

    const allowlist = process.env.ROLE_ALLOWLIST
      ? JSON.parse(process.env.ROLE_ALLOWLIST)
      : [];
    const blocklist = process.env.ROLE_BLOCKLIST
      ? JSON.parse(process.env.ROLE_BLOCKLIST)
      : [];

    const userRoles = member.roles.cache.map((r) => r.id);

    // If allowlist exists and user doesn't have any of those roles, deny
    if (allowlist.length > 0 && !userRoles.some((r) => allowlist.includes(r))) {
      return false;
    }

    // If user has any blocklisted role, deny
    if (blocklist.length > 0 && userRoles.some((r) => blocklist.includes(r))) {
      return false;
    }

    return true;
  }

  client.on("interactionCreate", async (interaction) => {
    try {
      // Check role permissions for all commands
      if (
        interaction.isCommand() ||
        (interaction.isStringSelectMenu() &&
          !interaction.customId.startsWith("request_seasons|") &&
          !interaction.customId.startsWith("request_with_tags|"))
      ) {
        if (!checkRolePermission(interaction.member)) {
          return interaction.reply({
            content: "❌ You don't have permission to use this command.",
            flags: 64,
          });
        }
      }

      // Autocomplete
      if (interaction.isAutocomplete()) {
        const focusedOption = interaction.options.getFocused(true);
        const focusedValue = focusedOption.value;

        // Handle Tag Autocomplete
        if (focusedOption.name === "tag") {
          try {
            const allTags = await jellyseerrApi.fetchTags(
              getJellyseerrUrl(),
              getJellyseerrApiKey()
            );

            // Filter tags based on user input
            // Add defensive check to ensure allTags is an array
            const filteredTags = Array.isArray(allTags)
              ? allTags.filter((tag) => {
                const label = tag.label || tag.name || "";
                return label.toLowerCase().includes(focusedValue.toLowerCase());
              })
              : [];

            // Deduplicate by label/name
            const uniqueTags = [];
            const seenLabels = new Set();

            for (const tag of filteredTags) {
              const label = tag.label || tag.name;
              if (label && !seenLabels.has(label)) {
                seenLabels.add(label);
                uniqueTags.push({
                  name: label,
                  value: label, // Pass the label as value, we'll map it to ID later
                });
              }
            }

            // Limit to 25 choices (Discord limit)
            return await interaction.respond(uniqueTags.slice(0, 25));
          } catch (e) {
            logger.error("Tag autocomplete error:", e);
            return await interaction.respond([]);
          }
        }

        // Handle Quality Profile Autocomplete
        if (focusedOption.name === "quality") {
          try {
            // Determine media type from title
            const titleOption = interaction.options.getString("title");
            let mediaType = null;

            if (titleOption && titleOption.includes("|")) {
              const parts = titleOption.split("|");
              mediaType = parts[1]; // "movie" or "tv"
            }

            // Get selected server to filter by specific server
            const serverOption = interaction.options.getString("server");
            let selectedServerId = null;

            if (serverOption && serverOption.includes("|")) {
              const parts = serverOption.split("|");
              const parsedServerId = parseInt(parts[0], 10); // serverId

              if (!isNaN(parsedServerId)) {
                selectedServerId = parsedServerId;
              } else {
                logger.warn(`Invalid server option in autocomplete - non-numeric serverId: ${parts[0]}`);
              }
            }

            const allProfiles = await jellyseerrApi.fetchQualityProfiles(
              getJellyseerrUrl(),
              getJellyseerrApiKey()
            );

            // Filter profiles based on user input, media type, AND selected server
            const filteredProfiles = allProfiles.filter((profile) => {
              const name = profile.name || "";
              const matchesSearch = name.toLowerCase().includes(focusedValue.toLowerCase());

              // Filter by media type if title is selected
              let matchesType = true;
              if (mediaType) {
                matchesType =
                  (mediaType === "movie" && profile.type === "radarr") ||
                  (mediaType === "tv" && profile.type === "sonarr");
              }

              // Filter by server if server is selected
              let matchesServer = true;
              if (selectedServerId !== null) {
                matchesServer = profile.serverId === selectedServerId;
              }

              return matchesSearch && matchesType && matchesServer;
            });

            // Deduplicate by name + server
            const uniqueProfiles = [];
            const seenNames = new Set();

            for (const profile of filteredProfiles) {
              const displayName = `${profile.name} (${profile.serverName})`;
              const key = `${profile.id}-${profile.serverId}`;
              if (!seenNames.has(key)) {
                seenNames.add(key);
                uniqueProfiles.push({
                  name: displayName.length > 100 ? displayName.substring(0, 97) + "..." : displayName,
                  value: `${profile.id}|${profile.serverId}|${profile.type}`, // profileId|serverId|type
                });
              }
            }

            // Limit to 25
            return await interaction.respond(uniqueProfiles.slice(0, 25));
          } catch (e) {
            logger.error("Quality profile autocomplete error:", e);
            return await interaction.respond([]);
          }
        }

        // Server Autocomplete
        if (focusedOption.name === "server") {
          try {
            // Determine media type from title
            const titleOption = interaction.options.getString("title");
            let mediaType = null;

            if (titleOption && titleOption.includes("|")) {
              const parts = titleOption.split("|");
              mediaType = parts[1]; // "movie" or "tv"
            }

            const allServers = await jellyseerrApi.fetchServers(
              getJellyseerrUrl(),
              getJellyseerrApiKey()
            );

            // Filter servers based on input AND media type
            const filteredServers = allServers.filter((server) => {
              const name = server.name || "";
              const matchesSearch = name.toLowerCase().includes(focusedValue.toLowerCase());

              // If media type known, filter
              if (mediaType) {
                const matchesType =
                  (mediaType === "movie" && server.type === "radarr") ||
                  (mediaType === "tv" && server.type === "sonarr");
                return matchesSearch && matchesType;
              }

              return matchesSearch;
            });

            // Response with server type
            const serverChoices = filteredServers.map((server) => {
              const typeEmoji = server.type === "radarr" ? "🎬" : "📺";
              const displayName = `${typeEmoji} ${server.name}${server.isDefault ? " (default)" : ""}`;
              return {
                name: displayName.length > 100 ? displayName.substring(0, 97) + "..." : displayName,
                value: `${server.id}|${server.type}`, // serverId|type
              };
            });

            // Limit to 25
            return await interaction.respond(serverChoices.slice(0, 25));
          } catch (e) {
            logger.error("Server autocomplete error:", e);
            return await interaction.respond([]);
          }
        }

        // Handle Title Autocomplete
        // For trending command, show trending content instead of search results
        if (interaction.commandName === "trending") {
          try {
            const trendingResults = await tmdbApi.tmdbGetTrending(getTmdbApiKey());
            const filtered = trendingResults
              .filter((r) => r.media_type === "movie" || r.media_type === "tv")
              .filter((r) => {
                const title = r.title || r.name || "";
                return title.toLowerCase().includes(focusedValue.toLowerCase());
              })
              .slice(0, 25);

            const trendingChoices = await Promise.all(
              filtered.map(async (item) => {
                try {
                  const details = await tmdbApi.tmdbGetDetails(
                    item.id,
                    item.media_type,
                    getTmdbApiKey()
                  );

                  const emoji = item.media_type === "movie" ? "🎬" : "📺";
                  const date = item.release_date || item.first_air_date || "";
                  const year = date ? ` (${date.slice(0, 4)})` : "";

                  let extraInfo = "";
                  if (item.media_type === "movie") {
                    const director = details.credits?.crew?.find(
                      (c) => c.job === "Director"
                    );
                    const directorName = director ? director.name : null;
                    const runtime = details.runtime;
                    const hours = runtime ? Math.floor(runtime / 60) : 0;
                    const minutes = runtime ? runtime % 60 : 0;
                    const runtimeStr = runtime ? `${hours}h ${minutes}m` : null;

                    if (directorName && runtimeStr) {
                      extraInfo = ` — directed by ${directorName} — runtime: ${runtimeStr}`;
                    } else if (directorName) {
                      extraInfo = ` — directed by ${directorName}`;
                    } else if (runtimeStr) {
                      extraInfo = ` — runtime: ${runtimeStr}`;
                    }
                  } else {
                    const creator = details.created_by?.[0]?.name;
                    const seasonCount = details.number_of_seasons;
                    const seasonStr = seasonCount
                      ? `${seasonCount} season${seasonCount > 1 ? "s" : ""}`
                      : null;

                    if (creator && seasonStr) {
                      extraInfo = ` — created by ${creator} — ${seasonStr}`;
                    } else if (creator) {
                      extraInfo = ` — created by ${creator}`;
                    } else if (seasonStr) {
                      extraInfo = ` — ${seasonStr}`;
                    }
                  }

                  let fullName = `${emoji} ${item.title || item.name
                    }${year}${extraInfo}`;

                  if (fullName.length > 98) {
                    fullName = fullName.substring(0, 95) + "...";
                  }

                  return {
                    name: fullName,
                    value: `${item.id}|${item.media_type}`,
                  };
                } catch (err) {
                  const emoji = item.media_type === "movie" ? "🎬" : "📺";
                  const date = item.release_date || item.first_air_date || "";
                  const year = date ? ` (${date.slice(0, 4)})` : "";
                  let basicName = `${emoji} ${item.title || item.name}${year}`;
                  if (basicName.length > 98) {
                    basicName = basicName.substring(0, 95) + "...";
                  }
                  return {
                    name: basicName,
                    value: `${item.id}|${item.media_type}`,
                  };
                }
              })
            );

            await interaction.respond(trendingChoices);
            return;
          } catch (e) {
            logger.error("Trending autocomplete error:", e);
            return interaction.respond([]);
          }
        }

        // Handle regular search autocomplete (existing logic)
        if (!focusedValue) return interaction.respond([]);

        try {
          const results = await tmdbApi.tmdbSearch(focusedValue, getTmdbApiKey());
          const filtered = results
            .filter((r) => r.media_type === "movie" || r.media_type === "tv")
            .slice(0, 25);

          // Fetch details for each result to get director/creator and runtime/seasons
          const detailedChoices = await Promise.all(
            filtered.map(async (item) => {
              try {
                const details = await tmdbApi.tmdbGetDetails(
                  item.id,
                  item.media_type,
                  getTmdbApiKey()
                );

                const emoji = item.media_type === "movie" ? "🎬" : "📺";
                const date = item.release_date || item.first_air_date || "";
                const year = date ? ` (${date.slice(0, 4)})` : "";

                let extraInfo = "";
                if (item.media_type === "movie") {
                  // Get director from credits
                  const director = details.credits?.crew?.find(
                    (c) => c.job === "Director"
                  );
                  const directorName = director ? director.name : null;

                  // Get runtime
                  const runtime = details.runtime;
                  const hours = runtime ? Math.floor(runtime / 60) : 0;
                  const minutes = runtime ? runtime % 60 : 0;
                  const runtimeStr = runtime ? `${hours}h ${minutes}m` : null;

                  if (directorName && runtimeStr) {
                    extraInfo = ` — directed by ${directorName} — runtime: ${runtimeStr}`;
                  } else if (directorName) {
                    extraInfo = ` — directed by ${directorName}`;
                  } else if (runtimeStr) {
                    extraInfo = ` — runtime: ${runtimeStr}`;
                  }
                } else {
                  // TV show - get creator and season count
                  const creator = details.created_by?.[0]?.name;
                  const seasonCount = details.number_of_seasons;
                  const seasonStr = seasonCount
                    ? `${seasonCount} season${seasonCount > 1 ? "s" : ""}`
                    : null;

                  if (creator && seasonStr) {
                    extraInfo = ` — created by ${creator} — ${seasonStr}`;
                  } else if (creator) {
                    extraInfo = ` — created by ${creator}`;
                  } else if (seasonStr) {
                    extraInfo = ` — ${seasonStr}`;
                  }
                }

                let fullName = `${emoji} ${item.title || item.name
                  }${year}${extraInfo}`;

                // Truncate if too long (Discord limit is 100 chars)
                if (fullName.length > 98) {
                  fullName = fullName.substring(0, 95) + "...";
                }

                return {
                  name: fullName,
                  value: `${item.id}|${item.media_type}`,
                };
              } catch (err) {
                // Fallback to basic info if details fetch fails
                logger.debug(
                  `Failed to fetch details for ${item.id}:`,
                  err?.message
                );
                const emoji = item.media_type === "movie" ? "🎬" : "📺";
                const date = item.release_date || item.first_air_date || "";
                const year = date ? ` (${date.slice(0, 4)})` : "";
                let basicName = `${emoji} ${item.title || item.name}${year}`;
                if (basicName.length > 98) {
                  basicName = basicName.substring(0, 95) + "...";
                }
                return {
                  name: basicName,
                  value: `${item.id}|${item.media_type}`,
                };
              }
            })
          );

          await interaction.respond(detailedChoices);
        } catch (e) {
          logger.error("Autocomplete error:", e);
          return await interaction.respond([]);
        }
      }

      // Commands
      if (interaction.isCommand()) {
        // Check if the required configs for commands are present
        if (!getJellyseerrUrl() || !getJellyseerrApiKey() || !getTmdbApiKey()) {
          return interaction.reply({
            content:
              "⚠️ This command is disabled because Jellyseerr or TMDB configuration is missing.",
            flags: 64,
          });
        }
        const raw = getOptionStringRobust(interaction);
        if (interaction.commandName === "search")
          return handleSearchOrRequest(interaction, raw, "search");
        if (interaction.commandName === "request") {
          const tag = interaction.options.getString("tag");
          const quality = interaction.options.getString("quality");
          const server = interaction.options.getString("server");
          // Pass tag as an array if present, and quality/server options
          return handleSearchOrRequest(
            interaction,
            raw,
            "request",
            tag ? [tag] : [],
            { quality, server }
          );
        }
        if (interaction.commandName === "trending") {
          return handleSearchOrRequest(interaction, raw, "search");
        }
      }

      // ===== REQUEST BUTTON HANDLER (NEW FLOW) =====
      // customId format: request_btn|tmdbId|mediaType|seasonsParam|tagsParam
      if (
        interaction.isButton() &&
        interaction.customId.startsWith("request_btn|")
      ) {
        const parts = interaction.customId.split("|");
        const tmdbId = parseInt(parts[1], 10);
        const mediaType = parts[2] || "movie";
        const seasonsParam = parts[3] || "";
        const tagsParam = parts[4] || "";

        if (!tmdbId) {
          return interaction.reply({ content: "⚠️ ID invalid.", flags: 64 });
        }

        await interaction.deferUpdate();

        try {
          const details = await tmdbApi.tmdbGetDetails(
            tmdbId,
            mediaType,
            getTmdbApiKey()
          );

          // Parse seasons and tags from customId
          const selectedSeasons = seasonsParam ? seasonsParam.split(",") : [];
          const selectedTagNames = tagsParam ? tagsParam.split(",") : []; // Convert tag names to IDs for API call
          let selectedTagIds = [];
          if (selectedTagNames.length > 0) {
            try {
              const allTags = await jellyseerrApi.fetchTags(
                getJellyseerrUrl(),
                getJellyseerrApiKey()
              );

              // Filter by type: Radarr for movies, Sonarr for TV
              // Add defensive check to ensure allTags is an array
              const filteredTags = Array.isArray(allTags)
                ? (mediaType === "movie"
                  ? allTags.filter((tag) => tag.type === "radarr")
                  : allTags.filter((tag) => tag.type === "sonarr"))
                : [];

              selectedTagIds = selectedTagNames
                .map((tagName) => {
                  const tag = filteredTags.find(
                    (t) => (t.label || t.name) === tagName
                  );
                  return tag ? tag.id : null;
                })
                .filter((id) => id !== null);
            } catch (err) {
              logger.debug("Failed to fetch tags for API call:", err?.message);
              // Continue without tags if fetch fails
            }
          }

          // Check if media already exists in Jellyseerr
          // For movies: use ["all"], for TV: use selected seasons or ["all"]
          const checkSeasons =
            mediaType === "movie"
              ? ["all"]
              : selectedSeasons.length > 0
                ? selectedSeasons
                : ["all"];
          const status = await jellyseerrApi.checkMediaStatus(
            tmdbId,
            mediaType,
            checkSeasons,
            getJellyseerrUrl(),
            getJellyseerrApiKey()
          );

          if (status.exists && status.available) {
            // Media already available
            await interaction.followUp({
              content: "✅ This content is already available in your library!",
              flags: 64,
            });
            return;
          }

          // Send the request with selected seasons and tags
          // For movies: don't send seasons, for TV: send selected or default to "all"
          let seasonsToRequest =
            mediaType === "movie"
              ? undefined
              : selectedSeasons.length > 0
                ? selectedSeasons
                : ["all"];

          // Resolve "all" to explicit season numbers if needed
          if (mediaType === "tv" && (seasonsToRequest.includes("all") || (Array.isArray(seasonsToRequest) && seasonsToRequest[0] === "all"))) {
            if (details.seasons) {
              const seasonNumbers = details.seasons
                .filter((s) => s.season_number > 0)
                .map((s) => s.season_number);
              if (seasonNumbers.length > 0) {
                seasonsToRequest = seasonNumbers;
                logger.info(`[REQUEST BTN] Resolved 'all' seasons to explicit list: ${seasonsToRequest.join(", ")}`);
              }
            }
          }

          // Apply defaults from config
          const { profileId, serverId } = parseQualityAndServerOptions({}, mediaType);

          await jellyseerrApi.sendRequest({
            tmdbId,
            mediaType,
            seasons: seasonsToRequest,
            tags: selectedTagIds.length > 0 ? selectedTagIds : undefined,
            profileId,
            serverId,
            jellyseerrUrl: getJellyseerrUrl(),
            apiKey: getJellyseerrApiKey(),
            discordUserId: interaction.user.id,
            userMappings: getUserMappings(),
            isAutoApproved: getJellyseerrAutoApprove(),
          });
          logger.info(`[REQUEST] Discord User ${interaction.user.id} requested ${mediaType} ${tmdbId}. Auto-Approve: ${getJellyseerrAutoApprove()}`);
          logger.info(`[REQUEST] Discord User ${interaction.user.id} requested ${mediaType} ${tmdbId}. Auto-Approve: ${getJellyseerrAutoApprove()}`);

          // Track request for notifications if enabled
          if (process.env.NOTIFY_ON_AVAILABLE === "true") {
            const requestKey = `${tmdbId}-${mediaType}`;
            if (!pendingRequests.has(requestKey)) {
              pendingRequests.set(requestKey, new Set());
            }
            pendingRequests.get(requestKey).add(interaction.user.id);
            savePendingRequests();
          }

          const imdbId = await tmdbApi.tmdbGetExternalImdb(
            tmdbId,
            mediaType,
            getTmdbApiKey()
          );
          const omdb = imdbId ? await fetchOMDbData(imdbId) : null;

          const embed = buildNotificationEmbed(
            details,
            mediaType,
            imdbId,
            "success",
            omdb,
            tmdbId
          );

          // Build final buttons with requested seasons and tag names (for display)
          const components = buildButtons(
            tmdbId,
            imdbId,
            true,
            mediaType,
            details,
            selectedSeasons.length > 0 ? selectedSeasons : ["all"],
            selectedTagNames
          );

          // Success message - always edit the original message
          await interaction.editReply({ embeds: [embed], components });
        } catch (err) {
          logger.error("Button request error:", err);
          try {
            await interaction.followUp({
              content: "⚠️ I could not send the request.",
              flags: 64,
            });
          } catch (followUpErr) {
            logger.error("Failed to send follow-up message:", followUpErr);
          }
        }
      }

      // ===== SELECT SEASONS HANDLER (UPDATED FOR MULTIPLE DROPDOWNS) =====
      // customId format: select_seasons|tmdbId|selectedTagsParam|menuIndex
      if (
        interaction.isStringSelectMenu() &&
        interaction.customId.startsWith("select_seasons|")
      ) {
        const parts = interaction.customId.split("|");
        const tmdbId = parseInt(parts[1], 10);
        const selectedTagsParam = parts[2] || "";
        const menuIndex = parts[3] ? parseInt(parts[3], 10) : undefined;
        const currentSelections = interaction.values;

        if (!tmdbId) {
          return interaction.reply({
            content: "⚠️ Invalid selection.",
            flags: 64,
          });
        }

        await interaction.deferUpdate();

        try {
          // Parse existing tags from customId if any
          const selectedTags = selectedTagsParam
            ? selectedTagsParam.split(",")
            : [];

          // Get TMDB details for rebuilding components
          const details = await tmdbApi.tmdbGetDetails(
            tmdbId,
            "tv",
            getTmdbApiKey()
          );
          const imdbId = await tmdbApi.tmdbGetExternalImdb(
            tmdbId,
            "tv",
            getTmdbApiKey()
          );

          // Extract all previously selected seasons from existing message components
          let allSelectedSeasons = [];

          // Check if "all" was selected in current interaction
          if (currentSelections.includes("all")) {
            allSelectedSeasons = ["all"];
          } else {
            // Accumulate selections from all season dropdowns in the message
            const existingComponents = interaction.message.components || [];

            for (const row of existingComponents) {
              for (const component of row.components) {
                // Check if this is a season selector
                if (component.customId && component.customId.startsWith("select_seasons|")) {
                  const componentParts = component.customId.split("|");
                  const componentMenuIndex = componentParts[3] ? parseInt(componentParts[3], 10) : undefined;

                  // If this is the current menu being interacted with, use current selections
                  if (componentMenuIndex === menuIndex || (componentMenuIndex === undefined && menuIndex === undefined)) {
                    allSelectedSeasons.push(...currentSelections.filter(v => v !== "all"));
                  } else {
                    // Otherwise, preserve existing selections from this menu
                    const existingSelections = component.options
                      ?.filter(opt => opt.default)
                      .map(opt => opt.value)
                      .filter(v => v !== "all") || [];
                    allSelectedSeasons.push(...existingSelections);
                  }
                }
              }
            }

            // Remove duplicates
            allSelectedSeasons = [...new Set(allSelectedSeasons)];
          }

          // Build updated components with accumulated season selections
          const components = buildButtons(
            tmdbId,
            imdbId,
            false,
            "tv",
            details,
            [],
            [],
            allSelectedSeasons,
            selectedTags
          );

          // Rebuild season selectors with updated selections
          const seenSeasons = new Set();
          const uniqueSeasons = details.seasons.filter((s) => {
            if (s.season_number <= 0) return false;
            if (seenSeasons.has(s.season_number)) return false;
            seenSeasons.add(s.season_number);
            return true;
          });

          const tagsParam = selectedTags.length > 0 ? selectedTags.join(",") : "";
          const hasAllSeasons = allSelectedSeasons.includes("all");

          // Recreate season dropdowns with current selections
          if (uniqueSeasons.length <= 24) {
            // Single dropdown
            const seasonOptions = [
              { label: "All Seasons", value: "all" },
              ...uniqueSeasons.map((s) => ({
                label: `Season ${s.season_number} (${s.episode_count} episodes)`,
                value: String(s.season_number),
              })),
            ];

            const selectMenu = new StringSelectMenuBuilder()
              .setCustomId(`select_seasons|${tmdbId}|${tagsParam}`)
              .setPlaceholder("Select seasons to request...")
              .setMinValues(1)
              .setMaxValues(Math.min(25, seasonOptions.length))
              .addOptions(seasonOptions);

            components.push(new ActionRowBuilder().addComponents(selectMenu));
          } else {
            // Multiple dropdowns
            const SEASONS_PER_MENU = 24;
            const MAX_SEASON_MENUS = 4;

            const firstBatchSeasons = uniqueSeasons.slice(0, SEASONS_PER_MENU);
            const firstMenuOptions = [
              { label: "All Seasons", value: "all" },
              ...firstBatchSeasons.map((s) => ({
                label: `Season ${s.season_number} (${s.episode_count} episodes)`,
                value: String(s.season_number),
              })),
            ];

            const firstMenu = new StringSelectMenuBuilder()
              .setCustomId(`select_seasons|${tmdbId}|${tagsParam}|0`)
              .setPlaceholder(`Seasons 1-${firstBatchSeasons[firstBatchSeasons.length - 1].season_number}`)
              .setMinValues(0)
              .setMaxValues(firstMenuOptions.length)
              .addOptions(firstMenuOptions);

            components.push(new ActionRowBuilder().addComponents(firstMenu));

            let menuIdx = 1;
            let offset = SEASONS_PER_MENU;

            while (offset < uniqueSeasons.length && menuIdx < MAX_SEASON_MENUS) {
              const batchSeasons = uniqueSeasons.slice(offset, offset + SEASONS_PER_MENU);

              if (batchSeasons.length > 0) {
                const batchOptions = batchSeasons.map((s) => ({
                  label: `Season ${s.season_number} (${s.episode_count} episodes)`,
                  value: String(s.season_number),
                }));

                const batchMenu = new StringSelectMenuBuilder()
                  .setCustomId(`select_seasons|${tmdbId}|${tagsParam}|${menuIdx}`)
                  .setPlaceholder(
                    `Seasons ${batchSeasons[0].season_number}-${batchSeasons[batchSeasons.length - 1].season_number}`
                  )
                  .setMinValues(0)
                  .setMaxValues(batchOptions.length)
                  .addOptions(batchOptions);

                components.push(new ActionRowBuilder().addComponents(batchMenu));
              }

              offset += SEASONS_PER_MENU;
              menuIdx++;
            }
          }

          // Fetch available tags for tag selector (only if not already selected and not all seasons)
          if (selectedTags.length === 0 && !hasAllSeasons) {
            try {
              const tags = await jellyseerrApi.fetchTags(
                getJellyseerrUrl(),
                getJellyseerrApiKey()
              );

              if (tags && tags.length > 0) {
                const uniqueTags = [];
                const seenIds = new Set();

                for (const tag of tags) {
                  if (!seenIds.has(tag.id)) {
                    seenIds.add(tag.id);
                    uniqueTags.push(tag);
                  }
                }

                const tagOptions = uniqueTags.slice(0, 25).map((tag) => ({
                  label: tag.label || tag.name || `Tag ${tag.id}`,
                  value: tag.id.toString(),
                }));

                const tagMenu = new StringSelectMenuBuilder()
                  .setCustomId(`select_tags|${tmdbId}|${allSelectedSeasons.join(",")}`)
                  .setPlaceholder("Select tags (optional)")
                  .addOptions(tagOptions)
                  .setMinValues(0)
                  .setMaxValues(Math.min(5, tagOptions.length));

                const tagRow = new ActionRowBuilder().addComponents(tagMenu);
                components.push(tagRow);
              }
            } catch (err) {
              logger.debug("Failed to fetch tags for season selector:", err?.message);
            }
          }

          await interaction.editReply({
            components,
          });
        } catch (err) {
          logger.error("Season selection error:", err);
          try {
            await interaction.followUp({
              content: "⚠️ Error processing season selection.",
              flags: 64,
            });
          } catch (followUpErr) {
            logger.error("Failed to send follow-up message:", followUpErr);
          }
        }
      }

      if (
        interaction.isButton() &&
        interaction.customId.startsWith("requested|")
      ) {
        try {
          await interaction.reply({
            content: "This item was already requested.",
            flags: 64,
          });
        } catch (replyErr) {
          logger.error("Failed to send 'already requested' reply:", replyErr);
        }
      }

      // ===== DAILY RANDOM PICK REQUEST BUTTON HANDLER =====
      // customId format: request_random_tmdbId_mediaType
      if (
        interaction.isButton() &&
        interaction.customId.startsWith("request_random_")
      ) {
        const parts = interaction.customId.split("_");
        const tmdbId = parseInt(parts[2], 10);
        const mediaType = parts[3] || "movie";

        if (!tmdbId) {
          return interaction.reply({ content: "⚠️ Invalid media ID.", flags: 64 });
        }

        await interaction.deferUpdate();

        try {
          const details = await tmdbApi.tmdbGetDetails(
            tmdbId,
            mediaType,
            getTmdbApiKey()
          );

          const { profileId, serverId } = parseQualityAndServerOptions({}, mediaType);

          await jellyseerrApi.sendRequest({
            tmdbId,
            mediaType,
            seasons: mediaType === "tv" ? ["all"] : undefined,
            profileId,
            serverId,
            jellyseerrUrl: getJellyseerrUrl(),
            apiKey: getJellyseerrApiKey(),
            discordUserId: interaction.user.id,
            userMappings: getUserMappings(),
            isAutoApproved: getJellyseerrAutoApprove(),
          });

          // Track request for notifications
          if (process.env.NOTIFY_ON_AVAILABLE === "true") {
            const requestKey = `${tmdbId}-${mediaType}`;
            if (!pendingRequests.has(requestKey)) {
              pendingRequests.set(requestKey, new Set());
            }
            pendingRequests.get(requestKey).add(interaction.user.id);
            savePendingRequests();
          }

          await interaction.followUp({
            content: `✅ **${details.title || details.name}** has been requested!`,
            flags: 64,
          });
        } catch (err) {
          logger.error("Daily random pick request error:", err);
          await interaction.followUp({
            content: "⚠️ Error processing request.",
            flags: 64,
          });
        }
      }

      // ===== SELECT TAGS HANDLER (NEW FLOW) =====
      // customId format: select_tags|tmdbId|selectedSeasonsParam (for TV) or select_tags|tmdbId| (for movies)
      // This handler only updates the buttons with tag selection - does NOT send the request
      if (
        interaction.isStringSelectMenu() &&
        interaction.customId.startsWith("select_tags|")
      ) {
        const parts = interaction.customId.split("|");
        const tmdbId = parseInt(parts[1], 10);
        const selectedSeasonsParam = parts[2] || "";
        const selectedSeasons = selectedSeasonsParam
          ? selectedSeasonsParam.split(",")
          : [];
        const selectedTagIds = interaction.values.map((v) => v.toString());

        if (!tmdbId) {
          return interaction.reply({
            content: "⚠️ Invalid request data.",
            flags: 64,
          });
        }

        await interaction.deferUpdate();

        try {
          // Determine if this is for TV or movie based on presence of seasons
          const mediaType = selectedSeasons.length > 0 ? "tv" : "movie";

          // Get TMDB details for building updated buttons
          const details = await tmdbApi.tmdbGetDetails(
            tmdbId,
            mediaType,
            getTmdbApiKey()
          );
          const imdbId = await tmdbApi.tmdbGetExternalImdb(
            tmdbId,
            mediaType,
            getTmdbApiKey()
          );

          // Fetch all tags to map IDs to names
          let selectedTagNames = [];
          if (selectedTagIds.length > 0) {
            try {
              const allTags = await jellyseerrApi.fetchTags(
                getJellyseerrUrl(),
                getJellyseerrApiKey()
              );

              // Filter by type: Radarr for movies, Sonarr for TV
              // Add defensive check to ensure allTags is an array
              const filteredTags = Array.isArray(allTags)
                ? (mediaType === "movie"
                  ? allTags.filter((tag) => tag.type === "radarr")
                  : allTags.filter((tag) => tag.type === "sonarr"))
                : [];

              selectedTagNames = selectedTagIds
                .map((tagId) => {
                  const tag = filteredTags.find(
                    (t) => t.id.toString() === tagId
                  );
                  return tag ? tag.label || tag.name : null;
                })
                .filter((name) => name !== null);
            } catch (err) {
              logger.debug("Failed to fetch tag names:", err?.message);
              // Continue with tag IDs if names can't be fetched
              selectedTagNames = selectedTagIds;
            }
          }

          // Build updated buttons with selected seasons and tags
          // Pass selectedSeasons and selectedTagNames to show them in the Request button label
          const components = buildButtons(
            tmdbId,
            imdbId,
            false,
            mediaType,
            details,
            [],
            [],
            selectedSeasons,
            selectedTagNames
          );

          // Remove tag selector after selection - user now sees updated Request button
          // and can click it to send the request

          await interaction.editReply({
            components,
          });
        } catch (err) {
          logger.error("Tag selection error:", err);
          try {
            await interaction.followUp({
              content: "⚠️ Error updating selection.",
              flags: 64,
            });
          } catch (followUpErr) {
            logger.error("Failed to send follow-up message:", followUpErr);
          }
        }
      }
    } catch (outerErr) {
      logger.error("Interaction handler error:", outerErr);
    }
  });

  return new Promise((resolve, reject) => {
    client.once("clientReady", async () => {
      logger.info(`✅ Bot logged in as ${client.user.tag}`);
      isBotRunning = true;

      logger.info("ℹ️ Jellyfin notifications will be received via webhooks.");

      // Setup daily random pick if enabled
      scheduleDailyRandomPick(client);

      resolve({ success: true, message: `Logged in as ${client.user.tag}` });
    });

    client.login(process.env.DISCORD_TOKEN).catch((err) => {
      logger.error("[DISCORD LOGIN ERROR] Bot login failed:");
      if (err && err.message) {
        logger.error("[DISCORD LOGIN ERROR] Message:", err.message);
      }
      if (err && err.code) {
        logger.error("[DISCORD LOGIN ERROR] Code:", err.code);
      }
      if (err && err.stack) {
        logger.error("[DISCORD LOGIN ERROR] Stack:", err.stack);
      }
      isBotRunning = false;
      discordClient = null;
      reject(err);
    });
  });
}

function configureWebServer() {
  // Security headers
  app.use((req, res, next) => {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // Middleware for parsing JSON bodies - MUST be before routes that use req.body
  app.use(express.json());
  app.use(cookieParser());

  // Rate limiting middleware - DoS protection
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: {
      success: false,
      error: "Too many requests, please try again later.",
    },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const configLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 50, // Limit config changes to 50 per minute
    message: {
      success: false,
      error: "Too many configuration changes, please slow down.",
    },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Strict rate limiter for auth endpoints
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    message: { success: false, error: "Too many attempts, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // --- AUTH ENDPOINTS ---
  app.post("/api/auth/login", authLimiter, login);
  app.post("/api/auth/register", authLimiter, register);
  app.post("/api/auth/logout", logout);
  app.get("/api/auth/check", checkAuth);

  // Apply rate limiting to all API endpoints (except auth and webhooks)
  app.use("/api/", apiLimiter);

  // Endpoint for Discord servers list (guilds)
  app.get("/api/discord/guilds", authenticateToken, async (req, res) => {
    try {
      if (!discordClient || !discordClient.user) {
        logger.debug("[GUILDS API] Bot not running or not logged in.");
        return res.json({ success: false, message: "Bot not running" });
      }
      // Debug: log all guilds
      logger.debug(
        "[GUILDS API] discordClient.guilds.cache:",
        discordClient.guilds.cache.map((g) => ({ id: g.id, name: g.name }))
      );
      // Fetch guilds the bot is in
      const guilds = discordClient.guilds.cache.map((g) => ({
        id: g.id,
        name: g.name,
      }));
      res.json({ success: true, guilds });
    } catch (err) {
      logger.error("[GUILDS API] Error:", err);
      res.json({ success: false, message: err.message });
    }
  });

  // Endpoint for Discord channels list from a server
  app.get(
    "/api/discord/channels/:guildId",
    authenticateToken,
    async (req, res) => {
      try {
        const { guildId } = req.params;
        if (!discordClient || !discordClient.user) {
          logger.debug("[CHANNELS API] Bot not running or not logged in.");
          return res.json({ success: false, message: "Bot not running" });
        }

        const guild = discordClient.guilds.cache.get(guildId);
        if (!guild) {
          return res.json({ success: false, message: "Guild not found" });
        }

        const channels = [];

        // Fetch text channels where bot can send messages
        guild.channels.cache
          .filter(
            (channel) =>
              channel.type === 0 && // GUILD_TEXT
              channel.permissionsFor(discordClient.user).has("SendMessages")
          )
          .forEach((channel) => {
            channels.push({
              id: channel.id,
              name: channel.name,
              type: channel.type === 5 ? "announcement" : "text",
            });
          });

        // Fetch forum channels and their active threads
        const forumChannels = guild.channels.cache.filter(
          (channel) => channel.type === 15 // GUILD_FORUM
        );

        for (const [, forumChannel] of forumChannels) {
          try {
            // Fetch active threads in this forum
            const activeThreads = await forumChannel.threads.fetchActive();

            // Add each thread as a selectable channel
            activeThreads.threads.forEach((thread) => {
              if (thread.permissionsFor(discordClient.user)?.has("SendMessages")) {
                channels.push({
                  id: thread.id,
                  name: `${forumChannel.name} > ${thread.name}`,
                  type: "forum-thread",
                  parentId: forumChannel.id,
                  parentName: forumChannel.name,
                });
              }
            });
          } catch (err) {
            logger.warn(`[CHANNELS API] Failed to fetch threads for forum ${forumChannel.name}:`, err.message);
          }
        }

        // Fetch regular threads (public, private, announcement) from text channels
        try {
          // Fetch all active threads in the guild
          const activeThreads = await guild.channels.fetchActiveThreads();

          activeThreads.threads.forEach((thread) => {
            // Filter for thread types: PUBLIC_THREAD (10), PRIVATE_THREAD (11), ANNOUNCEMENT_THREAD (12)
            if ([10, 11, 12].includes(thread.type)) {
              if (thread.permissionsFor(discordClient.user)?.has("SendMessages")) {
                const parentChannel = guild.channels.cache.get(thread.parentId);
                const threadTypeLabel =
                  thread.type === 10 ? "Thread" :
                    thread.type === 11 ? "Private Thread" :
                      "Announcement Thread";

                channels.push({
                  id: thread.id,
                  name: parentChannel
                    ? `${parentChannel.name} > ${thread.name} (${threadTypeLabel})`
                    : `${thread.name} (${threadTypeLabel})`,
                  type: thread.type === 10 ? "public-thread" :
                    thread.type === 11 ? "private-thread" :
                      "announcement-thread",
                  parentId: thread.parentId,
                  parentName: parentChannel?.name,
                });
              }
            }
          });
        } catch (err) {
          logger.warn(`[CHANNELS API] Failed to fetch regular threads:`, err.message);
        }

        channels.sort((a, b) => a.name.localeCompare(b.name));

        logger.debug(
          `[CHANNELS API] Found ${channels.length} channels (including threads) in guild ${guild.name}`
        );
        res.json({ success: true, channels });
      } catch (err) {
        logger.error("[CHANNELS API] Error:", err);
        res.json({ success: false, message: err.message });
      }
    }
  );

  // Endpoint for Discord members from a server
  app.get("/api/discord-members", authenticateToken, async (req, res) => {
    try {
      logger.debug("[MEMBERS API] Request received");
      if (!discordClient || !discordClient.user) {
        logger.debug("[MEMBERS API] Bot not running");
        return res.json({ success: false, message: "Bot not running" });
      }

      const guildId = process.env.GUILD_ID;
      logger.debug("[MEMBERS API] GUILD_ID from env:", guildId);
      if (!guildId) {
        logger.debug("[MEMBERS API] No guild selected");
        return res.json({ success: false, message: "No guild selected" });
      }

      const guild = discordClient.guilds.cache.get(guildId);
      if (!guild) {
        logger.debug("[MEMBERS API] Guild not found in cache");
        return res.json({ success: false, message: "Guild not found" });
      }

      logger.debug(
        "[MEMBERS API] Guild found:",
        guild.name,
        "Member count:",
        guild.memberCount
      );

      // Check if bot has permission to view members
      const botMember = guild.members.cache.get(discordClient.user.id);
      if (!botMember) {
        logger.debug("[MEMBERS API] Bot member not found in guild");
        return res.json({ success: false, message: "Bot not in guild" });
      }

      logger.debug(
        "[MEMBERS API] Bot permissions:",
        botMember.permissions.toArray()
      );

      // Fetch members with proper error handling and intent detection
      let fetchSuccess = false;
      let fetchError = null;

      try {
        logger.debug(
          "[MEMBERS API] Attempting to fetch members (real-time with force refresh)..."
        );
        // Force refresh members from Discord - ignores cache and fetches latest from server
        await guild.members.fetch({ force: true, limit: 1000 });
        logger.info(
          "[MEMBERS API] ✅ Members fetched successfully (real-time)"
        );
        fetchSuccess = true;
      } catch (fetchErr) {
        fetchError = fetchErr.message;
        const errorCode = fetchErr.code;
        const errorStatus = fetchErr.status;

        logger.error(
          `[MEMBERS API] Fetch error - Code: ${errorCode}, Status: ${errorStatus}, Message: ${fetchErr.message}`
        );

        // Detect if it's a privileged intent issue
        if (
          fetchErr.message.includes("Privileged intent") ||
          fetchErr.code === 50001 ||
          fetchErr.status === 403 ||
          fetchErr.message.includes("requires the SERVER_MEMBERS intent") ||
          fetchErr.message.includes("requires the GUILD_MEMBERS intent")
        ) {
          logger.warn(
            "[MEMBERS API] ⚠️ GUILD_MEMBERS privileged intent not enabled in Discord Developer Portal!"
          );
          logger.warn(
            "[MEMBERS API] To fix: Go to https://discord.com/developers/applications"
          );
          logger.warn("[MEMBERS API] 1. Select your bot application");
          logger.warn("[MEMBERS API] 2. Go to 'Bot' tab");
          logger.warn(
            "[MEMBERS API] 3. Enable 'Server Members Intent' under 'Privileged Gateway Intents'"
          );
          logger.warn("[MEMBERS API] 4. Save changes and restart bot");
          logger.warn(
            "[MEMBERS API] Falling back to cached members (may be incomplete)"
          );
        } else {
          logger.error(
            "[MEMBERS API] Unknown error fetching members. Falling back to cache."
          );
          logger.debug("[MEMBERS API] Full error:", fetchErr);
        }
      }

      // Get members from cache (will be fresh if fetch succeeded, or cached if it failed)
      const members = guild.members.cache
        .filter((member) => !member.user.bot) // Exclude bots
        .map((member) => ({
          id: member.id,
          username: member.user.username,
          displayName: member.displayName || member.user.username,
          avatar: member.user.displayAvatarURL({ size: 64 }),
          discriminator: member.user.discriminator,
        }))
        .sort((a, b) => a.username.localeCompare(b.username)) // Sort alphabetically
        .slice(0, 1000); // Increased limit to 1000 members

      logger.info(
        `[MEMBERS API] Returning ${members.length} members (real-time: ${fetchSuccess})`
      );

      res.json({
        success: true,
        members,
        fetchedRealtime: fetchSuccess,
        warning: fetchSuccess
          ? null
          : "Members from cache - enable GUILD_MEMBERS intent for real-time data",
      });
    } catch (err) {
      logger.error("[MEMBERS API] Error:", err);
      res.json({ success: false, message: err.message });
    }
  });

  // Endpoint for Discord roles from a server
  app.get("/api/discord-roles", authenticateToken, async (req, res) => {
    try {
      logger.debug("[ROLES API] Request received");
      if (!discordClient || !discordClient.user) {
        logger.debug("[ROLES API] Bot not running");
        return res.json({ success: false, message: "Bot not running" });
      }

      const guildId = process.env.GUILD_ID;
      logger.debug("[ROLES API] GUILD_ID from env:", guildId);
      if (!guildId) {
        logger.debug("[ROLES API] No guild selected");
        return res.json({ success: false, message: "No guild selected" });
      }

      const guild = discordClient.guilds.cache.get(guildId);
      if (!guild) {
        logger.debug("[ROLES API] Guild not found in cache");
        return res.json({ success: false, message: "Guild not found" });
      }

      logger.debug("[ROLES API] Guild found:", guild.name);

      // Fetch roles
      const roles = guild.roles.cache
        .filter((role) => !role.managed) // Exclude managed roles (bot roles)
        .map((role) => ({
          id: role.id,
          name: role.name,
          color: role.hexColor,
          memberCount: role.members.size,
        }))
        .sort((a, b) => b.memberCount - a.memberCount); // Sort by member count descending

      logger.debug(`[ROLES API] Returning ${roles.length} roles`);
      res.json({ success: true, roles });
    } catch (err) {
      logger.error("[ROLES API] Error:", err);
      res.json({ success: false, message: err.message });
    }
  });

  // Endpoint for Jellyseerr users
  app.get("/api/jellyseerr-users", authenticateToken, async (req, res) => {
    try {
      logger.debug("[JELLYSEERR USERS API] Request received");
      const jellyseerrUrl = process.env.JELLYSEERR_URL;
      const apiKey = process.env.JELLYSEERR_API_KEY;

      logger.debug("[JELLYSEERR USERS API] JELLYSEERR_URL:", jellyseerrUrl);
      logger.debug("[JELLYSEERR USERS API] API_KEY present:", !!apiKey);

      if (!jellyseerrUrl || !apiKey) {
        logger.debug("[JELLYSEERR USERS API] Missing configuration");
        return res.json({
          success: false,
          message: "Jellyseerr configuration missing",
        });
      }

      let baseUrl = jellyseerrUrl.replace(/\/$/, "");
      if (!baseUrl.endsWith("/api/v1")) {
        baseUrl += "/api/v1";
      }

      logger.debug(
        "[JELLYSEERR USERS API] Making request to:",
        `${baseUrl}/user`
      );

      let response;
      try {
        logger.info(
          "[JELLYSEERR USERS API] Fetching users from Jellyseerr (real-time)..."
        );
        response = await axios.get(`${baseUrl}/user?take=` + Number.MAX_SAFE_INTEGER, {
          headers: { "X-Api-Key": apiKey },
          timeout: TIMEOUTS.JELLYSEERR_API,
        });

        logger.info(
          "[JELLYSEERR USERS API] ✅ Users fetched successfully (real-time)"
        );
      } catch (fetchErr) {
        logger.error(
          "[JELLYSEERR USERS API] Failed to fetch users:",
          fetchErr.message
        );
        throw fetchErr;
      }

      logger.debug(
        "[JELLYSEERR USERS API] Response received, status:",
        response.status
      );
      logger.debug(
        "[JELLYSEERR USERS API] Response data type:",
        typeof response.data
      );
      logger.debug(
        "[JELLYSEERR USERS API] Response data is array:",
        Array.isArray(response.data)
      );
      if (!Array.isArray(response.data)) {
        logger.debug(
          "[JELLYSEERR USERS API] Response data keys:",
          Object.keys(response.data)
        );
      }
      logger.debug(
        "[JELLYSEERR USERS API] Response data length:",
        Array.isArray(response.data)
          ? response.data.length
          : response.data.results?.length || "N/A"
      );

      // Jellyseerr API returns { pageInfo, results: [] }
      const userData = response.data.results || [];

      const users = userData
        .map((user) => {
          let avatar = user.avatar || null;
          // If avatar is relative, make it absolute
          if (avatar && !avatar.startsWith("http")) {
            avatar = `${jellyseerrUrl.replace(/\/api\/v1$/, "")}${avatar}`;
          }
          return {
            id: user.id,
            displayName: user.displayName || user.username || `User ${user.id}`,
            username: user.username || "",
            email: user.email || "",
            avatar: avatar,
          };
        })
        .sort((a, b) =>
          (a.displayName || "").localeCompare(b.displayName || "")
        ); // Sort alphabetically

      logger.info(
        `[JELLYSEERR USERS API] ✅ Returning ${users.length} users (real-time)`
      );
      res.json({ success: true, users, fetchedRealtime: true });
    } catch (err) {
      logger.error("[JELLYSEERR USERS API] Error:", err.message);
      if (err.response) {
        logger.error(
          "[JELLYSEERR USERS API] Response status:",
          err.response.status
        );
        logger.error(
          "[JELLYSEERR USERS API] Response data:",
          err.response.data
        );
      }
      res.json({ success: false, message: err.message });
    }
  });

  // Endpoint for user mappings
  app.get("/api/user-mappings", authenticateToken, (req, res) => {
    // Load from config.json using centralized helper
    const mappings = getUserMappings();
    res.json(mappings);
  });

  app.post(
    "/api/user-mappings",
    authenticateToken,
    validateBody(userMappingSchema),
    (req, res) => {
      const {
        discordUserId,
        jellyseerrUserId,
        discordUsername,
        discordDisplayName,
        jellyseerrDisplayName,
      } = req.body;

      if (!discordUserId || !jellyseerrUserId) {
        return res.status(400).json({
          success: false,
          message: "Discord user ID and Jellyseerr user ID are required.",
        });
      }

      try {
        const mapping = {
          discordUserId,
          jellyseerrUserId,
          discordUsername: discordUsername || null,
          discordDisplayName: discordDisplayName || null,
          jellyseerrDisplayName: jellyseerrDisplayName || null,
        };

        // Use centralized saveUserMapping helper
        saveUserMapping(mapping);

        // Reload config into process.env to ensure mapping is immediately active
        loadConfig();

        res.json({ success: true, message: "Mapping saved successfully." });
      } catch (error) {
        logger.error("Error saving user mapping:", error);
        res.status(500).json({
          success: false,
          message: "Failed to save mapping - check server logs.",
        });
      }
    }
  );

  app.delete(
    "/api/user-mappings/:discordUserId",
    authenticateToken,
    (req, res) => {
      const { discordUserId } = req.params;

      try {
        // Use centralized deleteUserMapping helper
        const deleted = deleteUserMapping(discordUserId);

        if (!deleted) {
          return res
            .status(404)
            .json({ success: false, message: "Mapping not found." });
        }

        // Reload config into process.env to ensure mapping is immediately removed
        loadConfig();

        res.json({ success: true, message: "Mapping deleted successfully." });
      } catch (error) {
        logger.error("Error deleting user mapping:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete mapping - check server logs.",
        });
      }
    }
  );

  // Endpoint for Jellyfin libraries
  app.post("/api/jellyfin-libraries", authenticateToken, async (req, res) => {
    try {
      const { url } = req.body;
      let { apiKey } = req.body;
      // If the frontend sends back a masked placeholder, use the real key from config
      if (isMaskedValue(apiKey)) {
        apiKey = process.env.JELLYFIN_API_KEY;
      }

      if (!url || !apiKey) {
        return res
          .status(400)
          .json({ success: false, message: "URL and API Key are required." });
      }

      const response = await axios.get(
        `${url.replace(/\/$/, "")}/Library/MediaFolders`,
        {
          headers: { "X-MediaBrowser-Token": apiKey },
          timeout: TIMEOUTS.JELLYFIN_API,
        }
      );

      const libraries = response.data.Items.map((item) => ({
        id: item.Id,
        name: item.Name,
        type: item.CollectionType || "unknown",
      }));

      // Update library cache with fresh data for webhook usage
      if (response.data.Items && response.data.Items.length > 0) {
        libraryCache.set(response.data.Items);
        logger.info(
          `[LIBRARY CACHE] Updated cache with ${response.data.Items.length} libraries`
        );
      }

      res.json({ success: true, libraries });
    } catch (err) {
      logger.error("[JELLYFIN LIBRARIES API] Error:", err);
      res.json({ success: false, message: err.message });
    }
  });

  // Global error handler middleware - must be last
  app.use((err, req, res, next) => {
    logger.error("Express error handler:", {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
    });

    // Don't expose internal errors to client in production
    const statusCode = err.status || err.statusCode || 500;
    const message = statusCode === 500 ? "Internal server error" : err.message;

    res.status(statusCode).json({
      success: false,
      error: message,
    });
  });

  app.use("/assets", express.static(path.join(__dirname, "assets")));
  app.use("/locales", express.static(path.join(__dirname, "locales")));
  app.use(express.static(path.join(__dirname, "web")));

  app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "web", "index.html"));
  });

  // Rate limiter for the webhook endpoint - prevents notification flooding / DoS
  const webhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // max 60 webhook calls per minute per IP
    message: { success: false, error: "Too many webhook requests." },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Verify the shared secret sent by Jellyfin in the X-Webhook-Secret header.
  // Configure WEBHOOK_SECRET in the dashboard, then add a matching custom header
  // in the Jellyfin webhook plugin: X-Webhook-Secret: <your-secret>
  function verifyWebhookSecret(req, res, next) {
    const provided = req.headers["x-webhook-secret"];
    const expected = WEBHOOK_SECRET;
    const providedBuf = Buffer.from(provided || "", "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    const valid =
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf, expectedBuf);
    if (!valid) {
      logger.warn(`⚠️ Webhook rejected: invalid or missing X-Webhook-Secret (from ${req.ip})`);
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    next();
  }

  // --- JELLYFIN WEBHOOK ENDPOINT ---
  app.post("/jellyfin-webhook", webhookLimiter, verifyWebhookSecret, express.json({ type: "*/*" }), async (req, res) => {
    try {
      logger.info("📥 Received Jellyfin webhook");
      logger.debug("Webhook payload:", JSON.stringify(req.body, null, 2));

      // Acknowledge receipt immediately
      res.status(200).json({ success: true, message: "Webhook received" });

      if (!req.body || Object.keys(req.body).length === 0) {
        logger.warn("⚠️ Webhook body is empty — check that 'Send All Properties' is enabled in Jellyfin and the webhook is correctly configured");
        return;
      }

      // Process webhook asynchronously
      if (discordClient && isBotRunning) {
        // Don't pass res since we already responded
        await handleJellyfinWebhook(req, null, discordClient, pendingRequests, savePendingRequests);
      } else {
        logger.warn(
          `⚠️ Jellyfin webhook received but Discord bot is not running — notification dropped (ItemType: ${req.body?.ItemType}, Name: ${req.body?.Name})`
        );
      }
    } catch (error) {
      logger.error(`❌ Error processing Jellyfin webhook (ItemType: ${req.body?.ItemType}, Name: ${req.body?.Name}):`, error);
      // Don't send error response since we already sent 200
    }
  });

  app.get("/api/config", authenticateToken, (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    const config = readConfig();
    if (config) {
      res.json(sanitizeConfigForClient(config));
    } else {
      res.json(sanitizeConfigForClient(configTemplate));
    }
  });

  // Return webhook secret for copy-to-clipboard (stripped from /api/config)
  app.get("/api/webhook-secret", authenticateToken, (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    const config = readConfig();
    res.json({ secret: config?.WEBHOOK_SECRET || null });
  });

  // Get available languages dynamically from locales directory
  app.get("/api/languages", async (req, res) => {
    try {
      const localesDir = path.join(process.cwd(), "locales");
      const files = fs.readdirSync(localesDir);

      const languages = [];

      for (const file of files) {
        if (file.endsWith('.json') && file !== 'template.json') {
          try {
            const langPath = path.join(localesDir, file);
            const langData = JSON.parse(fs.readFileSync(langPath, 'utf8'));

            if (langData._meta && langData._meta.language_code && langData._meta.language_name) {
              languages.push({
                code: langData._meta.language_code,
                name: langData._meta.language_name
              });
            }
          } catch (error) {
            logger.warn(`Failed to parse language file ${file}: ${error.message}`);
          }
        }
      }

      // Sort by language name
      languages.sort((a, b) => a.name.localeCompare(b.name));

      res.json(languages);
    } catch (error) {
      logger.error(`Failed to load available languages: ${error.message}`);
      // Return fallback languages
      res.json([
        { code: 'en', name: 'English' },
        { code: 'de', name: 'Deutsch' },
        { code: 'sv', name: 'Svenska' }
      ]);
    }
  });

  app.post(
    "/api/save-config",
    authenticateToken,
    configLimiter,
    validateBody(configSchema),
    async (req, res) => {
      const configData = req.body;
      const oldToken = process.env.DISCORD_TOKEN;
      const oldGuildId = process.env.GUILD_ID;
      const oldJellyfinApiKey = process.env.JELLYFIN_API_KEY;

      // Normalize JELLYSEERR_URL to remove /api/v1 suffix if present
      if (
        configData.JELLYSEERR_URL &&
        typeof configData.JELLYSEERR_URL === "string"
      ) {
        configData.JELLYSEERR_URL = configData.JELLYSEERR_URL.replace(
          /\/api\/v1\/?$/,
          ""
        );
      }

      try {
        // Load existing config to preserve USER_MAPPINGS and other non-form fields
        const existingConfig = readConfig() || {};

        // Merge with existing config, preserving USER_MAPPINGS and other fields not in the form
        const finalConfig = {
          ...existingConfig,
          ...configData,
          // Ensure USER_MAPPINGS, USERS, JWT_SECRET, and WEBHOOK_SECRET are preserved
          USER_MAPPINGS: existingConfig.USER_MAPPINGS || [],
          USERS: existingConfig.USERS || [],
          JWT_SECRET: existingConfig.JWT_SECRET || process.env.JWT_SECRET,
          WEBHOOK_SECRET: existingConfig.WEBHOOK_SECRET || process.env.WEBHOOK_SECRET,
          // Safety check for library mappings - prefer new config, fallback to existing if missing in request
          JELLYFIN_NOTIFICATION_LIBRARIES:
            configData.JELLYFIN_NOTIFICATION_LIBRARIES ||
            existingConfig.JELLYFIN_NOTIFICATION_LIBRARIES ||
            {},
        };

        // Preserve sensitive fields only when the frontend sends a masked placeholder
        // or omits the field entirely — an explicit empty string intentionally clears the credential
        for (const field of SENSITIVE_FIELDS) {
          if (!(field in configData) || isMaskedValue(configData[field])) {
            finalConfig[field] = existingConfig[field] || "";
          }
        }

        // Use centralized writeConfig with robust error handling
        if (!writeConfig(finalConfig)) {
          return res.status(500).json({
            success: false,
            error:
              "Failed to save configuration file. Check Docker volume permissions and server logs.",
          });
        }

        logger.info("✅ Configuration saved successfully");
      } catch (writeErr) {
        logger.error("Error saving config.json:", writeErr);
        return res.status(500).json({
          success: false,
          error:
            "Failed to save configuration file. Check Docker volume permissions.",
        });
      }

      loadConfig(); // Reload config into process.env

      // Check if Discord credentials are complete and changed
      const hasDiscordCreds = process.env.DISCORD_TOKEN && process.env.BOT_ID;
      const discordCredsChanged = oldToken !== process.env.DISCORD_TOKEN;

      // If bot is running and critical settings changed, restart the bot logic
      const jellyfinApiKeyChanged =
        oldJellyfinApiKey !== process.env.JELLYFIN_API_KEY;
      const needsRestart =
        oldToken !== process.env.DISCORD_TOKEN ||
        oldGuildId !== process.env.GUILD_ID ||
        jellyfinApiKeyChanged;

      if (isBotRunning && needsRestart) {
        logger.warn(
          "Critical Discord settings changed. Restarting bot logic..."
        );

        await discordClient.destroy();
        isBotRunning = false;
        discordClient = null;
        try {
          await startBot();
          res
            .status(200)
            .json({ message: "Configuration saved. Bot restarted." });
        } catch (error) {
          res.status(500).json({
            message: `Config saved, but bot failed to restart: ${error.message}`,
          });
        }
      } else if (!isBotRunning && hasDiscordCreds && discordCredsChanged) {
        // Check if user wants to auto-start the bot (default: true for backward compatibility)
        const shouldStartBot = configData.startBot !== false; // Default to true if not specified

        if (shouldStartBot) {
          // Auto-start bot when Discord credentials are first entered or changed
          logger.info("Discord credentials configured. Starting bot automatically...");
          try {
            await startBot();
            res.status(200).json({
              message: "Configuration saved. Bot started successfully!"
            });
          } catch (error) {
            logger.error("Auto-start failed:", error.message);
            res.status(200).json({
              message: `Configuration saved, but bot failed to start: ${error.message}. Check credentials and try starting manually.`,
            });
          }
        } else {
          // User chose not to start the bot
          res.status(200).json({
            message: "Configuration saved successfully! You can start the bot manually when ready."
          });
        }
      } else {
        res.status(200).json({ message: "Configuration saved successfully!" });
      }
    }
  );

  // Check if saving config would trigger bot auto-start
  app.post("/api/check-autostart", authenticateToken, async (req, res) => {
    const configData = req.body;
    const oldToken = process.env.DISCORD_TOKEN;

    // Resolve effective token (masked values mean "use existing")
    const effectiveToken = isMaskedValue(configData.DISCORD_TOKEN)
      ? process.env.DISCORD_TOKEN
      : configData.DISCORD_TOKEN;

    // Check if Discord credentials are complete and changed
    const hasDiscordCreds = effectiveToken && configData.BOT_ID;
    const discordCredsChanged = oldToken !== effectiveToken;
    const wouldAutoStart = !isBotRunning && hasDiscordCreds && discordCredsChanged;

    res.json({
      wouldAutoStart,
      hasDiscordCreds,
      discordCredsChanged,
      isBotRunning
    });
  });

  app.post("/api/test-jellyseerr", authenticateToken, async (req, res) => {
    const { url, apiKey } = req.body;
    const effectiveApiKey = isMaskedValue(apiKey) ? process.env.JELLYSEERR_API_KEY : apiKey;
    if (!url || !effectiveApiKey) {
      return res
        .status(400)
        .json({ success: false, message: "URL and API Key are required." });
    }

    try {
      let baseUrl = url.replace(/\/$/, "");
      if (!baseUrl.endsWith("/api/v1")) {
        baseUrl += "/api/v1";
      }

      const response = await axios.get(`${baseUrl}/settings/about`, {
        headers: { "X-Api-Key": effectiveApiKey },
        timeout: TIMEOUTS.JELLYSEERR_API,
      });
      const version = response.data?.version;
      res.json({
        success: true,
        message: `Connection successful! (v${version})`,
      });
    } catch (error) {
      logger.error("Jellyseerr test failed:", error.message);
      // Check if the error is due to an invalid API key (401/403)
      if (error.response && [401, 403].includes(error.response.status)) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid API Key." });
      }
      res.status(500).json({
        success: false,
        message: "Connection failed. Check URL and API Key.",
      });
    }
  });

  // Fetch quality profiles
  app.post("/api/jellyseerr/quality-profiles", authenticateToken, async (req, res) => {
    const { url, apiKey } = req.body;
    const effectiveApiKey = isMaskedValue(apiKey) ? process.env.JELLYSEERR_API_KEY : apiKey;
    if (!url || !effectiveApiKey) {
      return res
        .status(400)
        .json({ success: false, message: "URL and API Key are required." });
    }

    try {
      let baseUrl = url.replace(/\/$/, "");
      if (!baseUrl.endsWith("/api/v1")) {
        baseUrl += "/api/v1";
      }

      const profiles = await jellyseerrApi.fetchQualityProfiles(baseUrl, effectiveApiKey);
      res.json({ success: true, profiles });
    } catch (error) {
      logger.error("Failed to fetch quality profiles:", error.message);
      res.status(500).json({
        success: false,
        message: "Failed to fetch quality profiles.",
      });
    }
  });

  // Fetch servers
  app.post("/api/jellyseerr/servers", authenticateToken, async (req, res) => {
    const { url, apiKey } = req.body;
    const effectiveApiKey = isMaskedValue(apiKey) ? process.env.JELLYSEERR_API_KEY : apiKey;
    if (!url || !effectiveApiKey) {
      return res
        .status(400)
        .json({ success: false, message: "URL and API Key are required." });
    }

    try {
      let baseUrl = url.replace(/\/$/, "");
      if (!baseUrl.endsWith("/api/v1")) {
        baseUrl += "/api/v1";
      }

      const servers = await jellyseerrApi.fetchServers(baseUrl, effectiveApiKey);
      res.json({ success: true, servers });
    } catch (error) {
      logger.error("Failed to fetch servers:", error.message);
      res.status(500).json({
        success: false,
        message: "Failed to fetch servers.",
      });
    }
  });

  app.post("/api/test-jellyfin", authenticateToken, async (req, res) => {
    const { url } = req.body;
    if (!url) {
      return res
        .status(400)
        .json({ success: false, message: "Jellyfin URL is required." });
    }

    try {
      const testUrl = `${url.replace(/\/$/, "")}/System/Info/Public`;
      const response = await axios.get(testUrl, {
        timeout: TIMEOUTS.JELLYFIN_API,
      });

      if (response.data?.ServerName && response.data?.Version) {
        return res.json({
          success: true,
          message: `Connected to ${response.data.ServerName} (v${response.data.Version})`,
          serverId: response.data.Id,
        });
      }
      throw new Error("Invalid response from Jellyfin server.");
    } catch (error) {
      logger.error("Jellyfin test failed:", error.message);
      res.status(500).json({
        success: false,
        message: "Connection failed. Check URL and network.",
      });
    }
  });

  app.get("/api/jellyfin/libraries", authenticateToken, async (req, res) => {
    try {
      const apiKey = process.env.JELLYFIN_API_KEY;
      const baseUrl = process.env.JELLYFIN_URL;

      if (!apiKey || !baseUrl) {
        return res.status(400).json({
          success: false,
          message: "Jellyfin API key and URL are required in configuration.",
        });
      }

      // Import fetchLibraries dynamically
      const { fetchLibraries } = await import("./api/jellyfin.js");
      const libraries = await fetchLibraries(apiKey, baseUrl);

      res.json({
        success: true,
        libraries: libraries.map((lib) => ({
          id: lib.ItemId,
          collectionId: lib.CollectionId,
          name: lib.Name,
          type: lib.CollectionType,
        })),
      });
    } catch (error) {
      logger.error("Failed to fetch Jellyfin libraries:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch libraries. Check Jellyfin configuration.",
      });
    }
  });

  // Test notification endpoint - sends sample notifications with random data
  app.post("/api/test-notification", authenticateToken, async (req, res) => {
    try {
      const { type } = req.body;

      if (!type || !["movie", "series", "season", "batch-seasons", "episodes", "batch-episodes"].includes(type)) {
        return res.status(400).json({
          success: false,
          message: "Invalid notification type. Must be: movie, series, season, batch-seasons, episodes, or batch-episodes.",
        });
      }

      // Check if Discord bot is running and configured
      if (!discordClient || !discordClient.isReady()) {
        return res.status(400).json({
          success: false,
          message: "Discord bot is not running. Please start the bot first.",
        });
      }

      const guildId = process.env.GUILD_ID;
      const channelId = process.env.JELLYFIN_CHANNEL_ID;

      if (!guildId || !channelId) {
        return res.status(400).json({
          success: false,
          message: "Discord server and channel must be configured first.",
        });
      }

      // Fetch real data from TMDB/OMDB for realistic test notifications
      const { tmdbGetDetails, tmdbGetExternalImdb } = await import("./api/tmdb.js");
      const { fetchOMDbData } = await import("./api/omdb.js");

      const TMDB_API_KEY = process.env.TMDB_API_KEY;
      if (!TMDB_API_KEY) {
        return res.status(400).json({
          success: false,
          message: "TMDB API key is required for test notifications. Configure it in Step 3.",
        });
      }

      let notificationData;

      // Build realistic notification data based on type
      if (type === "movie") {
        // Interstellar TMDB ID: 157336
        const movieDetails = await tmdbGetDetails(157336, "movie", TMDB_API_KEY);
        const imdbId = await tmdbGetExternalImdb(157336, "movie", TMDB_API_KEY);

        notificationData = {
          ItemType: "Movie",
          Name: movieDetails.title,
          Year: movieDetails.release_date ? movieDetails.release_date.split("-")[0] : "",
          Overview: movieDetails.overview,
          Provider_tmdb: "157336",
          Provider_imdb: imdbId,
          ServerUrl: process.env.JELLYFIN_BASE_URL || process.env.JELLYFIN_URL || "https://jellyfin.example.com",
          ServerId: process.env.JELLYFIN_SERVER_ID || "test-server-id",
          ItemId: "test-movie-" + Date.now(),
        };
      } else if (type === "series") {
        // Breaking Bad TMDB ID: 1396
        const seriesDetails = await tmdbGetDetails(1396, "tv", TMDB_API_KEY);
        const imdbId = await tmdbGetExternalImdb(1396, "tv", TMDB_API_KEY);

        notificationData = {
          ItemType: "Series",
          Name: seriesDetails.name,
          Year: seriesDetails.first_air_date ? seriesDetails.first_air_date.split("-")[0] : "",
          Overview: seriesDetails.overview,
          Provider_tmdb: "1396",
          Provider_imdb: imdbId,
          ServerUrl: process.env.JELLYFIN_BASE_URL || process.env.JELLYFIN_URL || "https://jellyfin.example.com",
          ServerId: process.env.JELLYFIN_SERVER_ID || "test-server-id",
          ItemId: "test-series-" + Date.now(),
        };
      } else if (type === "season") {
        // Breaking Bad Season 1
        const seriesDetails = await tmdbGetDetails(1396, "tv", TMDB_API_KEY);
        const imdbId = await tmdbGetExternalImdb(1396, "tv", TMDB_API_KEY);

        notificationData = {
          ItemType: "Season",
          SeriesName: seriesDetails.name,
          SeriesId: "test-series-" + Date.now(),
          Name: "Season 1",
          SeasonNumber: 1,
          Year: seriesDetails.first_air_date ? seriesDetails.first_air_date.split("-")[0] : "",
          Overview: "High school chemistry teacher Walter White's life is suddenly transformed by a dire medical diagnosis. Street-savvy former student Jesse Pinkman \"teaches\" Walter a new trade.",
          Provider_tmdb: "1396",
          Provider_imdb: imdbId,
          ServerUrl: process.env.JELLYFIN_BASE_URL || process.env.JELLYFIN_URL || "https://jellyfin.example.com",
          ServerId: process.env.JELLYFIN_SERVER_ID || "test-server-id",
          ItemId: "test-season-" + Date.now(),
        };
      } else if (type === "episodes") {
        // Breaking Bad first episodes
        const seriesDetails = await tmdbGetDetails(1396, "tv", TMDB_API_KEY);
        const imdbId = await tmdbGetExternalImdb(1396, "tv", TMDB_API_KEY);

        notificationData = {
          ItemType: "Episode",
          SeriesName: seriesDetails.name,
          SeriesId: "test-series-" + Date.now(),
          Name: "Pilot, Cat's in the Bag...",
          SeasonNumber: 1,
          EpisodeNumber: 1,
          Year: seriesDetails.first_air_date ? seriesDetails.first_air_date.split("-")[0] : "",
          Overview: "When an unassuming high school chemistry teacher discovers he has a rare form of lung cancer, he decides to team up with a former student and create a top of the line crystal meth in a used RV, to provide for his family once he is gone.",
          Provider_tmdb: "1396",
          Provider_imdb: imdbId,
          ServerUrl: process.env.JELLYFIN_BASE_URL || process.env.JELLYFIN_URL || "https://jellyfin.example.com",
          ServerId: process.env.JELLYFIN_SERVER_ID || "test-server-id",
          ItemId: "test-episode-" + Date.now(),
        };
      } else if (type === "batch-seasons") {
        // The Mandalorian - Send 2 separate season notifications to test batching (TMDB ID: 82856)
        const seriesDetails = await tmdbGetDetails(82856, "tv", TMDB_API_KEY);
        const imdbId = await tmdbGetExternalImdb(82856, "tv", TMDB_API_KEY);

        const { handleJellyfinWebhook } = await import("./jellyfinWebhook.js");
        const baseSeriesId = "batch-test-series-" + Date.now();

        // Send Season 1
        const season1Data = {
          ItemType: "Season",
          SeriesName: seriesDetails.name,
          SeriesId: baseSeriesId,
          Name: "Season 1",
          SeasonNumber: 1,
          Year: seriesDetails.first_air_date ? seriesDetails.first_air_date.split("-")[0] : "",
          Overview: "After the fall of the Galactic Empire, lawlessness has spread throughout the galaxy. A lone gunfighter makes his way through the outer reaches, earning his keep as a bounty hunter.",
          Provider_tmdb: "82856",
          Provider_imdb: imdbId,
          ServerUrl: process.env.JELLYFIN_BASE_URL || process.env.JELLYFIN_URL || "https://jellyfin.example.com",
          ServerId: process.env.JELLYFIN_SERVER_ID || "test-server-id",
          ItemId: "batch-season-1-" + Date.now(),
        };

        // Send Season 2
        const season2Data = {
          ItemType: "Season",
          SeriesName: seriesDetails.name,
          SeriesId: baseSeriesId,
          Name: "Season 2",
          SeasonNumber: 2,
          Year: seriesDetails.first_air_date ? seriesDetails.first_air_date.split("-")[0] : "",
          Overview: "The Mandalorian and the Child continue their journey, facing enemies and rallying allies as they make their way through a dangerous galaxy in the tumultuous era after the collapse of the Galactic Empire.",
          Provider_tmdb: "82856",
          Provider_imdb: imdbId,
          ServerUrl: process.env.JELLYFIN_BASE_URL || process.env.JELLYFIN_URL || "https://jellyfin.example.com",
          ServerId: process.env.JELLYFIN_SERVER_ID || "test-server-id",
          ItemId: "batch-season-2-" + Date.now(),
        };

        // Send both seasons (they should be batched together by debouncing logic)
        const fakeReq1 = { body: season1Data };
        const fakeReq2 = { body: season2Data };

        await handleJellyfinWebhook(fakeReq1, null, discordClient, pendingRequests, savePendingRequests);
        await handleJellyfinWebhook(fakeReq2, null, discordClient, pendingRequests, savePendingRequests);

        return res.json({
          success: true,
          message: `Test batch-seasons notification sent! 2 seasons should be batched together. Check your Discord channel.`,
        });
      } else if (type === "batch-episodes") {
        // Stranger Things - Send 6 separate episode notifications to test batching (TMDB ID: 66732)
        const seriesDetails = await tmdbGetDetails(66732, "tv", TMDB_API_KEY);
        const imdbId = await tmdbGetExternalImdb(66732, "tv", TMDB_API_KEY);

        const { handleJellyfinWebhook } = await import("./jellyfinWebhook.js");
        const baseSeriesId = "batch-test-series-" + Date.now();

        const episodes = [
          { num: "01", name: "Chapter One: The Hellfire Club", overview: "Spring break turns into a nightmare when a new evil emerges in Hawkins." },
          { num: "02", name: "Chapter Two: Vecna's Curse", overview: "A plane brings Mike to California, and to his girlfriend, and to new, high school, problems." },
          { num: "03", name: "Chapter Three: The Monster and the Superhero", overview: "Murray and Joyce fly to Alaska, and El faces serious consequences. Robin and Nancy dig for information." },
          { num: "04", name: "Chapter Four: Dear Billy", overview: "Max is in grave danger, and running out of time. A patient at Pennhurst asylum has visitors. Elsewhere, in Russia, Hopper is hard at work." },
          { num: "05", name: "Chapter Five: The Nina Project", overview: "Owens takes El to Nevada, where she's forced to confront her past, while the Hawkins kids comb a crumbling house for answers." },
          { num: "06", name: "Chapter Six: The Dive", overview: "Behind the Iron Curtain, a risky rescue mission gets underway. The California crew seeks help from a hacker. Steve takes one for the team." },
        ];

        // Send all 6 episodes (they should be batched together by debouncing logic)
        for (const ep of episodes) {
          const episodeData = {
            ItemType: "Episode",
            SeriesName: seriesDetails.name,
            SeriesId: baseSeriesId,
            Name: ep.name,
            SeasonNumber: 4,
            EpisodeNumber: parseInt(ep.num),
            Year: seriesDetails.first_air_date ? seriesDetails.first_air_date.split("-")[0] : "",
            Overview: ep.overview,
            Provider_tmdb: "66732",
            Provider_imdb: imdbId,
            ServerUrl: process.env.JELLYFIN_BASE_URL || process.env.JELLYFIN_URL || "https://jellyfin.example.com",
            ServerId: process.env.JELLYFIN_SERVER_ID || "test-server-id",
            ItemId: "batch-episode-" + ep.num + "-" + Date.now(),
          };

          const fakeReq = { body: episodeData };
          await handleJellyfinWebhook(fakeReq, null, discordClient, pendingRequests, savePendingRequests);
          // Small delay between episodes to simulate realistic webhook timing
          await new Promise(resolve => setTimeout(resolve, 50));
        }

        return res.json({
          success: true,
          message: `Test batch-episodes notification sent! 6 episodes should be batched together. Check your Discord channel.`,
        });
      }

      // Import webhook handler
      const { handleJellyfinWebhook } = await import("./jellyfinWebhook.js");

      // Create a fake request object with the test data
      const fakeReq = {
        body: notificationData
      };

      // Send the test notification (pass null for res since we don't need response handling)
      await handleJellyfinWebhook(fakeReq, null, discordClient, pendingRequests, savePendingRequests);

      res.json({
        success: true,
        message: `Test ${type} notification sent successfully! Check your Discord channel.`,
      });
    } catch (error) {
      logger.error("Failed to send test notification:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to send test notification. Check logs for details.",
      });
    }
  });

  // Test random pick endpoint - sends a sample random pick
  app.post("/api/test-random-pick", authenticateToken, async (req, res) => {
    try {
      // Check if Discord bot is running and configured
      if (!discordClient || !discordClient.isReady()) {
        return res.status(400).json({
          success: false,
          message: "Discord bot is not running. Please start the bot first.",
        });
      }

      const channelId = process.env.DAILY_RANDOM_PICK_CHANNEL_ID;
      if (!channelId) {
        return res.status(400).json({
          success: false,
          message: "Daily Random Pick channel must be configured first.",
        });
      }

      const TMDB_API_KEY = process.env.TMDB_API_KEY;
      if (!TMDB_API_KEY) {
        return res.status(400).json({
          success: false,
          message: "TMDB API key is required. Configure it in Step 3.",
        });
      }

      // Get random media and send it
      await sendDailyRandomPick(discordClient);

      res.json({
        success: true,
        message: "Random pick sent successfully! Check your Discord channel.",
      });
    } catch (error) {
      logger.error("Failed to send test random pick:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to send random pick. Check logs for details.",
      });
    }
  });

  // Health check endpoint for monitoring
  app.get("/api/health", (req, res) => {
    const uptime = process.uptime();
    const cacheStats = cache.getStats();

    res.json({
      status: "healthy",
      version: APP_VERSION,
      uptime: Math.floor(uptime),
      uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor(
        (uptime % 3600) / 60
      )}m ${Math.floor(uptime % 60)}s`,
      bot: {
        running: isBotRunning,
        username:
          isBotRunning && discordClient?.user ? discordClient.user.tag : null,
        connected: discordClient?.ws?.status === 0, // 0 = READY
      },
      cache: {
        hits: cacheStats.hits,
        misses: cacheStats.misses,
        keys: cacheStats.keys,
        hitRate:
          cacheStats.hits + cacheStats.misses > 0
            ? (
              (cacheStats.hits / (cacheStats.hits + cacheStats.misses)) *
              100
            ).toFixed(2) + "%"
            : "0%",
      },
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + " MB",
        total:
          Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + " MB",
      },
      timestamp: new Date().toISOString(),
    });
  });

  // Parse log file and return formatted entries
  function parseLogFile(filePath, limit = 1000) {
    try {
      if (!fs.existsSync(filePath)) {
        return { entries: [], truncated: false };
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim());

      // Keep only the last 'limit' entries
      const truncated = lines.length > limit;
      const relevantLines = lines.slice(-limit);

      const entries = relevantLines.map((line) => {
        // Parse Winston JSON logs
        try {
          const logEntry = JSON.parse(line);
          return {
            timestamp: logEntry.timestamp || "N/A",
            level: logEntry.level || "unknown",
            message: logEntry.message || "",
          };
        } catch {
          // Fallback for non-JSON lines
          const match = line.match(
            /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(\w+):\s+(.+)$/
          );
          if (match) {
            return {
              timestamp: match[1],
              level: match[2],
              message: match[3],
            };
          }
          return {
            timestamp: "N/A",
            level: "unknown",
            message: line,
          };
        }
      });

      return { entries, truncated };
    } catch (error) {
      logger.error("Error parsing log file:", error);
      return { entries: [], truncated: false };
    }
  }

  // API endpoint for error logs
  app.get("/api/logs/error", authenticateToken, (req, res) => {
    const logsDir = path.join(process.cwd(), "logs");
    // Find the current error log file (error-YYYY-MM-DD.log)
    let errorLogPath = path.join(logsDir, "error.log");

    // Try to find the latest rotated error log file
    try {
      const files = fs.readdirSync(logsDir);
      const errorFiles = files.filter(
        (f) => f.startsWith("error-") && f.endsWith(".log")
      );
      if (errorFiles.length > 0) {
        errorFiles.sort().reverse();
        errorLogPath = path.join(logsDir, errorFiles[0]);
      }
    } catch (e) {
      // Fallback to default path
    }

    const { entries, truncated } = parseLogFile(errorLogPath);
    res.json({
      file: path.basename(errorLogPath),
      count: entries.length,
      total: truncated ? "1000+" : entries.length,
      truncated,
      entries,
    });
  });

  // API endpoint for all logs
  app.get("/api/logs/all", authenticateToken, (req, res) => {
    const logsDir = path.join(process.cwd(), "logs");
    // Find the current combined log file (combined-YYYY-MM-DD.log)
    let combinedLogPath = path.join(logsDir, "combined.log");

    // Try to find the latest rotated combined log file
    try {
      const files = fs.readdirSync(logsDir);
      const combinedFiles = files.filter(
        (f) => f.startsWith("combined-") && f.endsWith(".log")
      );
      if (combinedFiles.length > 0) {
        combinedFiles.sort().reverse();
        combinedLogPath = path.join(logsDir, combinedFiles[0]);
      }
    } catch (e) {
      // Fallback to default path
    }

    const { entries, truncated } = parseLogFile(combinedLogPath);
    res.json({
      file: path.basename(combinedLogPath),
      count: entries.length,
      total: truncated ? "1000+" : entries.length,
      truncated,
      entries,
    });
  });

  app.get("/api/status", authenticateToken, (req, res) => {
    res.json({
      isBotRunning,
      botUsername:
        isBotRunning && discordClient?.user ? discordClient.user.tag : null,
    });
  });

  app.post("/api/start-bot", authenticateToken, async (req, res) => {
    if (isBotRunning) {
      return res.status(400).json({ message: "Bot is already running." });
    }
    try {
      const result = await startBot();
      res
        .status(200)
        .json({ message: `Bot started successfully! ${result.message}` });
    } catch (error) {
      res.status(500).json({
        message: `Failed to start bot: ${error.message}`,
      });
    }
  });

  app.post("/api/stop-bot", authenticateToken, async (req, res) => {
    if (!isBotRunning || !discordClient) {
      return res.status(400).json({ message: "Bot is not running." });
    }

    // Stop Jellyfin notification services
    try {
      if (jellyfinWebSocketClient) {
        jellyfinWebSocketClient.stop();
        jellyfinWebSocketClient = null;
        logger.info("Jellyfin WebSocket client stopped");
      }
    } catch (error) {
      logger.error("Error stopping Jellyfin WebSocket client:", error);
    }

    try {
      jellyfinPoller.stop();
      logger.info("Jellyfin poller stopped");
    } catch (error) {
      logger.error("Error stopping Jellyfin poller:", error);
    }

    await discordClient.destroy();
    isBotRunning = false;
    discordClient = null;
    logger.info("Bot has been stopped.");
    res.status(200).json({ message: "Bot stopped successfully." });
  });
}

// --- INITIALIZE AND START SERVER ---
// First, check for .env migration before anything else
migrateEnvToConfig();

logger.info("Initializing web server...");
configureWebServer();
logger.info("Web server configured successfully");

// --- START THE SERVER ---
// This single `app.listen` call handles both modes.
let server;

function startServer() {
  // Check volume configuration early
  verifyVolumeConfiguration();

  loadConfig();
  port = process.env.WEBHOOK_PORT || 8282;
  logger.info(`Attempting to start server on port ${port}...`);
  server = app.listen(port, "0.0.0.0");

  server.on("listening", () => {
    const address = server.address();
    if (address) {
      logger.info(`✅ Anchorr web server is running on port ${address.port}.`);
      logger.info(`📝 Access it at:`);
      logger.info(`   - Local: http://127.0.0.1:${address.port}`);
      logger.info(`   - Network: http://<your-server-ip>:${address.port}`);
      logger.info(`   - Docker: http://<host-ip>:${address.port}`);
    }

    // Auto-start bot if a valid config.json is present
    try {
      const autoStartFlag = String(
        typeof process.env.AUTO_START_BOT === "undefined"
          ? "true"
          : process.env.AUTO_START_BOT
      )
        .trim()
        .toLowerCase();

      const autoStartDisabled = ["false", "0", "no"].includes(autoStartFlag);
      if (autoStartDisabled) {
        logger.info("ℹ️ AUTO_START_BOT is disabled. Bot will not auto-start.");
        return;
      }

      const hasConfigFile = fs.existsSync(CONFIG_PATH);
      const required = ["DISCORD_TOKEN", "BOT_ID"];
      const hasDiscordCreds = required.every(
        (k) => process.env[k] && String(process.env[k]).trim() !== ""
      );

      if (!isBotRunning && hasConfigFile && hasDiscordCreds) {
        logger.info(
          "🚀 Detected existing config.json with Discord credentials. Auto-starting bot..."
        );
        (async () => {
          try {
            await startBot();
            logger.info("✅ Bot auto-started successfully.");
          } catch (e) {
            logger.error("❌ Bot auto-start failed:", e?.message || e);
          }
        })();
      } else if (!hasDiscordCreds) {
        logger.info(
          "ℹ️ Config found but Discord credentials are incomplete. Bot not auto-started."
        );
      }
    } catch (e) {
      logger.error("Error during auto-start check:", e?.message || e);
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      logger.error(
        `❌ Port ${port} is already in use. Please free the port or change WEBHOOK_PORT.`
      );
    } else {
      logger.error("Server error:", err);
    }
    process.exit(1);
  });
}

// Keep the process alive
process.on("SIGTERM", () => {
  logger.info("SIGTERM signal received: closing HTTP server");
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("SIGINT signal received: closing HTTP server");
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

// Catch uncaught exceptions
process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

startServer();
