/**
 * The Request buttons: on a /search or /request result, on the daily pick, and the
 * disabled "Requested" button.
 */
import * as metadata from "../../api/metadata.js";
import * as seerrApi from "../../api/seerr.js";
import { t } from "../../utils/i18n.js";
import logger from "../../utils/logger.js";
import { explicitSeasons } from "../botUtils.js";
import { buildButtons, buildNotificationEmbed } from "../embeds.js";
import {
  followUpPrivately,
  getPendingOptions,
  getSeerrApiKey,
  getSeerrErrorMessage,
  getSeerrUrl,
  requestFromDiscord,
  setPendingOptions,
  tagIdsFor,
} from "./shared.js";

// customId format: request_btn|tmdbId|mediaType|seasonsParam|tagsParam
export async function handleRequestButton(interaction) {
  const parts = interaction.customId.split("|");
  const tmdbId = parseInt(parts[1], 10);
  const mediaType = parts[2] || "movie";
  const selectedSeasons = parts[3] ? parts[3].split(",") : [];
  const selectedTagNames = parts[4] ? parts[4].split(",") : [];
  if (!tmdbId) return interaction.reply({ content: t("replies.invalid_request"), flags: 64 });

  await interaction.deferUpdate();
  try {
    const details = await metadata.getDetails(tmdbId, mediaType);
    const tagIds = await tagIdsFor(selectedTagNames, mediaType);

    const seasons = mediaType === "movie" ? ["all"] : selectedSeasons.length > 0 ? selectedSeasons : ["all"];
    const status = await seerrApi.checkMediaStatus(tmdbId, mediaType, seasons, getSeerrUrl(), getSeerrApiKey());
    if (status.exists && status.available) {
      await interaction.followUp({ content: t("replies.already_available"), flags: 64 });
      return;
    }

    await requestFromDiscord(interaction, {
      tmdbId,
      mediaType,
      details,
      seasons: mediaType === "movie" ? undefined : explicitSeasons(seasons, details),
      tagIds,
      options: getPendingOptions(interaction.user.id, mediaType, tmdbId),
      source: "REQUEST BTN",
    });
    setPendingOptions(interaction.user.id, mediaType, tmdbId, null);

    const imdbId = await metadata.getImdbId(tmdbId, mediaType);
    const omdb = await metadata.getExtras(tmdbId, mediaType);
    const embed = buildNotificationEmbed(details, mediaType, imdbId, "success", omdb, tmdbId);
    const components = buildButtons(tmdbId, imdbId, true, mediaType, details, seasons, selectedTagNames);
    await interaction.editReply({ embeds: [embed], components });
  } catch (err) {
    logger.error("Button request error:", err);
    await followUpPrivately(interaction, getSeerrErrorMessage(err));
  }
}

// customId format: request_random_tmdbId_mediaType
export async function handleDailyPickButton(interaction) {
  const parts = interaction.customId.split("_");
  const tmdbId = parseInt(parts[2], 10);
  const mediaType = parts[3] || "movie";
  if (!tmdbId) return interaction.reply({ content: t("replies.invalid_request"), flags: 64 });

  await interaction.deferUpdate();
  try {
    const details = await metadata.getDetails(tmdbId, mediaType);
    // Same defaults as /request: anime goes to the anime server and profile
    await requestFromDiscord(interaction, {
      tmdbId,
      mediaType,
      details,
      seasons: mediaType === "tv" ? explicitSeasons(["all"], details) : undefined,
      source: "DAILY PICK",
    });
    await interaction.followUp({ content: t("replies.pick_requested", { title: details.title || details.name }), flags: 64 });
  } catch (err) {
    logger.error("Daily random pick request error:", err);
    await followUpPrivately(interaction, getSeerrErrorMessage(err));
  }
}

export async function handleRequestedButton(interaction) {
  try {
    await interaction.reply({ content: t("replies.already_requested"), flags: 64 });
  } catch (err) {
    logger.error("Failed to send 'already requested' reply:", err);
  }
}
