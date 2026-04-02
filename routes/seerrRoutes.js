import { Router } from "express";
import axios from "axios";
import { authenticateToken } from "../utils/auth.js";
import { isMaskedValue } from "../utils/configSanitize.js";
import { TIMEOUTS } from "../lib/constants.js";
import { getSeerrApiUrl, normalizeSeerrUrl } from "../utils/seerrUrl.js";
import * as seerrApi from "../api/seerr.js";
import { getUserMappings } from "../utils/configFile.js";
import { botState } from "../bot/botState.js";
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

    const userData = Array.isArray(response.data) ? response.data : (response.data.results || []);

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
    const safeUrl = new URL(getSeerrApiUrl(url));
    safeUrl.pathname = safeUrl.pathname.replace(/\/$/, "") + "/settings/about";

    const response = await axios.get(safeUrl.href, {
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
    const safeBase = new URL(getSeerrApiUrl(url)).href.replace(/\/$/, "");

    const profiles = await seerrApi.fetchQualityProfiles(safeBase, effectiveApiKey);
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
    const safeBase = new URL(getSeerrApiUrl(url)).href.replace(/\/$/, "");

    const servers = await seerrApi.fetchServers(safeBase, effectiveApiKey);
    res.json({ success: true, servers });
  } catch (error) {
    logger.error("Failed to fetch servers:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch servers." });
  }
});

router.get("/seerr/auto-map-preview", authenticateToken, async (_req, res) => {
  const seerrUrl = process.env.SEERR_URL;
  const apiKey = process.env.SEERR_API_KEY;

  if (!seerrUrl || !apiKey) {
    return res.status(400).json({ success: false, message: "Seerr not configured." });
  }

  try {
    const baseUrl = getSeerrApiUrl(seerrUrl);

    const usersRes = await axios.get(`${baseUrl}/user?take=1000`, {
      headers: { "X-Api-Key": apiKey },
      timeout: TIMEOUTS.SEERR_API,
    });
    const userData = Array.isArray(usersRes.data)
      ? usersRes.data
      : usersRes.data.results || [];

    const existingMappings = getUserMappings();
    const mappedDiscordIds = new Set(existingMappings.map((m) => m.discordUserId));

    const candidates = [];
    const BATCH_SIZE = 5;

    for (let i = 0; i < userData.length; i += BATCH_SIZE) {
      const batch = userData.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (user) => {
          const settingsRes = await axios.get(
            `${baseUrl}/user/${user.id}/settings/notifications`,
            { headers: { "X-Api-Key": apiKey }, timeout: TIMEOUTS.SEERR_API }
          );
          return { user, discordId: settingsRes.data?.discordId || null };
        })
      );

      for (const result of results) {
        if (result.status !== "fulfilled" || !result.value.discordId) continue;
        const { user, discordId } = result.value;
        if (mappedDiscordIds.has(discordId)) continue;

        let avatar = user.avatar || null;
        if (avatar && !avatar.startsWith("http")) {
          avatar = `${normalizeSeerrUrl(seerrUrl)}${avatar}`;
        }
        candidates.push({
          seerrUserId: user.id,
          seerrDisplayName: user.displayName || user.username || `User ${user.id}`,
          seerrAvatar: avatar,
          discordId,
        });
      }
    }

    // Resolve Discord names + avatars server-side (sequential, cache-first) to avoid
    // flooding the dashboard rate limiter with N parallel browser requests on each open.
    if (botState.isBotRunning && botState.discordClient) {
      for (const candidate of candidates) {
        try {
          const cached = botState.discordClient.users.cache.get(candidate.discordId);
          const user = cached || await botState.discordClient.users.fetch(candidate.discordId);
          candidate.discordUsername = user.username;
          candidate.discordDisplayName = user.displayName ?? user.globalName ?? user.username;
          candidate.discordAvatar = user.displayAvatarURL({ size: 64, extension: "png" });
        } catch (err) {
          logger.warn(`[AUTO-MAP] Could not resolve Discord user ${candidate.discordId}:`, err.message);
        }
      }
    }

    logger.info(`[AUTO-MAP] Found ${candidates.length} unmapped Seerr users with a Discord ID`);
    res.json({ success: true, candidates });
  } catch (err) {
    logger.error("[AUTO-MAP] Preview failed:", err.message);
    const statusCode = err.response?.status;
    const clientMessage = statusCode
      ? `Seerr returned ${statusCode} — check your API key and URL.`
      : "Failed to fetch auto-map preview — check server logs.";
    res.status(500).json({ success: false, message: clientMessage });
  }
});

router.get("/seerr/sync-preview", authenticateToken, async (_req, res) => {
  const seerrUrl = process.env.SEERR_URL;
  const apiKey = process.env.SEERR_API_KEY;

  if (!seerrUrl || !apiKey) {
    return res.status(400).json({ success: false, message: "Seerr not configured." });
  }

  try {
    const baseUrl = getSeerrApiUrl(seerrUrl);
    const existingMappings = getUserMappings();

    if (existingMappings.length === 0) {
      return res.json({ success: true, stale: [] });
    }

    const stale = [];
    const BATCH_SIZE = 5;

    for (let i = 0; i < existingMappings.length; i += BATCH_SIZE) {
      const batch = existingMappings.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (mapping) => {
          const settingsRes = await axios.get(
            `${baseUrl}/user/${mapping.seerrUserId}/settings/notifications`,
            { headers: { "X-Api-Key": apiKey }, timeout: TIMEOUTS.SEERR_API }
          );
          return { mapping, currentDiscordId: settingsRes.data?.discordId || null };
        })
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const mapping = batch[j];

        if (result.status !== "fulfilled") {
          const status = result.reason?.response?.status;
          if (status === 404) {
            // Seerr user no longer exists — mapping is stale
            stale.push({
              discordId: mapping.discordUserId,
              seerrUserId: mapping.seerrUserId,
              seerrDisplayName: mapping.seerrDisplayName || null,
              discordUsername: mapping.discordUsername || null,
              discordDisplayName: mapping.discordDisplayName || null,
              currentSeerrDiscordId: null,
              reason: "seerr_user_not_found",
            });
          } else {
            // Transient error (timeout, 500, 429) — skip to avoid false positives
            logger.warn(`[SYNC] Could not check mapping for Seerr user ${mapping.seerrUserId}: ${result.reason?.message}`);
          }
          continue;
        }

        const { currentDiscordId } = result.value;
        if (currentDiscordId !== mapping.discordUserId) {
          stale.push({
            discordId: mapping.discordUserId,
            seerrUserId: mapping.seerrUserId,
            seerrDisplayName: mapping.seerrDisplayName || null,
            discordUsername: mapping.discordUsername || null,
            discordDisplayName: mapping.discordDisplayName || null,
            currentSeerrDiscordId: currentDiscordId,
            reason: currentDiscordId ? "discord_id_changed" : "discord_unlinked",
          });
        }
      }
    }

    logger.info(`[SYNC] Found ${stale.length} stale mappings`);
    res.json({ success: true, stale });
  } catch (err) {
    logger.error("[SYNC] Preview failed:", err);
    res.status(500).json({ success: false, message: "Failed to fetch sync preview — check server logs." });
  }
});

export default router;
