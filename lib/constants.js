/**
 * Anchorr Constants
 * Centralized configuration values for colors, timeouts, cache TTLs, and URLs
 */

// Discord Embed Colors (Catppuccin Mocha palette)
// These can be customized via environment variables
export const COLORS = {
  get SEARCH() {
    return process.env.EMBED_COLOR_SEARCH || "#fab387"; // Peach/Orange for search results
  },
  get SUCCESS() {
    return process.env.EMBED_COLOR_SUCCESS || "#a6e3a1"; // Green for successful operations
  },
  ERROR: "#f38ba8", // Red - for errors (not customizable)
  DEFAULT: "#ef9f76", // Peach - default color (not customizable)
  INFO: "#89b4fa", // Blue - for informational messages (not customizable)
  WARNING: "#f9e2af", // Yellow - for warnings (not customizable)
};

// API Timeout Values (in milliseconds)
export const TIMEOUTS = {
  TMDB_API: 8000, // TMDB API calls
  OMDB_API: 7000, // OMDb API calls
  SEERR_API: 8000, // Seerr API calls (GET)
  SEERR_POST: 10000, // Seerr API calls (POST - longer for requests)
  JELLYFIN_API: 5000, // Jellyfin API calls
  DEFAULT: 8000, // Default timeout for other operations
};

// Cache TTL Values (in milliseconds)
export const CACHE_TTL = {
  ROOT_FOLDERS: 5 * 60 * 1000, // 5 minutes - Radarr/Sonarr root folders
  TAGS: 5 * 60 * 1000, // 5 minutes - Radarr/Sonarr tags
  SERVERS: 5 * 60 * 1000, // 5 minutes - Radarr/Sonarr server list
  QUALITY_PROFILES: 5 * 60 * 1000, // 5 minutes - Radarr/Sonarr quality profiles
  DISCORD_MEMBERS: 15 * 1000, // 15 seconds - Discord guild members
  TMDB_SEARCH: 5 * 60 * 1000, // 5 minutes - TMDB search results (for future caching)
  TMDB_DETAILS: 30 * 60 * 1000, // 30 minutes - TMDB details (for future caching)
  SEERR_STATUS: 60 * 1000, // 1 minute - Seerr request status (for future caching)
};

// External API URLs
export const API_URLS = {
  TMDB_BASE: "https://api.themoviedb.org/3",
  TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p",
  OMDB_BASE: "http://www.omdbapi.com",
};

// Discord Interaction Constants
export const DISCORD_LIMITS = {
  AUTOCOMPLETE_CHOICES: 25, // Max autocomplete choices
  EMBED_TITLE_LENGTH: 256, // Max embed title length
  EMBED_DESCRIPTION_LENGTH: 4096, // Max embed description length
  BUTTON_LABEL_LENGTH: 80, // Max button label length
};

// Seerr Request Types
export const REQUEST_TYPES = {
  MOVIE: "movie",
  TV: "tv",
};

// TMDB Media Types
export const MEDIA_TYPES = {
  MOVIE: "movie",
  TV: "tv",
  PERSON: "person",
};

// Season Selection Constants
export const SEASON_SELECTION = {
  ALL: "all",
  FIRST: "first",
  LATEST: "latest",
};

// Default Values
export const DEFAULTS = {
  WEBHOOK_PORT: 8282,
  BIND_HOST: "127.0.0.1",
  AUTO_START_BOT: true,
  NOTIFY_ON_AVAILABLE: false,
  PRIVATE_MESSAGE_MODE: false,
  DEBUG: false,
};
