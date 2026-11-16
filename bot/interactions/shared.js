/**
 * Pieces every interaction handler uses: Seerr settings, tags, the request itself and the
 * messages shown when a request fails.
 */
import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";
import * as seerrApi from "../../api/seerr.js";
import { recordActivity } from "../../utils/activity.js";
import { getUserMappings } from "../../utils/configFile.js";
import { t } from "../../utils/i18n.js";
import logger from "../../utils/logger.js";
import { getSeerrApiUrl } from "../../utils/seerrUrl.js";
import { settings } from "../../utils/settings.js";
import { pendingRequests, savePendingRequests } from "../botState.js";
import { isAnimeTitle, parseQualityAndServerOptions } from "../botUtils.js";
import { getGuestUserId } from "../guestUser.js";

// Read at call time so config reloads are respected
export const getSeerrUrl = () => getSeerrApiUrl(settings.SEERR_URL || "");
export const getSeerrApiKey = () => settings.SEERR_API_KEY;
export const isPrivateMode = () => settings.PRIVATE_MESSAGE_MODE === "true";

// ----- server/quality picked in /request for a show -----

// Held until the user presses the season Request button (customIds are too small to carry
// them). Keyed by user + show; lost on restart, in which case the defaults apply.
const PENDING_OPTIONS_TTL_MS = 60 * 60 * 1000;
const pendingRequestOptions = new Map();

// TMDB movie and TV IDs overlap, so the media type is part of the key
const pendingOptionsKey = (userId, mediaType, tmdbId) => `${userId}|${mediaType}|${tmdbId}`;

export function getPendingOptions(userId, mediaType, tmdbId) {
  const entry = pendingRequestOptions.get(pendingOptionsKey(userId, mediaType, tmdbId));
  if (!entry) return {};
  if (Date.now() - entry.timestamp > PENDING_OPTIONS_TTL_MS) {
    logger.info(`[REQUEST BTN] Server/quality choice for ${mediaType} ${tmdbId} expired, using defaults`);
    return {};
  }
  return entry.options;
}

/** Remembers the server/quality for the show's Request button; without them, forgets. */
export function setPendingOptions(userId, mediaType, tmdbId, options) {
  const key = pendingOptionsKey(userId, mediaType, tmdbId);
  if (!options) {
    pendingRequestOptions.delete(key);
    return;
  }
  const now = Date.now();
  for (const [k, v] of pendingRequestOptions) {
    if (now - v.timestamp > PENDING_OPTIONS_TTL_MS) pendingRequestOptions.delete(k);
  }
  pendingRequestOptions.set(key, { options, timestamp: now });
}

// ----- tags -----

/** Radarr tags for movies, Sonarr tags for shows. */
export function tagsFor(allTags, mediaType) {
  const type = mediaType === "tv" ? "sonarr" : "radarr";
  return Array.isArray(allTags) ? allTags.filter((tag) => tag.type === type) : [];
}

const tagLabel = (tag) => tag.label || tag.name;

/** Tag labels -> Seerr tag ids for this media type; unknown labels are dropped. */
export async function tagIdsFor(labels, mediaType) {
  if (!labels?.length) return [];
  try {
    const tags = tagsFor(await seerrApi.fetchTags(getSeerrUrl(), getSeerrApiKey()), mediaType);
    const ids = labels.map((label) => tags.find((tag) => tagLabel(tag) === label)?.id).filter((id) => id != null);
    logger.debug(`Converted tag labels ${labels.join(", ")} to IDs: ${ids.join(", ")}`);
    return ids;
  } catch (err) {
    logger.warn("Failed to convert tag labels to IDs:", err?.message);
    return [];
  }
}

/** Tag ids -> labels; when Seerr cannot be asked, the ids stand in for the labels. */
export async function tagLabelsFor(ids, mediaType) {
  if (!ids?.length) return [];
  try {
    const tags = tagsFor(await seerrApi.fetchTags(getSeerrUrl(), getSeerrApiKey()), mediaType);
    return ids.map((id) => tags.find((tag) => tag.id.toString() === id)).filter(Boolean).map(tagLabel);
  } catch (err) {
    logger.debug("Failed to fetch tag names:", err?.message);
    return ids;
  }
}

