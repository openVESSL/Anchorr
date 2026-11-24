/**
 * Input Validation using Joi
 * Provides schema validation for API endpoints and user inputs
 */

import Joi from "joi";

// setInterval cannot wait longer than 2^31 - 1 ms (about 24.8 days)
export const DAILY_PICK_MAX_INTERVAL_MINUTES = Math.floor(2 ** 31 / 60000) - 1;

/** The daily pick interval in whole minutes, or NaN when the value is not a plain number. */
export function dailyPickIntervalMinutes(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? Number(text) : NaN;
}

// --- CONFIG VALIDATION ---
export const configSchema = Joi.object({
  LANGUAGE: Joi.string().allow("").optional(), // Allow any language code from locales folder
  DISCORD_TOKEN: Joi.string().allow("").optional(),
  BOT_ID: Joi.string().allow("").optional(),
  GUILD_ID: Joi.string().allow("").optional(),
  SEERR_URL: Joi.string().uri().allow("").optional(),
  SEERR_API_KEY: Joi.string().allow("").optional(),
  JELLYFIN_BASE_URL: Joi.string().uri().allow("").optional(),
  JELLYFIN_PUBLIC_URL: Joi.string().uri({ scheme: ["http", "https"] }).allow("").optional(),
  JELLYFIN_API_KEY: Joi.string().allow("").optional(),
  JELLYFIN_SERVER_ID: Joi.string().allow("").optional(),
  JELLYFIN_CHANNEL_ID: Joi.string().allow("").optional(),
  JELLYFIN_NOTIFICATION_LIBRARIES: Joi.alternatives(
    Joi.array().items(Joi.string()), // Legacy array format
    Joi.object().pattern(
      Joi.string(),
      Joi.alternatives(
        Joi.string().allow(""), // Legacy: { libraryId: channelId }
        Joi.object({
          channel: Joi.string().allow("").optional(),
          isAnime: Joi.boolean().optional(),
        }) // Current: { libraryId: { channel, isAnime } }
      )
    )
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
  NOTIFY_TAG_REQUESTERS: Joi.string().valid("true", "false").optional(),
  EXPERIMENTAL_MOKA: Joi.string().valid("true", "false").optional(),
  PRIVATE_MESSAGE_MODE: Joi.string().valid("true", "false").optional(),
  SEERR_AUTO_APPROVE: Joi.string().valid("true", "false").optional(),
  DEBUG: Joi.string().valid("true", "false").optional(),
  USER_MAPPINGS: Joi.array().items(Joi.object()).optional(),
  USER_MAPPING_METADATA: Joi.object().optional(),
  ROLE_ALLOWLIST: Joi.array().items(Joi.string()).optional(),
  ROLE_BLOCKLIST: Joi.array().items(Joi.string()).optional(),
  WEEKLY_ROUNDUP_ENABLED: Joi.string().valid("true", "false").optional(),
  WEEKLY_ROUNDUP_CHANNEL_ID: Joi.string().allow("").optional(),
  WEEKLY_ROUNDUP_WEEKDAY: Joi.alternatives(
    Joi.string().pattern(/^[0-6]$/).allow(""),
    Joi.number().integer().min(0).max(6)
  ).optional(),
  WEEKLY_ROUNDUP_HOUR: Joi.alternatives(
    Joi.string().pattern(/^([0-9]|1[0-9]|2[0-3])$/).allow(""),
    Joi.number().integer().min(0).max(23)
  ).optional(),
  WEEKLY_ROUNDUP_EMBED_COLOR: Joi.string().allow("").optional(),
  WEEKLY_ROUNDUP_LAST_POSTED_AT: Joi.string().allow("").optional(),
  WEEKLY_ROUNDUP_ROLE_ID: Joi.string()
    .pattern(/^\d{17,20}$/)
    .allow("")
    .optional(),
  // Seerr account used for Discord users without a mapping (created automatically)
  SEERR_GUEST_USER_ID: Joi.alternatives(Joi.string().pattern(/^\d*$/), Joi.number().integer().min(1)).optional(),
  // Written by the 1.x upgrade and the checklist's Done button
  UPGRADE_FROM_V1: Joi.object({
    at: Joi.string().isoDate().required(),
    autoApprove: Joi.boolean().required(),
    mappings: Joi.number().integer().min(0).allow(null).required(),
  }).optional(),
  UPGRADE_DISMISSED_AT: Joi.string().isoDate().optional(),
  DAILY_RANDOM_PICK_ENABLED: Joi.string().valid("true", "false").optional(),
  DAILY_RANDOM_PICK_CHANNEL_ID: Joi.string().allow("").optional(),
  DAILY_RANDOM_PICK_INTERVAL: Joi.any()
    .custom((value, helpers) => {
      // "" and null mean "not set": the scheduler then uses its default
      if (value === "" || value === null) return value;
      const minutes = typeof value === "string" || typeof value === "number" ? dailyPickIntervalMinutes(value) : NaN;
      return minutes >= 1 && minutes <= DAILY_PICK_MAX_INTERVAL_MINUTES
        ? value
        : helpers.message(`{{#label}} must be a whole number of minutes between 1 and ${DAILY_PICK_MAX_INTERVAL_MINUTES}`);
    })
    .optional(),
  ...Object.fromEntries(
    ["MOVIE", "TV", "ANIME", "ANIME_MOVIE"].flatMap((kind) => [
      [`DEFAULT_QUALITY_PROFILE_${kind}`, Joi.string().allow("").optional()],
      [`DEFAULT_SERVER_${kind}`, Joi.string().allow("").optional()],
    ])
  ),
  ...Object.fromEntries(
    ["MOVIE", "SERIES", "SEASON", "EPISODE_SINGLE", "EPISODE_FEW", "EPISODE_MANY", "SEARCH", "SUCCESS"].map(
      (kind) => [`EMBED_COLOR_${kind}`, Joi.string().allow("").optional()]
    )
  ),
  ...Object.fromEntries(
    [
      "BACKDROP", "OVERVIEW_MOVIES", "OVERVIEW_EPISODES", "GENRE", "RUNTIME", "RATING",
      "BUTTON_LETTERBOXD", "BUTTON_IMDB", "BUTTON_WATCH",
    ].map((kind) => [`EMBED_SHOW_${kind}`, Joi.string().valid("true", "false").optional()])
  ),
});

// Keys the dashboard may never set: deployment settings and server-managed state.
// save-config keeps whatever config.json already has for them.
export const DASHBOARD_PROTECTED_KEYS = [
  "WEBHOOK_PORT",
  "BIND_HOST",
  "WEBHOOK_SECRET",
  "JWT_SECRET",
  "USERS",
  "USER_MAPPINGS",
  "USER_MAPPING_METADATA",
  "WEEKLY_ROUNDUP_LAST_POSTED_AT",
  "CONFIG_VERSION",
  "UPGRADE_FROM_V1",
  "UPGRADE_DISMISSED_AT",
];

// save-config body: every known config key plus the one-shot startBot flag; unknown keys are dropped.
// The upgrade keys are server-managed: dropped whatever their shape, so a damaged record
// can never block saving settings.
export const saveConfigSchema = configSchema
  .keys({ startBot: Joi.boolean().optional() })
  .fork(["UPGRADE_FROM_V1", "UPGRADE_DISMISSED_AT"], () => Joi.any().strip());

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
export function validateBody(schema, { stripUnknown = false } = {}) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false, // Get all errors, not just first
      stripUnknown, // true drops keys the schema does not know
      allowUnknown: true,
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
