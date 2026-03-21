import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import express from "express";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { handleJellyfinWebhook } from "./jellyfinWebhook.js";
import { configTemplate } from "./lib/config.js";
import { sendDailyRandomPick } from "./bot/dailyPick.js";

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- MODULE IMPORTS ---
import logger from "./utils/logger.js";
import { validateBody, configSchema } from "./utils/validation.js";
import { authenticateToken, WEBHOOK_SECRET } from "./utils/auth.js";
import { jellyfinPoller } from "./jellyfinPoller.js";
import logRouter from "./routes/logRoutes.js";
import authRouter from "./routes/authRoutes.js";
import userMappingRouter from "./routes/userMappingRoutes.js";
import configRouter from "./routes/configRoutes.js";
import seerrRouter from "./routes/seerrRoutes.js";
import jellyfinRouter from "./routes/jellyfinRoutes.js";
import { botState, pendingRequests, savePendingRequests } from "./bot/botState.js";
import { createBotRoutes } from "./routes/botRoutes.js";
import { startBot } from "./bot/botManager.js";
import {
  CONFIG_PATH,
  readConfig,
  writeConfig,
  loadConfigToEnv,
} from "./utils/configFile.js";
import { SENSITIVE_FIELDS, isMaskedValue } from "./utils/configSanitize.js";

// --- Helper Functions ---
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
          k.startsWith("SEERR")
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

if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

function configureWebServer() {
  // Security headers
  app.use((_req, res, next) => {
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

  // Auth routes (before general rate limiter so authLimiter applies)
  app.use("/api", authRouter);

  // Apply rate limiting to all API endpoints (except auth and webhooks)
  app.use("/api/", apiLimiter);

  // Log routes
  app.use("/api", logRouter);

  // User mapping routes
  app.use("/api", userMappingRouter);

  // Config/language routes
  app.use("/api", configRouter);

  // Seerr routes
  app.use("/api", seerrRouter);

  // Jellyfin test/library routes
  app.use("/api", jellyfinRouter);

  // Bot management routes (health, status, start-bot, stop-bot)
  app.use("/api", createBotRoutes({ startBot, jellyfinPoller }));

  // Endpoint for Discord servers list (guilds)
  app.get("/api/discord/guilds", authenticateToken, async (_req, res) => {
    try {
      if (!botState.discordClient || !botState.discordClient.user) {
        logger.debug("[GUILDS API] Bot not running or not logged in.");
        return res.json({ success: false, message: "Bot not running" });
      }
      // Debug: log all guilds
      logger.debug(
        "[GUILDS API] botState.discordClient.guilds.cache:",
        botState.discordClient.guilds.cache.map((g) => ({ id: g.id, name: g.name }))
      );
      // Fetch guilds the bot is in
      const guilds = botState.discordClient.guilds.cache.map((g) => ({
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
        if (!botState.discordClient || !botState.discordClient.user) {
          logger.debug("[CHANNELS API] Bot not running or not logged in.");
          return res.json({ success: false, message: "Bot not running" });
        }

        const guild = botState.discordClient.guilds.cache.get(guildId);
        if (!guild) {
          return res.json({ success: false, message: "Guild not found" });
        }

        const channels = [];

        // Fetch text channels where bot can send messages
        guild.channels.cache
          .filter(
            (channel) =>
              channel.type === 0 && // GUILD_TEXT
              channel.permissionsFor(botState.discordClient.user).has("SendMessages")
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
              if (thread.permissionsFor(botState.discordClient.user)?.has("SendMessages")) {
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
              if (thread.permissionsFor(botState.discordClient.user)?.has("SendMessages")) {
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
  app.get("/api/discord-members", authenticateToken, async (_req, res) => {
    try {
      logger.debug("[MEMBERS API] Request received");
      if (!botState.discordClient || !botState.discordClient.user) {
        logger.debug("[MEMBERS API] Bot not running");
        return res.json({ success: false, message: "Bot not running" });
      }

      const guildId = process.env.GUILD_ID;
      logger.debug("[MEMBERS API] GUILD_ID from env:", guildId);
      if (!guildId) {
        logger.debug("[MEMBERS API] No guild selected");
        return res.json({ success: false, message: "No guild selected" });
      }

      const guild = botState.discordClient.guilds.cache.get(guildId);
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
      const botMember = guild.members.cache.get(botState.discordClient.user.id);
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
  app.get("/api/discord-roles", authenticateToken, async (_req, res) => {
    try {
      logger.debug("[ROLES API] Request received");
      if (!botState.discordClient || !botState.discordClient.user) {
        logger.debug("[ROLES API] Bot not running");
        return res.json({ success: false, message: "Bot not running" });
      }

      const guildId = process.env.GUILD_ID;
      logger.debug("[ROLES API] GUILD_ID from env:", guildId);
      if (!guildId) {
        logger.debug("[ROLES API] No guild selected");
        return res.json({ success: false, message: "No guild selected" });
      }

      const guild = botState.discordClient.guilds.cache.get(guildId);
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

  // Global error handler middleware - must be last
  app.use((err, req, res, _next) => {
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

  app.get("/", (_req, res) => {
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
      if (botState.discordClient && botState.isBotRunning) {
        // Don't pass res since we already responded
        await handleJellyfinWebhook(req, null, botState.discordClient, pendingRequests, savePendingRequests);
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

      // Normalize SEERR_URL to remove /api/v1 suffix if present
      if (
        configData.SEERR_URL &&
        typeof configData.SEERR_URL === "string"
      ) {
        configData.SEERR_URL = configData.SEERR_URL.replace(
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

      if (botState.isBotRunning && needsRestart) {
        logger.warn(
          "Critical Discord settings changed. Restarting bot logic..."
        );

        await botState.discordClient.destroy();
        botState.isBotRunning = false;
        botState.discordClient = null;
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
      } else if (!botState.isBotRunning && hasDiscordCreds && discordCredsChanged) {
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
    const wouldAutoStart = !botState.isBotRunning && hasDiscordCreds && discordCredsChanged;

    res.json({
      wouldAutoStart,
      hasDiscordCreds,
      discordCredsChanged,
      isBotRunning: botState.isBotRunning,
    });
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
      if (!botState.discordClient || !botState.discordClient.isReady()) {
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

        await handleJellyfinWebhook(fakeReq1, null, botState.discordClient, pendingRequests, savePendingRequests);
        await handleJellyfinWebhook(fakeReq2, null, botState.discordClient, pendingRequests, savePendingRequests);

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
          await handleJellyfinWebhook(fakeReq, null, botState.discordClient, pendingRequests, savePendingRequests);
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
      await handleJellyfinWebhook(fakeReq, null, botState.discordClient, pendingRequests, savePendingRequests);

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
  app.post("/api/test-random-pick", authenticateToken, async (_req, res) => {
    try {
      // Check if Discord bot is running and configured
      if (!botState.discordClient || !botState.discordClient.isReady()) {
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
      await sendDailyRandomPick(botState.discordClient);

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

      if (!botState.isBotRunning && hasConfigFile && hasDiscordCreds) {
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
