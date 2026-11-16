/**
 * The season picker under a show and the optional tag picker: each choice redraws the
 * buttons so the Request button asks for exactly what was picked.
 */
import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";
import * as metadata from "../../api/metadata.js";
import logger from "../../utils/logger.js";
import { buildButtons } from "../embeds.js";
import { followUpPrivately, tagLabelsFor, tagPickerRow } from "./shared.js";

const SEASONS_PER_MENU = 24;
const MAX_SEASON_MENUS = 4;

const seasonOption = (s) => ({ label: `Season ${s.season_number} (${s.episode_count} episodes)`, value: String(s.season_number) });
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

/** One menu for up to 24 seasons, otherwise up to 4 menus of 24 seasons each. */
function seasonMenus(tmdbId, details, tagsParam) {
  const seen = new Set();
  const seasons = details.seasons.filter((s) => {
    if (s.season_number <= 0 || seen.has(s.season_number)) return false;
    seen.add(s.season_number);
    return true;
  });
  const all = { label: "All Seasons", value: "all" };

  if (seasons.length <= SEASONS_PER_MENU) {
    const options = [all, ...seasons.map(seasonOption)];
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`select_seasons|${tmdbId}|${tagsParam}`)
      .setPlaceholder("Select seasons to request...")
      .setMinValues(1)
      .setMaxValues(Math.min(25, options.length))
      .addOptions(options);
    return [new ActionRowBuilder().addComponents(menu)];
  }

  const rows = [];
  for (let index = 0; index < MAX_SEASON_MENUS && index * SEASONS_PER_MENU < seasons.length; index++) {
    const batch = seasons.slice(index * SEASONS_PER_MENU, (index + 1) * SEASONS_PER_MENU);
    const options = [...(index === 0 ? [all] : []), ...batch.map(seasonOption)];
    const first = index === 0 ? 1 : batch[0].season_number;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`select_seasons|${tmdbId}|${tagsParam}|${index}`)
      .setPlaceholder(`Seasons ${first}-${batch.at(-1).season_number}`)
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options);
    rows.push(new ActionRowBuilder().addComponents(menu));
  }
  return rows;
}

// customId format: select_seasons|tmdbId|selectedTagsParam|menuIndex
export async function handleSeasonSelect(interaction) {
  const parts = interaction.customId.split("|");
  const tmdbId = parseInt(parts[1], 10);
  if (!tmdbId) return interaction.reply({ content: "⚠️ Invalid selection.", flags: 64 });

  await interaction.deferUpdate();
  try {
    const selectedTags = parts[2] ? parts[2].split(",") : [];
    const details = await metadata.getDetails(tmdbId, "tv");
    const imdbId = await metadata.getImdbId(tmdbId, "tv");
    const seasons = collectSelectedSeasons(interaction, menuIndexOf(interaction.customId));

    const components = buildButtons(tmdbId, imdbId, false, "tv", details, [], [], seasons, selectedTags);
    components.push(...seasonMenus(tmdbId, details, selectedTags.join(",")));
    if (selectedTags.length === 0 && !seasons.includes("all")) {
      const tagRow = await tagPickerRow("tv", `select_tags|${tmdbId}|${seasons.join(",")}|tv`);
      if (tagRow) components.push(tagRow);
    }
    await interaction.editReply({ components });
  } catch (err) {
    logger.error("Season selection error:", err);
    await followUpPrivately(interaction, "⚠️ Error processing season selection.");
  }
}

// customId format: select_tags|tmdbId|selectedSeasonsParam|mediaType
export async function handleTagSelect(interaction) {
  const parts = interaction.customId.split("|");
  const tmdbId = parseInt(parts[1], 10);
  const selectedSeasons = parts[2] ? parts[2].split(",") : [];
  if (!tmdbId) return interaction.reply({ content: "⚠️ Invalid request data.", flags: 64 });

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
    await followUpPrivately(interaction, "⚠️ Error updating selection.");
  }
}
