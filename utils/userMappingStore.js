import logger from "./logger.js";
import { readConfig, writeConfig } from "./configFile.js";

/**
 * Get USER_MAPPINGS array from config
 * @returns {Array} Array of mapping objects
 */
export function getUserMappings() {
  const config = readConfig();
  return config?.USER_MAPPINGS || [];
}

/**
 * Save or update a user mapping
 * @param {Object} mapping - Mapping object with discordUserId, seerrUserId, etc.
 * @returns {Object} The saved mapping object
 * @throws {Error} If save fails
 */
export function saveUserMapping(mapping) {
  const config = readConfig() || {};

  if (!config.USER_MAPPINGS) {
    config.USER_MAPPINGS = [];
  }

  // Check if mapping already exists for this Discord user
  const existingIndex = config.USER_MAPPINGS.findIndex(
    (m) => m.discordUserId === mapping.discordUserId
  );

  const newMapping = {
    ...mapping,
    createdAt: mapping.createdAt || new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    config.USER_MAPPINGS[existingIndex] = newMapping;
    logger.info(
      `✅ Updated user mapping for Discord user ${mapping.discordUserId}`
    );
  } else {
    config.USER_MAPPINGS.push(newMapping);
    logger.info(
      `✅ Added new user mapping for Discord user ${mapping.discordUserId}`
    );
  }

  if (!writeConfig(config)) {
    throw new Error(
      "Failed to save user mapping to config.json - check permissions"
    );
  }

  return newMapping;
}

/**
 * Delete a user mapping by Discord user ID
 * @param {string} discordUserId - Discord user ID to remove
 * @returns {boolean} True if deleted, false if not found
 */
export function deleteUserMapping(discordUserId) {
  const config = readConfig() || {};

  if (!config.USER_MAPPINGS || config.USER_MAPPINGS.length === 0) {
    return false;
  }

  const initialLength = config.USER_MAPPINGS.length;
  config.USER_MAPPINGS = config.USER_MAPPINGS.filter(
    (m) => m.discordUserId !== discordUserId
  );

  if (config.USER_MAPPINGS.length === initialLength) {
    return false; // Not found
  }

  if (!writeConfig(config)) {
    throw new Error("Failed to save config after deleting user mapping");
  }

  logger.info(`✅ Deleted user mapping for Discord user ${discordUserId}`);
  return true;
}
