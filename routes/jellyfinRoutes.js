import { Router } from "express";
import axios from "axios";
import { authenticateToken } from "../utils/auth.js";
import { isMaskedValue } from "../utils/configSanitize.js";
import { TIMEOUTS } from "../lib/constants.js";
import { libraryCache } from "../jellyfinWebhook.js";
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

// Fetch Jellyfin libraries given a URL + API key (used by config UI before saving)
router.post("/jellyfin-libraries", authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;
    let { apiKey } = req.body;
    if (isMaskedValue(apiKey)) {
      apiKey = process.env.JELLYFIN_API_KEY;
    }

    if (!url || !apiKey) {
      return res.status(400).json({ success: false, message: "URL and API Key are required." });
    }
    if (!isAllowedUrl(url)) {
      return res.status(400).json({ success: false, message: "Invalid URL. Must be http or https." });
    }

    const safeUrl = new URL(url);
    safeUrl.pathname = safeUrl.pathname.replace(/\/$/, "") + "/Library/VirtualFolders";
    const response = await axios.get(
      safeUrl.href,
      {
        headers: { "X-MediaBrowser-Token": apiKey },
        timeout: TIMEOUTS.JELLYFIN_API,
      }
    );

    const items = Array.isArray(response.data) ? response.data : (response.data.Items ?? []);
    const libraries = items.map((item) => ({
      id: item.ItemId || item.Id,
      name: item.Name,
      type: item.CollectionType || "unknown",
    }));

    if (items.length > 0) {
      libraryCache.set(items);
      logger.info(`[LIBRARY CACHE] Updated cache with ${items.length} libraries`);
    }

    res.json({ success: true, libraries });
  } catch (err) {
    logger.error("[JELLYFIN LIBRARIES API] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Test Jellyfin connectivity
router.post("/test-jellyfin", authenticateToken, async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ success: false, message: "Jellyfin URL is required." });
  }
  if (!isAllowedUrl(url)) {
    return res.status(400).json({ success: false, message: "Invalid URL. Must be http or https." });
  }

  try {
    const safeUrl = new URL(url);
    safeUrl.pathname = safeUrl.pathname.replace(/\/$/, "") + "/System/Info/Public";
    const response = await axios.get(safeUrl.href, { timeout: TIMEOUTS.JELLYFIN_API });

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
    res.status(500).json({ success: false, message: "Connection failed. Check URL and network." });
  }
});

// Fetch libraries from configured Jellyfin instance
router.get("/jellyfin/libraries", authenticateToken, async (req, res) => {
  try {
    const apiKey = process.env.JELLYFIN_API_KEY;
    const baseUrl = process.env.JELLYFIN_BASE_URL;

    if (!apiKey || !baseUrl) {
      return res.status(400).json({
        success: false,
        message: "Jellyfin API key and URL are required in configuration.",
      });
    }

    const { fetchLibraries } = await import("../api/jellyfin.js");
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

export default router;
