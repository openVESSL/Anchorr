/**
 * Input Validation using Joi
 * Provides schema validation for API endpoints and user inputs
 */

import Joi from "joi";

// --- CONFIG VALIDATION ---
export const configSchema = Joi.object({
  LANGUAGE: Joi.string().allow("").optional(), // Allow any language code from locales folder
  DISCORD_TOKEN: Joi.string().allow("").optional(),
  BOT_ID: Joi.string().allow("").optional(),
  GUILD_ID: Joi.string().allow("").optional(),
  SEERR_URL: Joi.string().uri().allow("").optional(),
  SEERR_API_KEY: Joi.string().allow("").optional(),
  TMDB_API_KEY: Joi.string().allow("").optional(),
  OMDB_API_KEY: Joi.string().allow("").optional(),
  JELLYFIN_BASE_URL: Joi.string().uri().allow("").optional(),
  JELLYFIN_API_KEY: Joi.string().allow("").optional(),
  JELLYFIN_SERVER_ID: Joi.string().allow("").optional(),
  JELLYFIN_CHANNEL_ID: Joi.string().allow("").optional(),
  JELLYFIN_NOTIFICATION_LIBRARIES: Joi.alternatives(
    Joi.array().items(Joi.string()), // Legacy array format
    Joi.object().pattern(Joi.string(), Joi.string().allow("")) // New object format: { libraryId: channelId }, allow empty channel IDs
  ).optional(),
  JELLYFIN_NOTIFY_MOVIES: Joi.string().valid("true", "false").optional(),
  JELLYFIN_NOTIFY_SERIES: Joi.string().valid("true", "false").optional(),
  JELLYFIN_NOTIFY_SEASONS: Joi.string().valid("true", "false").allow("").optional(),
  JELLYFIN_NOTIFY_EPISODES: Joi.string().valid("true", "false").allow("").optional(),
  JELLYFIN_EPISODE_CHANNEL_ID: Joi.string().allow("").optional(),
  JELLYFIN_SEASON_CHANNEL_ID: Joi.string().allow("").optional(),
  WEBHOOK_PORT: Joi.alternatives(Joi.string(), Joi.number().port()).optional(),
  BIND_HOST: Joi.string().ip({ version: ["ipv4", "ipv6"] }).optional(),
  WEBHOOK_SECRET: Joi.string().allow("").optional(),
  WEBHOOK_DEBOUNCE_MS: Joi.alternatives(
    Joi.string(),
    Joi.number().integer().min(1000).max(600000)
  ).optional(), // Allow up to 10 minutes
  AUTO_START_BOT: Joi.string().valid("true", "false").optional(),
  NOTIFY_ON_AVAILABLE: Joi.string().valid("true", "false").optional(),
  PRIVATE_MESSAGE_MODE: Joi.string().valid("true", "false").optional(),
  SEERR_AUTO_APPROVE: Joi.string().valid("true", "false").optional(),
  DEBUG: Joi.string().valid("true", "false").optional(),
  USER_MAPPINGS: Joi.array().items(Joi.object()).optional(),
  USER_MAPPING_METADATA: Joi.object().optional(),
  ROLE_ALLOWLIST: Joi.array().items(Joi.string()).optional(),
  ROLE_BLOCKLIST: Joi.array().items(Joi.string()).optional(),
});

// --- USER MAPPING VALIDATION ---
export const userMappingSchema = Joi.object({
  discordUserId: Joi.string().pattern(/^\d{17,19}$/).required(),
  seerrUserId: Joi.string().pattern(/^\d+$/).required(),
  discordUsername: Joi.string().allow(null, "").optional(),
  seerrUsername: Joi.string().allow(null, "").optional(),
  discordDisplayName: Joi.string().allow(null, "").optional(),
  discordAvatar: Joi.string().allow(null, "").optional(),
  seerrDisplayName: Joi.string().allow(null, "").optional(),
});

// --- SEERR REQUEST VALIDATION ---
export const seerrRequestSchema = Joi.object({
  mediaType: Joi.string().valid("movie", "tv").required(),
  mediaId: Joi.number().integer().positive().required(),
  seasons: Joi.alternatives(
    Joi.array().items(Joi.number().integer().positive()),
    Joi.array().items(Joi.string().valid("all"))
  ).optional(),
  tags: Joi.array().items(Joi.number().integer().positive()).optional(),
  rootFolder: Joi.string().optional(),
  serverId: Joi.number().integer().positive().optional(),
  userId: Joi.number().integer().positive().optional(),
});

// --- SEARCH QUERY VALIDATION ---
export const searchQuerySchema = Joi.object({
  query: Joi.string().min(1).max(200).required(),
});

// --- ID VALIDATION ---
export const tmdbIdSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  mediaType: Joi.string().valid("movie", "tv").required(),
});

// --- VALIDATION MIDDLEWARE ---
/**
 * Express middleware factory for validating request body
 * @param {Joi.Schema} schema - Joi validation schema
 * @returns {Function} Express middleware function
 */
export function validateBody(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false, // Get all errors, not just first
      stripUnknown: false, // Keep unknown fields for debugging
      allowUnknown: true, // Allow unknown fields
    });

    if (error) {
      const errors = error.details.map((detail) => ({
        field: detail.path.join("."),
        message: detail.message,
      }));

      // Log validation errors for debugging
      // console.error("Validation failed:", JSON.stringify(errors, null, 2));
      // console.error("Received body:", JSON.stringify(req.body, null, 2));

      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors,
      });
    }

    // Replace req.body with validated/sanitized value
    req.body = value;
    next();
  };
}

/**
 * Express middleware factory for validating query parameters
 * @param {Joi.Schema} schema - Joi validation schema
 * @returns {Function} Express middleware function
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.query, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errors = error.details.map((detail) => ({
        field: detail.path.join("."),
        message: detail.message,
      }));

      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors,
      });
    }

    req.query = value;
    next();
  };
}

/**
 * Express middleware factory for validating URL parameters
 * @param {Joi.Schema} schema - Joi validation schema
 * @returns {Function} Express middleware function
 */
export function validateParams(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.params, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errors = error.details.map((detail) => ({
        field: detail.path.join("."),
        message: detail.message,
      }));

      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors,
      });
    }

    req.params = value;
    next();
  };
}
