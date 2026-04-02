import { Router } from "express";
import { authenticateToken } from "../utils/auth.js";
import { validateBody, userMappingSchema } from "../utils/validation.js";
import {
  getUserMappings,
  saveUserMapping,
  deleteUserMapping,
  loadConfigToEnv,
} from "../utils/configFile.js";
import { botState } from "../bot/botState.js";
import logger from "../utils/logger.js";

const router = Router();

router.get("/discord-user/:userId", authenticateToken, async (req, res) => {
  const { userId } = req.params;

  if (!/^\d{17,20}$/.test(userId)) {
    return res.status(400).json({ success: false, message: "Invalid Discord user ID." });
  }

  if (!botState.isBotRunning || !botState.discordClient) {
    return res.status(503).json({ success: false, message: "Bot is not running." });
  }

  try {
    const user = await botState.discordClient.users.fetch(userId);
    res.json({
      success: true,
      id: user.id,
      username: user.username,
      displayName: user.displayName ?? user.globalName ?? user.username,
      avatar: user.displayAvatarURL({ size: 64, extension: "png" }),
    });
  } catch (err) {
    if (err.code === 10013 || err.status === 404) {
      return res.status(404).json({ success: false, message: "Discord user not found." });
    }
    logger.error(`[DISCORD USER LOOKUP] Failed to fetch user ${userId}:`, err.message);
    res.status(502).json({ success: false, message: "Failed to reach Discord API." });
  }
});

router.get("/user-mappings", authenticateToken, (req, res) => {
  const mappings = getUserMappings();
  res.json(mappings);
});

router.post(
  "/user-mappings",
  authenticateToken,
  validateBody(userMappingSchema),
  (req, res) => {
    const {
      discordUserId,
      seerrUserId,
      discordUsername,
      discordDisplayName,
      seerrDisplayName,
    } = req.body;

    if (!discordUserId || !seerrUserId) {
      return res.status(400).json({
        success: false,
        message: "Discord user ID and Seerr user ID are required.",
      });
    }

    try {
      const mapping = {
        discordUserId,
        seerrUserId,
        discordUsername: discordUsername || null,
        discordDisplayName: discordDisplayName || null,
        seerrDisplayName: seerrDisplayName || null,
      };

      saveUserMapping(mapping);
      loadConfigToEnv();

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

router.post("/user-mappings/auto-map", authenticateToken, async (req, res) => {
  const { mappings } = req.body;

  if (!Array.isArray(mappings) || mappings.length === 0) {
    return res.status(400).json({ success: false, message: "No mappings provided." });
  }

  if (mappings.length > 500) {
    return res.status(400).json({ success: false, message: "Too many mappings (max 500)." });
  }

  const existingMappings = getUserMappings();
  const mappedDiscordIds = new Set(existingMappings.map((m) => m.discordUserId));

  let saved = 0;
  let skipped = 0;

  for (const m of mappings) {
    if (!m.discordId || !/^\d{17,20}$/.test(m.discordId) || !m.seerrUserId || !Number.isInteger(Number(m.seerrUserId))) {
      skipped++;
      continue;
    }
    if (mappedDiscordIds.has(m.discordId)) {
      skipped++;
      continue;
    }

    let discordUsername = null;
    let discordDisplayName = null;
    let discordAvatar = null;

    if (botState.isBotRunning && botState.discordClient) {
      try {
        const user = await botState.discordClient.users.fetch(m.discordId);
        discordUsername = user.username;
        discordDisplayName = user.displayName ?? user.globalName ?? user.username;
        discordAvatar = user.displayAvatarURL({ size: 64, extension: "png" });
      } catch (err) {
        logger.warn(`[AUTO-MAP] Could not resolve Discord user ${m.discordId} — saving with ID only:`, err.message);
      }
    }

    try {
      saveUserMapping({
        discordUserId: m.discordId,
        seerrUserId: m.seerrUserId,
        discordUsername,
        discordDisplayName,
        discordAvatar,
        seerrDisplayName: typeof m.seerrDisplayName === "string" ? m.seerrDisplayName.trim().slice(0, 100) : null,
      });
      mappedDiscordIds.add(m.discordId);
      saved++;
    } catch (err) {
      logger.error(`[AUTO-MAP] Failed to save mapping for ${m.discordId}:`, err.message);
      skipped++;
    }
  }

  if (saved > 0) loadConfigToEnv();

  logger.info(`[AUTO-MAP] Saved ${saved} mappings, skipped ${skipped}`);
  res.json({ success: true, saved, skipped });
});

router.post("/user-mappings/sync-remove", authenticateToken, (req, res) => {
  const { discordIds } = req.body;

  if (!Array.isArray(discordIds) || discordIds.length === 0) {
    return res.status(400).json({ success: false, message: "No Discord IDs provided." });
  }

  if (discordIds.length > 500) {
    return res.status(400).json({ success: false, message: "Too many IDs (max 500)." });
  }

  let removed = 0;
  let skipped = 0;
  let errored = 0;

  for (const id of discordIds) {
    if (typeof id !== "string" || !/^\d{17,20}$/.test(id)) {
      skipped++;
      continue;
    }
    try {
      const deleted = deleteUserMapping(id);
      if (deleted) {
        removed++;
      } else {
        skipped++;
      }
    } catch (err) {
      logger.error(`[SYNC-REMOVE] Failed to delete mapping for ${id}:`, err.message);
      errored++;
      skipped++;
    }
  }

  if (removed > 0) {
    const envLoaded = loadConfigToEnv();
    if (!envLoaded) {
      logger.error("[SYNC-REMOVE] loadConfigToEnv failed after deleting mappings — bot env may be stale");
      return res.status(500).json({
        success: false,
        message: `Deleted ${removed} mapping(s) from disk but failed to reload config. Restart the bot or check disk permissions.`,
      });
    }
  }

  if (errored > 0) {
    logger.warn(`[SYNC-REMOVE] ${errored} deletion(s) failed with errors`);
  }

  logger.info(`[SYNC-REMOVE] Removed ${removed} mappings, skipped ${skipped}`);
  res.json({ success: true, removed, skipped, errored });
});

router.delete("/user-mappings/:discordUserId", authenticateToken, (req, res) => {
  const { discordUserId } = req.params;

  try {
    const deleted = deleteUserMapping(discordUserId);

    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Mapping not found." });
    }

    loadConfigToEnv();

    res.json({ success: true, message: "Mapping deleted successfully." });
  } catch (error) {
    logger.error("Error deleting user mapping:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete mapping - check server logs.",
    });
  }
});

export default router;
