import { Router } from "express";
import axios from "axios";
import { authenticateToken } from "../utils/auth.js";
import { isMaskedValue } from "../utils/configSanitize.js";
import { TIMEOUTS } from "../lib/constants.js";
import { getSeerrApiUrl, normalizeSeerrUrl } from "../utils/seerrUrl.js";
import * as seerrApi from "../api/seerr.js";
import logger from "../utils/logger.js";

const router = Router();

function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_) {
    return false;
  }
}

router.get("/seerr-users", authenticateToken, async (req, res) => {
  try {
    logger.debug("[SEERR USERS API] Request received");
    const seerrUrl = process.env.SEERR_URL;
    const apiKey = process.env.SEERR_API_KEY;

    logger.debug("[SEERR USERS API] SEERR_URL:", seerrUrl);
    logger.debug("[SEERR USERS API] API_KEY present:", !!apiKey);

    if (!seerrUrl || !apiKey) {
      logger.debug("[SEERR USERS API] Missing configuration");
      return res.json({
        success: false,
        message: "Seerr configuration missing",
      });
    }

    const baseUrl = getSeerrApiUrl(seerrUrl);

    logger.debug("[SEERR USERS API] Making request to:", `${baseUrl}/user`);

    let response;
    try {
      logger.info("[SEERR USERS API] Fetching users from Seerr (real-time)...");
      response = await axios.get(`${baseUrl}/user?take=1000`, {
        headers: { "X-Api-Key": apiKey },
        timeout: TIMEOUTS.SEERR_API,
      });
      logger.info("[SEERR USERS API] ✅ Users fetched successfully (real-time)");
    } catch (fetchErr) {
      logger.error("[SEERR USERS API] Failed to fetch users:", fetchErr.message);
      throw fetchErr;
    }

    logger.debug("[SEERR USERS API] Response received, status:", response.status);
    logger.debug("[SEERR USERS API] Response data type:", typeof response.data);
    logger.debug("[SEERR USERS API] Response data is array:", Array.isArray(response.data));
    if (!Array.isArray(response.data)) {
      logger.debug("[SEERR USERS API] Response data keys:", Object.keys(response.data));
    }
    logger.debug(
      "[SEERR USERS API] Response data length:",
      Array.isArray(response.data)
        ? response.data.length
        : response.data.results?.length || "N/A"
    );

    const userData = response.data.results || [];

    const users = userData
      .map((user) => {
        let avatar = user.avatar || null;
        if (avatar && !avatar.startsWith("http")) {
          avatar = `${normalizeSeerrUrl(seerrUrl)}${avatar}`;
        }
        return {
          id: user.id,
          displayName: user.displayName || user.username || `User ${user.id}`,
          username: user.username || "",
          email: user.email || "",
          avatar,
        };
      })
      .sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));

    logger.info(`[SEERR USERS API] ✅ Returning ${users.length} users (real-time)`);
    res.json({ success: true, users, fetchedRealtime: true });
  } catch (err) {
    logger.error("[SEERR USERS API] Error:", err.message);
    if (err.response) {
      logger.error("[SEERR USERS API] Response status:", err.response.status);
      logger.error("[SEERR USERS API] Response data:", err.response.data);
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/test-seerr", authenticateToken, async (req, res) => {
  const { url, apiKey } = req.body;
  const effectiveApiKey = isMaskedValue(apiKey) ? process.env.SEERR_API_KEY : apiKey;
  if (!url || !effectiveApiKey) {
    return res.status(400).json({ success: false, message: "URL and API Key are required." });
  }
  if (!isAllowedUrl(url)) {
    return res.status(400).json({ success: false, message: "Invalid URL. Must be http or https." });
  }

  try {
    const baseUrl = getSeerrApiUrl(url);

    const response = await axios.get(`${baseUrl}/settings/about`, {
      headers: { "X-Api-Key": effectiveApiKey },
      timeout: TIMEOUTS.SEERR_API,
    });
    const version = response.data?.version;
    res.json({ success: true, message: `Connection successful! (v${version})` });
  } catch (error) {
    logger.error("Seerr test failed:", error.message);
    if (error.response && [401, 403].includes(error.response.status)) {
      return res.status(401).json({ success: false, message: "Invalid API Key." });
    }
    res.status(500).json({ success: false, message: "Connection failed. Check URL and API Key." });
  }
});

router.post("/seerr/quality-profiles", authenticateToken, async (req, res) => {
  const { url, apiKey } = req.body;
  const effectiveApiKey = isMaskedValue(apiKey) ? process.env.SEERR_API_KEY : apiKey;
  if (!url || !effectiveApiKey) {
    return res.status(400).json({ success: false, message: "URL and API Key are required." });
  }
  if (!isAllowedUrl(url)) {
    return res.status(400).json({ success: false, message: "Invalid URL. Must be http or https." });
  }

  try {
    const baseUrl = getSeerrApiUrl(url);

    const profiles = await seerrApi.fetchQualityProfiles(baseUrl, effectiveApiKey);
    res.json({ success: true, profiles });
  } catch (error) {
    logger.error("Failed to fetch quality profiles:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch quality profiles." });
  }
});

router.post("/seerr/servers", authenticateToken, async (req, res) => {
  const { url, apiKey } = req.body;
  const effectiveApiKey = isMaskedValue(apiKey) ? process.env.SEERR_API_KEY : apiKey;
  if (!url || !effectiveApiKey) {
    return res.status(400).json({ success: false, message: "URL and API Key are required." });
  }
  if (!isAllowedUrl(url)) {
    return res.status(400).json({ success: false, message: "Invalid URL. Must be http or https." });
  }

  try {
    const baseUrl = getSeerrApiUrl(url);

    const servers = await seerrApi.fetchServers(baseUrl, effectiveApiKey);
    res.json({ success: true, servers });
  } catch (error) {
    logger.error("Failed to fetch servers:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch servers." });
  }
});

export default router;