// The free-text /request tag ends up in button labels and customIds, so only Seerr's own labels pass
export async function getKnownSonarrTags(labels) {
  if (labels.length === 0) return [];
  const known = new Set(tagsFor(await seerrApi.fetchTags(getSeerrUrl(), getSeerrApiKey()), "tv").map(tagLabel));
  const unknown = labels.filter((label) => !known.has(label));
  if (unknown.length > 0) logger.warn(`Ignoring unknown Sonarr tag(s) in /request: ${JSON.stringify(unknown)}`);
  return labels.filter((label) => known.has(label));
}

/** The optional tag picker for a movie or show, or null when Seerr has no such tags. */
export async function tagPickerRow(mediaType, customId) {
  try {
    const tags = tagsFor(await seerrApi.fetchTags(getSeerrUrl(), getSeerrApiKey()), mediaType);
    const unique = [...new Map(tags.map((tag) => [tag.id, tag])).values()].slice(0, 25);
    if (unique.length === 0) return null;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(t("buttons.select_tags"))
      .addOptions(unique.map((tag) => ({ label: tag.label || tag.name || `Tag ${tag.id}`, value: tag.id.toString() })))
      .setMinValues(0)
      .setMaxValues(Math.min(5, unique.length));
    return new ActionRowBuilder().addComponents(menu);
  } catch (err) {
    logger.warn(`Failed to fetch tags for the ${mediaType === "tv" ? "season" : "movie tag"} selector:`, err?.message);
    return null;
  }
}

// ----- the request -----

/**
 * Sends a request to Seerr as the Discord member (their linked account, or the guest),
 * with the default server/quality unless `options` picks one, and remembers the member for
 * the "now available" DM.
 */
export async function requestFromDiscord(interaction, { tmdbId, mediaType, details, seasons, tagIds, options = {}, source = "REQUEST" }) {
  const isAnime = isAnimeTitle(details);
  if (isAnime) logger.info(`[${source}] Detected anime content: ${tmdbId}`);
  const { profileId, serverId } = parseQualityAndServerOptions(options, mediaType, isAnime);

  await seerrApi.sendRequest({
    tmdbId,
    mediaType,
    seasons,
    tags: tagIds,
    profileId,
    serverId,
    isAnime,
    seerrUrl: getSeerrUrl(),
    apiKey: getSeerrApiKey(),
    discordUserId: interaction.user.id,
    userMappings: getUserMappings(),
    guestUserId: getGuestUserId,
  });
  recordActivity("request", { title: details?.title || details?.name, detail: mediaType, user: interaction.user.username });
  logger.info(`[REQUEST] Discord User ${interaction.user.id} requested ${mediaType} ${tmdbId}${isAnime ? " [anime]" : ""}`);

  if (settings.NOTIFY_ON_AVAILABLE === "true") {
    const key = `${tmdbId}-${mediaType}`;
    if (!pendingRequests.has(key)) pendingRequests.set(key, new Set());
    pendingRequests.get(key).add(interaction.user.id);
    savePendingRequests();
  }
}

/** The member-facing message for a failed Seerr request. */
export function getSeerrErrorMessage(err) {
  if (err?.name === "NoSeerrUserError") return t("seerr_request_errors.not_linked");
  if (err.response) {
    const status = err.response.status;
    const msg = err.response.data?.message || "";
    if (/quota/i.test(msg)) return t("seerr_request_errors.quota", { msg });
    if (status === 401 || status === 403) return t("seerr_request_errors.auth");
    if (status >= 500) return t("seerr_request_errors.server_error");
    if (msg) return t("seerr_request_errors.generic", { msg });
  }
  if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND") {
    return t("seerr_request_errors.unreachable");
  }
  return t("seerr_request_errors.unknown", { msg: err.message || "unknown error" });
}

/** Sends a private follow-up, logging instead of throwing when Discord refuses it. */
export async function followUpPrivately(interaction, content) {
  try {
    await interaction.followUp({ content, flags: 64 });
  } catch (err) {
    logger.error("Failed to send follow-up message:", err);
  }
}
