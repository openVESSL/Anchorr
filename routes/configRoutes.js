import { Router } from "express";
import fs from "fs";
import path from "path";
import { authenticateToken } from "../utils/auth.js";
import { restartBot } from "../bot/botManager.js";
import { botState } from "../bot/botState.js";
import { CONFIG_PATH, decodeConfig, loadSettings, readConfig, writeConfig } from "../utils/configFile.js";
import { sanitizeConfigForClient } from "../utils/configSanitize.js";
import { WEBHOOK_SECRET } from "../utils/auth.js";
import { configTemplate } from "../lib/config.js";
import logger from "../utils/logger.js";
import { configSchema } from "../utils/validation.js";

const router = Router();

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
  "Surrogate-Control": "no-store",
};

router.get("/config", authenticateToken, (req, res) => {
  Object.entries(NO_CACHE_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  const config = readConfig();
  res.json(sanitizeConfigForClient(config ?? configTemplate));
});

// Full config.json as stored on disk (secrets encoded, not encrypted), for moving or rolling back an install.
router.get("/config/backup", authenticateToken, (req, res) => {
  Object.entries(NO_CACHE_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (!fs.existsSync(CONFIG_PATH)) return res.status(404).json({ success: false, error: "There is no configuration to back up yet." });
  const date = new Date().toISOString().slice(0, 10);
  res.download(CONFIG_PATH, `anchorr-config-${date}.json`);
});

// Replaces config.json with an uploaded backup. The current file is kept as config.before-restore.json.
// This install's own secrets and network settings stay, so the session survives and the port does not move.
router.post("/config/restore", authenticateToken, async (req, res) => {
  const backup = req.body;
  if (!backup || typeof backup !== "object" || Array.isArray(backup) || !Object.keys(backup).some((k) => k in configTemplate)) {
    return res.status(400).json({ success: false, error: "This file is not an Anchorr configuration backup." });
  }
  const { error } = configSchema.validate(decodeConfig(backup), { abortEarly: false, allowUnknown: true });
  if (error) {
    return res.status(400).json({ success: false, error: `The backup has invalid values: ${error.details.map((d) => d.message).join("; ")}` });
  }

  const current = readConfig() || {};
  const restored = decodeConfig(backup);
  for (const key of ["JWT_SECRET", "WEBHOOK_SECRET", "WEBHOOK_PORT", "BIND_HOST"]) {
    if (key in current) restored[key] = current[key];
    else delete restored[key];
  }

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const keepPath = path.join(path.dirname(CONFIG_PATH), "config.before-restore.json");
      fs.copyFileSync(CONFIG_PATH, keepPath);
      fs.chmodSync(keepPath, 0o600);
    }
  } catch (err) {
    logger.error(`Could not keep a copy of the current config before restoring: ${err.message}`);
    return res.status(500).json({ success: false, error: "Could not keep a copy of the current configuration, nothing was changed." });
  }

  if (!writeConfig(restored)) {
    return res.status(500).json({ success: false, error: "Failed to save configuration file. Check Docker volume permissions and server logs." });
  }
  try {
    // Runs the v1 migrations when the backup is an older format. No 1.x folder backup here:
    // the current folder is not a 1.x one, and the uploaded file is its own copy.
    if (!loadSettings({ backupV1: false })) throw new Error("the restored file could not be loaded");
  } catch (err) {
    logger.error("Restored config.json, but loading it failed:", err);
    return res.status(500).json({
      success: false,
      error: `The backup was saved but only partly applied: ${err.message}. To return to the previous configuration, put back config.before-restore.json from the config folder and restart Anchorr.`,
    });
  }
  logger.info("✅ Configuration restored from a backup");

  if (botState.isBotRunning) {
    try {
      await restartBot();
    } catch (err) {
      return res.status(500).json({ success: false, error: `Configuration restored, but the bot failed to restart: ${err.message}` });
    }
  }
  res.json({ success: true });
});

router.get("/webhook-secret", authenticateToken, (req, res) => {
  Object.entries(NO_CACHE_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  res.json({ secret: WEBHOOK_SECRET || null });
});

router.get("/languages", async (req, res) => {
  try {
    const localesDir = path.join(process.cwd(), "locales");
    const files = fs.readdirSync(localesDir);
    const languages = [];

    for (const file of files) {
      if (file.endsWith(".json") && file !== "template.json") {
        try {
          const langData = JSON.parse(
            fs.readFileSync(path.join(localesDir, file), "utf8")
          );
          if (langData._meta?.language_code && langData._meta?.language_name) {
            languages.push({
              code: langData._meta.language_code,
              name: langData._meta.language_name,
            });
          }
        } catch (error) {
          logger.warn(`Failed to parse language file ${file}: ${error.message}`);
        }
      }
    }

    languages.sort((a, b) => a.name.localeCompare(b.name));
    res.json(languages);
  } catch (error) {
    logger.error(`Failed to load available languages: ${error.message}`);
    res.json([
      { code: "en", name: "English" },
      { code: "de", name: "Deutsch" },
      { code: "sv", name: "Svenska" },
    ]);
  }
});

export default router;
