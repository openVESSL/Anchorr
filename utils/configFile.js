import fs from "fs";
import path from "path";
import logger from "./logger.js";
import { configSchema } from "./validation.js";

// Fields that contain sensitive credentials and should be base64-encoded at rest
const SENSITIVE_FIELDS = new Set([
  "DISCORD_TOKEN",
  "JELLYSEERR_API_KEY",
  "JELLYFIN_API_KEY",
  "WEBHOOK_SECRET",
  "JWT_SECRET",
  "TMDB_API_KEY",
  "OMDB_API_KEY",
]);

const B64_PREFIX = "b64:";

function encodeConfig(config) {
  const out = { ...config };
  for (const field of SENSITIVE_FIELDS) {
    if (out[field] && typeof out[field] === "string" && out[field] !== "" && !out[field].startsWith(B64_PREFIX)) {
      out[field] = B64_PREFIX + Buffer.from(out[field], "utf8").toString("base64");
    }
  }
  return out;
}

function decodeConfig(config) {
  const out = { ...config };
  for (const field of SENSITIVE_FIELDS) {
    if (out[field] && typeof out[field] === "string" && out[field].startsWith(B64_PREFIX)) {
      out[field] = Buffer.from(out[field].slice(B64_PREFIX.length), "base64").toString("utf8");
    }
  }
  return out;
}

/**
 * CONFIG_PATH determines where config.json is saved and read:
 * - Primary location: /config (mounted volume on Docker/Unraid)
 * - Secondary: /usr/src/app/config (Docker internal)
 * - Fallback: ./config (local development)
 * - Legacy location: ./lib/config (old location, used for migration)
 */

// Old location for backwards compatibility
const LEGACY_CONFIG_PATH = path.join(process.cwd(), "lib", "config.json");

const getNewConfigPath = () => {
  // First priority: Check if /config exists and is writable (user-mounted volume)
  if (fs.existsSync("/config")) {
    try {
      const testFile = path.join("/config", ".write-test");
      fs.writeFileSync(testFile, "test");
      fs.unlinkSync(testFile);
      // /config is writable, use it
      return "/config/config.json";
    } catch (e) {
      // /config exists but not writable, continue to next option
    }
  }

  // Second priority: /usr/src/app/config (Docker internal)
  if (fs.existsSync("/usr/src/app")) {
    return "/usr/src/app/config/config.json";
  }

  // Fallback: Local project directory
  return path.join(process.cwd(), "config", "config.json");
};

export const CONFIG_PATH = getNewConfigPath();

/**
 * Find config file - checks new location first, then legacy location
 * Returns path to existing config file or null
 */
function findExistingConfig() {
  // Check new location first
  if (fs.existsSync(CONFIG_PATH)) {
    return CONFIG_PATH;
  }

  // Check legacy location
  if (fs.existsSync(LEGACY_CONFIG_PATH)) {
    logger.info(`🔄 Found config at legacy location: ${LEGACY_CONFIG_PATH}`);
    return LEGACY_CONFIG_PATH;
  }

  return null;
}

/**
 * Migrate config from legacy location to new location (one-time operation)
 */
function migrateConfigIfNeeded() {
  // If config already exists at new location, no migration needed
  if (fs.existsSync(CONFIG_PATH)) {
    return;
  }

  // Check if config exists at legacy location
  if (!fs.existsSync(LEGACY_CONFIG_PATH)) {
    return; // No config to migrate
  }

  try {
    logger.info(
      `🔄 Migrating config from ${LEGACY_CONFIG_PATH} to ${CONFIG_PATH}...`
    );

    // Read from legacy location
    const rawData = fs.readFileSync(LEGACY_CONFIG_PATH, "utf-8");
    const config = JSON.parse(rawData);

    // Ensure new directory exists
    const configDir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o777 });
    }

    // Write to new location
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), {
      mode: 0o600,
      encoding: "utf-8",
    });

    logger.info(
      `✅ Config successfully migrated to new location: ${CONFIG_PATH}`
    );
    logger.info(
      `   You can safely delete the old config at: ${LEGACY_CONFIG_PATH}`
    );
  } catch (error) {
    logger.error(`❌ Config migration failed:`, error);
    throw error; // Critical error - fail startup
  }
}

/**
 * Reads config.json and returns the parsed object
 * @returns {Object|null} Config object or null if doesn't exist
 */
export function readConfig() {
  const configPath = findExistingConfig();

  if (!configPath) {
    logger.debug(
      `Config file not found (checked ${CONFIG_PATH} and ${LEGACY_CONFIG_PATH})`
    );
    return null;
  }

  try {
    const rawData = fs.readFileSync(configPath, "utf-8");
    const config = decodeConfig(JSON.parse(rawData));
    logger.debug(`Config loaded successfully from ${configPath}`);
    return config;
  } catch (error) {
    logger.error(`Error reading config from ${configPath}:`, error);
    return null;
  }
}

/**
 * Writes entire config object to config.json with robust error handling
 * @param {Object} config - Config object to save
 * @returns {boolean} True if save succeeded
 */
