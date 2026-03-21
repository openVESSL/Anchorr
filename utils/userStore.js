import logger from "./logger.js";
import { readConfig, writeConfig } from "./configFile.js";

/**
 * Get USERS array from config
 * @returns {Array} Array of user objects
 */
export function getUsers() {
  const config = readConfig();
  return config?.USERS || [];
}

/**
 * Save a new user to config.json
 * @param {string} username - Username
 * @param {string} passwordHash - Bcrypt hashed password
 * @returns {Object} The newly created user object
 * @throws {Error} If save fails
 */
export function saveUser(username, passwordHash) {
  const config = readConfig() || {};

  if (!config.USERS) {
    config.USERS = [];
  }

  const newUser = {
    id: Date.now().toString(),
    username,
    password: passwordHash,
    createdAt: new Date().toISOString(),
  };

  config.USERS.push(newUser);

  if (!writeConfig(config)) {
    throw new Error("Failed to save user to config.json - check permissions");
  }

  logger.info(`✅ User "${username}" saved to config.json`);
  return newUser;
}
