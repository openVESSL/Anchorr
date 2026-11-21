/**
 * The season picker under a show and the optional tag picker: each choice redraws the
 * buttons so the Request button asks for exactly what was picked.
 */
import * as metadata from "../../api/metadata.js";
import { t } from "../../utils/i18n.js";
import logger from "../../utils/logger.js";
import { buildButtons, seasonMenus } from "../embeds.js";
import { followUpPrivately, tagLabelsFor, tagPickerRow } from "./shared.js";

const menuIndexOf = (customId) => (customId.split("|")[3] ? parseInt(customId.split("|")[3], 10) : undefined);

/**
 * Seasons picked across all season menus: this menu's new values plus what the other menus
 * of the same message have selected. "All" wins over everything.
 */
function collectSelectedSeasons(interaction, menuIndex) {
  const current = interaction.values;
  if (current.includes("all")) return ["all"];
  const picked = [];
  for (const row of interaction.message.components || []) {
    for (const component of row.components) {
      if (!component.customId?.startsWith("select_seasons|")) continue;
      if (menuIndexOf(component.customId) === menuIndex) {
        picked.push(...current.filter((v) => v !== "all"));
      } else {
        picked.push(...(component.options?.filter((opt) => opt.default).map((opt) => opt.value).filter((v) => v !== "all") || []));
      }
    }
  }
  return [...new Set(picked)];
}

// customId format: select_seasons|tmdbId|selectedTagsParam|menuIndex
export async function handleSeasonSelect(interaction) {
  const parts = interaction.customId.split("|");
  const tmdbId = parseInt(parts[1], 10);
  if (!tmdbId) return interaction.reply({ content: t("replies.invalid_request"), flags: 64 });

  await interaction.deferUpdate();
  try {
    const selectedTags = parts[2] ? parts[2].split(",") : [];
    const details = await metadata.getDetails(tmdbId, "tv");
    const imdbId = await metadata.getImdbId(tmdbId, "tv");
    const seasons = collectSelectedSeasons(interaction, menuIndexOf(interaction.customId));

    // buildButtons draws the menus only while nothing is picked; otherwise they are redrawn
    // here (twice would repeat customIds, which Discord rejects)
    const components = buildButtons(tmdbId, imdbId, false, "tv", details, [], [], seasons, selectedTags);
    if (seasons.length > 0) components.push(...seasonMenus(tmdbId, details, selectedTags.join(",")));
    if (selectedTags.length === 0 && !seasons.includes("all")) {
      const tagRow = await tagPickerRow("tv", `select_tags|${tmdbId}|${seasons.join(",")}|tv`);
      if (tagRow) components.push(tagRow);
    }
    await interaction.editReply({ components });
  } catch (err) {
    logger.error("Season selection error:", err);
    await followUpPrivately(interaction, t("replies.season_error"));
  }
}

// customId format: select_tags|tmdbId|selectedSeasonsParam|mediaType
export async function handleTagSelect(interaction) {
  const parts = interaction.customId.split("|");
  const tmdbId = parseInt(parts[1], 10);
  const selectedSeasons = parts[2] ? parts[2].split(",") : [];
  if (!tmdbId) return interaction.reply({ content: t("replies.invalid_request"), flags: 64 });

  await interaction.deferUpdate();
  try {
    // Menus posted before 2.0 carry no type: those only had seasons for shows
    const mediaType = ["movie", "tv"].includes(parts[3]) ? parts[3] : selectedSeasons.length > 0 ? "tv" : "movie";
    const details = await metadata.getDetails(tmdbId, mediaType);
    const imdbId = await metadata.getImdbId(tmdbId, mediaType);
    const tagNames = await tagLabelsFor(interaction.values.map(String), mediaType);
    const components = buildButtons(tmdbId, imdbId, false, mediaType, details, [], [], selectedSeasons, tagNames);
    await interaction.editReply({ components });
  } catch (err) {
    logger.error("Tag selection error:", err);
    await followUpPrivately(interaction, t("replies.selection_error"));
  }
}