export function writeConfig(config) {
  const configDir = path.dirname(CONFIG_PATH);
  try {
    // Ensure /config directory exists
    if (!fs.existsSync(configDir)) {
      logger.info(`Creating config directory: ${configDir}`);
      fs.mkdirSync(configDir, { recursive: true, mode: 0o777 });
    }

    // Write with explicit permissions (sensitive fields are base64-encoded)
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(encodeConfig(config), null, 2), {
      mode: 0o600,
      encoding: "utf-8",
    });

    logger.debug(`Config saved successfully to ${CONFIG_PATH}`);
    return true;
  } catch (error) {
    logger.error(
      `❌ CRITICAL: Failed to write config to ${CONFIG_PATH}`,
      error
    );

    // Detailed error diagnostics
    if (error.code === "EACCES") {
      logger.error(`❌ Permission denied writing to ${CONFIG_PATH}`);
      logger.error(
        `   Try: chmod 666 ${CONFIG_PATH} or check Docker volume permissions`
      );
      logger.error(
        `   Current user: uid=${process.getuid?.() || "N/A"}, gid=${
          process.getgid?.() || "N/A"
        }`
      );
    } else if (error.code === "ENOENT") {
      logger.error(`❌ Directory does not exist: ${configDir}`);
      logger.error(`   Try: mkdir -p ${configDir} && chmod 777 ${configDir}`);
    } else if (error.code === "EROFS") {
      logger.error(`❌ Read-only file system: ${CONFIG_PATH}`);
      logger.error(`   Check Docker volume mount configuration`);
    }

    return false;
  }
}

/**
 * Updates only specific keys in config (merge)
 * @param {Object} updates - Object with keys to update
 * @returns {boolean} True if update succeeded
 */
export function updateConfig(updates) {
  const config = readConfig() || {};
  const updatedConfig = { ...config, ...updates };
  return writeConfig(updatedConfig);
}

/**
 * Loads config into process.env for compatibility with existing code
 * Includes automatic migrations for backwards compatibility
 * @returns {boolean} True if load succeeded
 */
export function loadConfigToEnv() {
  // First: Perform migration if needed (one-time operation on startup)
  try {
    migrateConfigIfNeeded();
  } catch (error) {
    logger.error("Critical error during config migration - cannot continue");
    return false;
  }

  const config = readConfig();
  if (!config) {
    logger.warn("No config found to load into process.env");
    return false;
  }

  // --- SCHEMA VALIDATION (warn-only, non-fatal) ---
  const { error: validationError } = configSchema.validate(config, {
    abortEarly: false,
    allowUnknown: true,
  });
  if (validationError) {
    validationError.details.forEach((d) =>
      logger.warn(`⚠️ Config validation: ${d.message}`)
    );
  }

  // --- AUTO-MIGRATIONS ---

  // 1. Normalize JELLYSEERR_URL (remove /api/v1 suffix)
  if (config.JELLYSEERR_URL && typeof config.JELLYSEERR_URL === "string") {
    const originalUrl = config.JELLYSEERR_URL;
    config.JELLYSEERR_URL = config.JELLYSEERR_URL.replace(/\/api\/v1\/?$/, "");
    if (originalUrl !== config.JELLYSEERR_URL) {
      logger.debug(
        `Normalized JELLYSEERR_URL: ${originalUrl} → ${config.JELLYSEERR_URL}`
      );
    }
  }

  // 2. Auto-migrate JELLYFIN_NOTIFICATION_LIBRARIES from array to object
  if (Array.isArray(config.JELLYFIN_NOTIFICATION_LIBRARIES)) {
    logger.info(
      "🔄 Migrating JELLYFIN_NOTIFICATION_LIBRARIES from array to object format..."
    );
    const defaultChannel = config.JELLYFIN_CHANNEL_ID || "";
    const migratedLibraries = {};

    config.JELLYFIN_NOTIFICATION_LIBRARIES.forEach((libId) => {
      migratedLibraries[libId] = defaultChannel;
    });

    config.JELLYFIN_NOTIFICATION_LIBRARIES = migratedLibraries;

    // Save migrated version to new location
    if (writeConfig(config)) {
      logger.info(
        `✅ Successfully migrated ${
          Object.keys(migratedLibraries).length
        } libraries to default channel: ${defaultChannel || "(none set)"}`
      );
    } else {
      logger.error("Failed to save migrated config");
    }
  }

  // --- LOAD INTO PROCESS.ENV ---
  for (const [key, value] of Object.entries(config)) {
    // Convert objects/arrays to JSON strings to avoid "[object Object]"
    process.env[key] =
      typeof value === "object" ? JSON.stringify(value) : String(value);
  }

  logger.debug(
    `Config loaded into process.env (${Object.keys(config).length} keys)`
  );
  return true;
}

// ============================================
// HELPERS FOR SPECIFIC CONFIG SECTIONS
// ============================================

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
 * @param {Object} mapping - Mapping object with discordUserId, jellyseerrUserId, etc.
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

/**
 * Helper to normalize Jellyseerr URL (removes /api/v1 suffix)
 * @param {string} url - Jellyseerr URL
 * @returns {string} Normalized URL
 */
export function normalizeJellyseerrUrl(url) {
  if (!url) return "";
  return url.replace(/\/api\/v1\/?$/, "").replace(/\/$/, "");
}

/**
 * Helper to get full Jellyseerr API URL (with /api/v1)
 * @param {string} url - Jellyseerr base URL
 * @returns {string} Full API URL
 */
export function getJellyseerrApiUrl(url) {
  const base = normalizeJellyseerrUrl(url);
  return base ? `${base}/api/v1` : "";
}
