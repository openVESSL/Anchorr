import { Router } from "express";
import fs from "fs";
import path from "path";
import { authenticateToken } from "../utils/auth.js";
import { readConfig } from "../utils/configFile.js";
import { sanitizeConfigForClient } from "../utils/configSanitize.js";
import { WEBHOOK_SECRET } from "../utils/auth.js";
import { configTemplate } from "../lib/config.js";
import logger from "../utils/logger.js";

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
