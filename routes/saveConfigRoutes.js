// Saving the dashboard configuration (and restarting the bot when needed).
import { Router } from "express";
import fs from "fs";
import rateLimit from "express-rate-limit";
import { isMokaMode, updateMokaUser } from "../api/moka.js";
import { setGuestAutoApprove } from "../api/seerr.js";
import { restartBot, startBot } from "../bot/botManager.js";
import { scheduleDailyRandomPick } from "../bot/dailyPick.js";
import { botState } from "../bot/botState.js";
import { authenticateToken } from "../utils/auth.js";
import { CONFIG_PATH, loadSettings, readConfig, writeConfig } from "../utils/configFile.js";
import { SENSITIVE_FIELDS, isMaskedValue } from "../utils/configSanitize.js";
import logger from "../utils/logger.js";
import { normalizeSeerrUrl } from "../utils/seerrUrl.js";
import { settings } from "../utils/settings.js";
import { DASHBOARD_PROTECTED_KEYS, saveConfigSchema, validateBody } from "../utils/validation.js";

const router = Router();

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

router.post(
  "/save-config",
  authenticateToken,
  configLimiter,
  validateBody(saveConfigSchema, { stripUnknown: true }),
  async (req, res) => {
    const configData = req.body;
    const oldToken = settings.DISCORD_TOKEN;
    const oldGuildId = settings.GUILD_ID;
    const oldJellyfinApiKey = settings.JELLYFIN_API_KEY;
    const oldAutoApprove = settings.SEERR_AUTO_APPROVE;
    const DAILY_PICK_KEYS = ["DAILY_RANDOM_PICK_ENABLED", "DAILY_RANDOM_PICK_CHANNEL_ID", "DAILY_RANDOM_PICK_INTERVAL"];
    const oldDailyPick = DAILY_PICK_KEYS.map((k) => settings[k]).join("|");
    const oldMoka = isMokaMode();

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
      const onDisk = readConfig();
      // Unreadable is not empty: writing now would drop the accounts, links and tokens in it
      if (!onDisk && fs.existsSync(CONFIG_PATH)) {
        logger.error("save-config: config.json exists but could not be read; nothing was saved");
        return res.status(500).json({
          success: false,
          error: "config.json could not be read, so nothing was saved. Fix or restore the file, then try again.",
        });
      }
      const existingConfig = onDisk || {};

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

      // Deployment settings and server-managed state are never taken from the request
      for (const key of DASHBOARD_PROTECTED_KEYS) {
        if (["USER_MAPPINGS", "USERS", "JWT_SECRET", "WEBHOOK_SECRET"].includes(key)) continue;
        if (key in existingConfig) finalConfig[key] = existingConfig[key];
        else delete finalConfig[key];
      }
      delete finalConfig.startBot; // one-shot flag, v1 used to persist it

      // Preserve sensitive fields only when the frontend sends a masked placeholder
      // or omits the field entirely — an explicit empty string intentionally clears the credential
      for (const field of SENSITIVE_FIELDS) {
        if (!(field in configData) || isMaskedValue(configData[field])) {
          finalConfig[field] = existingConfig[field] || "";
        }
      }

      // A guest id belongs to one Seerr; the next request looks the guest up again
      const seerrChanged =
        normalizeSeerrUrl(finalConfig.SEERR_URL || "") !== normalizeSeerrUrl(existingConfig.SEERR_URL || "") ||
        (finalConfig.SEERR_API_KEY || "") !== (existingConfig.SEERR_API_KEY || "");
      if (seerrChanged) finalConfig.SEERR_GUEST_USER_ID = "";

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

    loadSettings(); // Reload config into the settings store

    // With Moka, the switch sets Moka's guest account; linked people keep their own rights there
    if (oldAutoApprove !== settings.SEERR_AUTO_APPROVE && isMokaMode() && settings.MOKA_GUEST_USER_ID) {
      const on = settings.SEERR_AUTO_APPROVE === "true";
      updateMokaUser(settings.MOKA_GUEST_USER_ID, { auto_approve_movies: on, auto_approve_shows: on }).catch((err) =>
        logger.warn(`Could not update the Moka guest account's auto-approve: ${err.message}`)
      );
    }
    // The auto-approve switch only governs the guest account; mapped users keep their own Seerr permissions
    else if (oldAutoApprove !== settings.SEERR_AUTO_APPROVE && settings.SEERR_GUEST_USER_ID) {
      setGuestAutoApprove({
        seerrUrl: settings.SEERR_URL,
        apiKey: settings.SEERR_API_KEY,
        guestUserId: settings.SEERR_GUEST_USER_ID,
        autoApprove: settings.SEERR_AUTO_APPROVE === "true",
      }).catch((err) => logger.warn(`Could not update the guest account's auto-approve permission: ${err.message}`));
    }

    // Check if Discord credentials are complete and changed
    const hasDiscordCreds = settings.DISCORD_TOKEN && settings.BOT_ID;
    const discordCredsChanged = oldToken !== settings.DISCORD_TOKEN;

    // If bot is running and critical settings changed, restart the bot logic
    const jellyfinApiKeyChanged =
      oldJellyfinApiKey !== settings.JELLYFIN_API_KEY;
    // Turning Moka on or off (when connected) changes /request and where new titles come from
    const needsRestart =
      oldToken !== settings.DISCORD_TOKEN ||
      oldGuildId !== settings.GUILD_ID ||
      jellyfinApiKeyChanged ||
      oldMoka !== isMokaMode();

    // A restart schedules the daily pick itself; otherwise apply its new settings now
    if (botState.isBotRunning && !needsRestart && DAILY_PICK_KEYS.map((k) => settings[k]).join("|") !== oldDailyPick) {
      scheduleDailyRandomPick(botState.discordClient);
    }

    if (botState.isBotRunning && needsRestart) {
      logger.warn(
        "Critical Discord settings changed. Restarting bot logic..."
      );

      try {
        await restartBot();
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
          res.status(500).json({
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
router.post("/check-autostart", authenticateToken, async (req, res) => {
  const configData = req.body;
  const oldToken = settings.DISCORD_TOKEN;

  // Resolve effective token (masked values mean "use existing")
  const effectiveToken = isMaskedValue(configData.DISCORD_TOKEN)
    ? settings.DISCORD_TOKEN
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

export default router;
