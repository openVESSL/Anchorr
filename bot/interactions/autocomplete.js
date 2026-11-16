/**
 * Autocomplete for the title, tag, server and quality options of /search, /request and
 * /trending. Any failure answers with an empty list.
 */
import * as metadata from "../../api/metadata.js";
import * as seerrApi from "../../api/seerr.js";
import logger from "../../utils/logger.js";
import { getSeerrApiKey, getSeerrUrl } from "./shared.js";

// Discord allows 100 characters per choice name
const fit = (name, max = 100) => (name.length > max ? name.substring(0, max - 3) + "..." : name);
const matches = (text, query) => (text || "").toLowerCase().includes(query.toLowerCase());

/** The media type of the title already picked in the same command, if any ("id|type"). */
function pickedMediaType(interaction) {
  const title = interaction.options.getString("title");
  return title?.includes("|") ? title.split("|")[1] : null;
}

const fitsType = (mediaType, serviceType) =>
  !mediaType || (mediaType === "movie" && serviceType === "radarr") || (mediaType === "tv" && serviceType === "sonarr");

async function tagChoices(query) {
  const tags = await seerrApi.fetchTags(getSeerrUrl(), getSeerrApiKey());
  const labels = new Set();
  for (const tag of Array.isArray(tags) ? tags : []) {
    const label = tag.label || tag.name;
    if (label && matches(label, query)) labels.add(label);
  }
  return [...labels].map((label) => ({ name: label, value: label }));
}

async function qualityChoices(interaction, query) {
  const mediaType = pickedMediaType(interaction);
  const serverOption = interaction.options.getString("server");
  let serverId = null;
  if (serverOption?.includes("|")) {
    const parsed = parseInt(serverOption.split("|")[0], 10);
    if (!isNaN(parsed)) serverId = parsed;
    else logger.warn(`Invalid server option in autocomplete - non-numeric serverId: ${serverOption.split("|")[0]}`);
  }
  const profiles = await seerrApi.fetchQualityProfiles(getSeerrUrl(), getSeerrApiKey());
  const seen = new Set();
  const choices = [];
  for (const profile of profiles) {
    if (!matches(profile.name, query) || !fitsType(mediaType, profile.type)) continue;
    if (serverId !== null && profile.serverId !== serverId) continue;
    const key = `${profile.id}-${profile.serverId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push({ name: fit(`${profile.name} (${profile.serverName})`), value: `${profile.id}|${profile.serverId}|${profile.type}` });
  }
  return choices;
}

async function serverChoices(interaction, query) {
  const mediaType = pickedMediaType(interaction);
  const servers = await seerrApi.fetchServers(getSeerrUrl(), getSeerrApiKey());
  return servers
    .filter((server) => matches(server.name, query) && fitsType(mediaType, server.type))
    .map((server) => ({
      name: fit(`${server.type === "radarr" ? "🎬" : "📺"} ${server.name}${server.isDefault ? " (default)" : ""}`),
      value: `${server.id}|${server.type}`,
    }));
}

/** Movies and shows only, as "🎬 Title (year)" with the value "tmdbId|mediaType". */
function titleChoices(results) {
  return results
    .filter((r) => r.media_type === "movie" || r.media_type === "tv")
    .slice(0, 10)
    .map((item) => {
      const date = item.release_date || item.first_air_date || "";
      const year = date ? ` (${date.slice(0, 4)})` : "";
      return { name: fit(`${item.media_type === "movie" ? "🎬" : "📺"} ${item.title || item.name}${year}`, 98), value: `${item.id}|${item.media_type}` };
    });
}

export async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const query = focused.value;
  try {
    if (focused.name === "tag") return await interaction.respond((await tagChoices(query)).slice(0, 25));
    if (focused.name === "quality") return await interaction.respond((await qualityChoices(interaction, query)).slice(0, 25));
    if (focused.name === "server") return await interaction.respond((await serverChoices(interaction, query)).slice(0, 25));
    if (interaction.commandName === "trending") {
      const trending = (await metadata.getTrending()).filter((r) => matches(r.title || r.name, query));
      return await interaction.respond(titleChoices(trending));
    }
    if (!query) return await interaction.respond([]);
    return await interaction.respond(titleChoices(await metadata.searchTitles(query)));
  } catch (e) {
    logger.error(`Autocomplete error for "${focused.name}" (${e?.status ?? e?.code ?? "unknown"}):`, e);
    return interaction.respond([]);
  }
}
