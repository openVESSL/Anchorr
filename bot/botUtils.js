import logger from "../utils/logger.js";
import { getUserMappings } from "../utils/configFile.js";

export function pad2(n) {
  return String(n).padStart(2, "0");
}

export function getOptionStringRobust(
  interaction,
  possibleNames = ["title", "query", "name"]
) {
  for (const n of possibleNames) {
    try {
      const v = interaction.options.getString(n);
      if (typeof v === "string" && v.length > 0) return v;
    } catch (e) {
      logger.debug(`getOptionStringRobust: getString("${n}") threw: ${e?.message}`);
    }
  }
  try {
    const data = (interaction.options && interaction.options.data) || [];
    if (Array.isArray(data) && data.length > 0) {
      for (const opt of data) {
        if (typeof opt.value !== "undefined" && opt.value !== null)
          return String(opt.value);
      }
    }
  } catch (e) {
    logger.warn(`getOptionStringRobust: options.data fallback threw: ${e?.message}`);
  }
  return null;
}

export function parseQualityAndServerOptions(options, mediaType, isAnime = false) {
  let profileId = null;
  let serverId = null;

  // Parse quality option (format: profileId|serverId|type)
  if (options.quality) {
    const [qProfileId, qServerId, qType] = options.quality.split("|");
    if (
      (mediaType === "movie" && qType === "radarr") ||
      (mediaType === "tv" && qType === "sonarr")
    ) {
      const parsedProfileId = parseInt(qProfileId, 10);
      const parsedServerId = parseInt(qServerId, 10);

      if (!isNaN(parsedProfileId) && !isNaN(parsedServerId)) {
        profileId = parsedProfileId;
        serverId = parsedServerId;
        logger.debug(`Using quality profile ID: ${profileId} from server ID: ${serverId}`);
      } else {
        logger.warn(
          `Invalid quality option format - non-numeric values: profileId=${qProfileId}, serverId=${qServerId}`
        );
      }
    } else {
      logger.debug(`Ignoring quality option - type mismatch (${qType} vs ${mediaType})`);
    }
  }

  // Parse server option (format: serverId|type) - only if not already set from quality
  if (options.server && serverId === null) {
    const [sServerId, sType] = options.server.split("|");
    if (
      (mediaType === "movie" && sType === "radarr") ||
      (mediaType === "tv" && sType === "sonarr")
    ) {
      const parsedServerId = parseInt(sServerId, 10);

      if (!isNaN(parsedServerId)) {
        serverId = parsedServerId;
        logger.debug(`Using server ID: ${serverId} from server option`);
      } else {
        logger.warn(
          `Invalid server option format - non-numeric serverId: ${sServerId}`
        );
      }
    } else {
      logger.debug(`Ignoring server option - type mismatch (${sType} vs ${mediaType})`);
    }
  }

  // Apply defaults from config if not specified
  if (profileId === null && serverId === null) {
    let defaultQualityConfig;
    if (isAnime && mediaType === "movie") {
      defaultQualityConfig = process.env.DEFAULT_QUALITY_PROFILE_ANIME_MOVIE || process.env.DEFAULT_QUALITY_PROFILE_MOVIE;
    } else if (isAnime) {
      defaultQualityConfig = process.env.DEFAULT_QUALITY_PROFILE_ANIME || process.env.DEFAULT_QUALITY_PROFILE_TV;
    } else {
      defaultQualityConfig = mediaType === "movie"
        ? process.env.DEFAULT_QUALITY_PROFILE_MOVIE
        : process.env.DEFAULT_QUALITY_PROFILE_TV;
    }

    if (defaultQualityConfig) {
      const [dProfileId, dServerId] = defaultQualityConfig.split("|");
      if (dProfileId && dServerId) {
        const parsedProfileId = parseInt(dProfileId, 10);
        const parsedServerId = parseInt(dServerId, 10);

        if (!isNaN(parsedProfileId) && !isNaN(parsedServerId)) {
          profileId = parsedProfileId;
          serverId = parsedServerId;
          logger.debug(`Using default quality profile ID: ${profileId} from config${isAnime ? " (anime)" : ""}`);
        } else {
          logger.warn(
            `Invalid default quality config format - non-numeric values: profileId=${dProfileId}, serverId=${dServerId}`
          );
        }
      }
    }
  }

  if (serverId === null) {
    let defaultServerConfig;
    if (isAnime && mediaType === "movie") {
      defaultServerConfig = process.env.DEFAULT_SERVER_ANIME_MOVIE || process.env.DEFAULT_SERVER_MOVIE;
    } else if (isAnime) {
      defaultServerConfig = process.env.DEFAULT_SERVER_ANIME || process.env.DEFAULT_SERVER_TV;
    } else {
      defaultServerConfig = mediaType === "movie"
        ? process.env.DEFAULT_SERVER_MOVIE
        : process.env.DEFAULT_SERVER_TV;
    }

    if (defaultServerConfig) {
      const [dServerId] = defaultServerConfig.split("|");
      if (dServerId) {
        const parsedServerId = parseInt(dServerId, 10);

        if (!isNaN(parsedServerId)) {
          serverId = parsedServerId;
          logger.debug(`Using default server ID: ${serverId} from config`);
        } else {
          logger.warn(
            `Invalid default server config format - non-numeric serverId: ${dServerId}`
          );
        }
      }
    }
  }

  return { profileId, serverId };
}

