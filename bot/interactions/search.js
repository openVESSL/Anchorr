/**
 * /search, /request and /trending: find a title, show it, and for /request on a movie
 * request it at once (shows go through the season picker).
 */
import * as metadata from "../../api/metadata.js";
import * as seerrApi from "../../api/seerr.js";
import { t } from "../../utils/i18n.js";
import logger from "../../utils/logger.js";
import { getOptionStringRobust } from "../botUtils.js";
import { buildButtons, buildNotificationEmbed } from "../embeds.js";
import {
  getKnownSonarrTags,
  getSeerrApiKey,
  getSeerrErrorMessage,
  getSeerrUrl,
  isPrivateMode,
  requestFromDiscord,
  setPendingOptions,
  tagIdsFor,
  tagPickerRow,
} from "./shared.js";

export async function handleCommand(interaction) {
  if (!getSeerrUrl() || !getSeerrApiKey()) {
    return interaction.reply({ content: t("replies.seerr_not_configured"), flags: 64 });
  }
  const raw = getOptionStringRobust(interaction);
  if (interaction.commandName === "search" || interaction.commandName === "trending") {
    return handleSearchOrRequest(interaction, raw, "search");
  }
  if (interaction.commandName === "request") {
    const tag = interaction.options.getString("tag");
    const quality = interaction.options.getString("quality");
    const server = interaction.options.getString("server");
    return handleSearchOrRequest(interaction, raw, "request", tag ? [tag] : [], { quality, server });
  }
}

/**
 * In public mode the thinking reply is replaced by a private message. Logs instead of
 * throwing when Discord refuses it, so a Discord error is never shown as a Seerr error.
 */
async function replyPrivately(interaction, content) {
  try {
    if (isPrivateMode()) {
      await interaction.editReply({ content, components: [], embeds: [] });
      return;
    }
    try {
      await interaction.deleteReply();
    } catch (err) {
      // 10008 Unknown Message: already deleted
      if (err.code !== 10008) logger.warn(`Could not delete the thinking reply: ${err.message}`);
    }
    await interaction.followUp({ content, flags: 64 });
  } catch (err) {
    logger.error(`Could not send a private reply to user ${interaction.user.id}: ${err.message}`);
  }
}

async function findTitle(rawInput) {
  // Autocomplete values are "tmdbId|mediaType"; typed text is searched
  if (rawInput.includes("|")) return rawInput.split("|");
  const found = (await metadata.searchTitles(rawInput)).find((r) => r.media_type === "movie" || r.media_type === "tv");
  return found ? [found.id, found.media_type] : [];
}

async function handleSearchOrRequest(interaction, rawInput, mode, tags = [], options = {}) {
  try {
    await interaction.deferReply({ flags: isPrivateMode() ? 64 : undefined });
  } catch (err) {
    logger.error(`Failed to defer reply for "${interaction.commandName}": ${err.message}`);
    try {
      await interaction.reply({ content: t("replies.something_went_wrong"), flags: 64 });
    } catch {
      // Interaction token already invalid
    }
    return;
  }

  try {
    const [tmdbId, mediaType] = await findTitle(rawInput);
    if (!tmdbId || !mediaType) {
      await replyPrivately(interaction, t("replies.invalid_title"));
      return;
    }

    const details = await metadata.getDetails(tmdbId, mediaType);

    // TV shows go through the season picker instead of requesting every season at once
    const instantRequest = mode === "request" && mediaType !== "tv";

    if (instantRequest) {
      const status = await seerrApi.checkMediaStatus(tmdbId, mediaType, ["all"], getSeerrUrl(), getSeerrApiKey());
      if (status.exists && status.available) {
        await replyPrivately(interaction, t("replies.already_available"));
        return;
      }
      await requestFromDiscord(interaction, {
        tmdbId,
        mediaType,
        details,
        seasons: ["all"],
        tagIds: await tagIdsFor(tags, mediaType),
        options,
      });
    }

    const imdbId = await metadata.getImdbId(tmdbId, mediaType);
    const omdb = await metadata.getExtras(tmdbId, mediaType);
    const embed = buildNotificationEmbed(details, mediaType, imdbId, instantRequest ? "success" : "search", omdb, tmdbId);

    // The latest /search or /request for a show decides which options its Request button uses
    if (mediaType === "tv") {
      const picked = mode === "request" && (options.server || options.quality);
      setPendingOptions(interaction.user.id, mediaType, tmdbId, picked ? { server: options.server, quality: options.quality } : null);
    }

    const components = buildButtons(
      tmdbId,
      imdbId,
      instantRequest,
      mediaType,
      details,
      [],
      [],
      [],
      await getKnownSonarrTags(mediaType === "tv" && mode === "request" ? tags : [])
    );
    if (mediaType === "movie" && mode === "search") {
      const tagRow = await tagPickerRow("movie", `select_tags|${tmdbId}||movie`);
      if (tagRow) components.push(tagRow);
    }

    await interaction.editReply({ embeds: [embed], components });
  } catch (err) {
    logger.error("Error in handleSearchOrRequest:", err);
    await replyPrivately(interaction, getSeerrErrorMessage(err));
  }
}
