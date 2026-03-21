import { Router } from "express";
import { authenticateToken } from "../utils/auth.js";
import { validateBody, userMappingSchema } from "../utils/validation.js";
import {
  getUserMappings,
  saveUserMapping,
  deleteUserMapping,
  loadConfigToEnv,
} from "../utils/configFile.js";
import logger from "../utils/logger.js";

const router = Router();

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