// Config problems are logged when they appear, not on every interaction
const activeRoleConfigErrors = new Map();
function reportRoleConfigError(name, value, message) {
  if (activeRoleConfigErrors.get(name) === value) return;
  activeRoleConfigErrors.set(name, value);
  logger.error(message);
}

// Returns the parsed role ID list, or null if the value is set but invalid
function parseRoleList(name) {
  const raw = process.env[name];
  if (!raw) {
    activeRoleConfigErrors.delete(name);
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reportRoleConfigError(name, raw, `Invalid JSON in ${name}: denying role-restricted interactions`);
    return null;
  }
  if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
    activeRoleConfigErrors.delete(name);
    return parsed;
  }
  reportRoleConfigError(name, raw, `${name} is not an array of role IDs: denying role-restricted interactions`);
  return null;
}

export function checkRolePermission(member, guildId) {
  const allowlist = parseRoleList("ROLE_ALLOWLIST");
  const blocklist = parseRoleList("ROLE_BLOCKLIST");
  if (allowlist === null || blocklist === null) return false;

  if (allowlist.length === 0 && blocklist.length === 0) {
    activeRoleConfigErrors.delete("GUILD_ID");
    return true;
  }

  // Roles are only meaningful in the configured guild; DMs and other guilds are denied
  if (!member?.roles?.cache) return false;
  if (!process.env.GUILD_ID) {
    reportRoleConfigError("GUILD_ID", "", "Role lists are set but GUILD_ID is empty: denying role-restricted interactions");
    return false;
  }
  activeRoleConfigErrors.delete("GUILD_ID");
  if (guildId !== process.env.GUILD_ID) return false;

  const userRoles = member.roles.cache.map((r) => r.id);

  if (allowlist.length > 0 && !userRoles.some((r) => allowlist.includes(r))) {
    return false;
  }

  if (blocklist.length > 0 && userRoles.some((r) => blocklist.includes(r))) {
    return false;
  }

  return true;
}

export function getSeerrAutoApprove() {
  const val = process.env.SEERR_AUTO_APPROVE;
  const isAuto = val === "true";
  logger.info(
    `[CONFIG CHECK] SEERR_AUTO_APPROVE is currently: ${val} (Evaluated to: ${isAuto})`
  );
  return isAuto;
}

/**
 * Fill in the user's default quality profile (set on their user mapping) when the
 * request did not specify one explicitly.
 * @returns {Object} options, with `quality` set if the user has a default for this media type
 */
export function withUserQuality(options, discordUserId, mediaType) {
  const base = options || {};
  if (base.quality) return base;
  const mapping = getUserMappings().find((m) => m.discordUserId === String(discordUserId));
  const quality = mapping?.qualityProfiles?.[mediaType];
  return quality ? { ...base, quality } : base;
}
