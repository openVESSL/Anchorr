import logger from "../utils/logger.js";

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
    } catch (e) { }
  }
  try {
    const data = (interaction.options && interaction.options.data) || [];
    if (Array.isArray(data) && data.length > 0) {
      for (const opt of data) {
        if (typeof opt.value !== "undefined" && opt.value !== null)
          return String(opt.value);
      }
    }
  } catch (e) { }
  return null;
}

export function parseQualityAndServerOptions(options, mediaType) {
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
    const defaultQualityConfig =
      mediaType === "movie"
        ? process.env.DEFAULT_QUALITY_PROFILE_MOVIE
        : process.env.DEFAULT_QUALITY_PROFILE_TV;

    if (defaultQualityConfig) {
      const [dProfileId, dServerId] = defaultQualityConfig.split("|");
      if (dProfileId && dServerId) {
        const parsedProfileId = parseInt(dProfileId, 10);
        const parsedServerId = parseInt(dServerId, 10);

        if (!isNaN(parsedProfileId) && !isNaN(parsedServerId)) {
          profileId = parsedProfileId;
          serverId = parsedServerId;
          logger.debug(`Using default quality profile ID: ${profileId} from config`);
        } else {
          logger.warn(
            `Invalid default quality config format - non-numeric values: profileId=${dProfileId}, serverId=${dServerId}`
          );
        }
      }
    }
  }

  if (serverId === null) {
    const defaultServerConfig =
      mediaType === "movie"
        ? process.env.DEFAULT_SERVER_MOVIE
        : process.env.DEFAULT_SERVER_TV;

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

export function checkRolePermission(member) {
  if (!member || !member.roles) return true;

  let allowlist = [];
  let blocklist = [];
  try {
    allowlist = process.env.ROLE_ALLOWLIST ? JSON.parse(process.env.ROLE_ALLOWLIST) : [];
  } catch (e) {
    logger.warn("Invalid JSON in ROLE_ALLOWLIST, defaulting to empty list");
  }
  try {
    blocklist = process.env.ROLE_BLOCKLIST ? JSON.parse(process.env.ROLE_BLOCKLIST) : [];
  } catch (e) {
    logger.warn("Invalid JSON in ROLE_BLOCKLIST, defaulting to empty list");
  }

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
