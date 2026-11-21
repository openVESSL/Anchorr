import {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { findBestBackdrop } from "../api/metadata.js";
import { minutesToHhMm } from "../utils/time.js";
import { COLORS } from "../lib/constants.js";
import { t } from "../utils/i18n.js";
import { normalizeSeerrUrl } from "../utils/seerrUrl.js";
import { isDiscordLinkableUrl, isValidUrl } from "../utils/url.js";
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";

// Holds the URL rather than a flag, so a config change warns again.
let warnedUnlinkableSeerrUrl = null;

function resolveAuthorUrl(seerrMediaUrl, seerrBaseUrl) {
  if (!seerrMediaUrl) return undefined;
  if (isDiscordLinkableUrl(seerrMediaUrl)) return seerrMediaUrl;
  if (warnedUnlinkableSeerrUrl !== seerrBaseUrl) {
    warnedUnlinkableSeerrUrl = seerrBaseUrl;
    logger.warn(
      `SEERR_URL (${seerrBaseUrl}) cannot be used as a Discord link. Embeds will have no Seerr link until it points to a public hostname with a dot.`
    );
  }
  return undefined;
}

export function buildNotificationEmbed(
  details,
  mediaType,
  imdbId,
  status = "search",
  omdb = null,
  tmdbId = null
) {
  const titleName = details.title || details.name || t("embeds.unknown");
  const releaseDate = details.release_date || details.first_air_date || "";
  const year = releaseDate ? releaseDate.slice(0, 4) : "";
  const titleWithYear = year ? `${titleName} (${year})` : titleName;

  const authorName =
    status === "success"
      ? t("embeds.requested")
      : mediaType === "movie"
        ? t("embeds.movie_found")
        : t("embeds.show_found");

  let seerrMediaUrl;
  const currentSeerrUrl = normalizeSeerrUrl(settings.SEERR_URL || "");
  if (tmdbId && currentSeerrUrl) {
    const baseUrl = `${currentSeerrUrl}/${mediaType}/${tmdbId}`;
    seerrMediaUrl = status === "success" ? `${baseUrl}?manage=1` : baseUrl;
  }

  const genres = (details.genres || []).map((g) => g.name).join(", ") || t("embeds.unknown");

  let runtime = t("embeds.unknown");
  if (omdb?.Runtime && omdb.Runtime !== "N/A") {
    const match = String(omdb.Runtime).match(/(\d+)/);
    if (match) runtime = minutesToHhMm(parseInt(match[1], 10));
  } else if (mediaType === "movie" && details.runtime > 0) {
    runtime = minutesToHhMm(details.runtime);
  } else if (mediaType === "tv" && details.episode_run_time?.length > 0) {
    runtime = minutesToHhMm(details.episode_run_time[0]);
  }

  const rating = omdb?.imdbRating
    ? `${omdb.imdbRating}/10`
    : typeof details.vote_average === "number" && details.vote_average > 0
      ? `${details.vote_average.toFixed(1)}/10`
      : t("embeds.not_available");

  const overview =
    (details.overview?.trim() ? details.overview : null) ||
    (omdb?.Plot && omdb.Plot !== "N/A" ? omdb.Plot : t("embeds.no_description"));

  let headerLine = t("embeds.summary");
  if (mediaType === "movie" && omdb?.Director && omdb.Director !== "N/A") {
    headerLine = t("embeds.directed_by", { names: omdb.Director });
  } else if (mediaType === "tv" && omdb?.Writer && omdb.Writer !== "N/A") {
    headerLine = t("embeds.created_by", { name: omdb.Writer.split(",")[0].trim() });
  }

  const embed = new EmbedBuilder()
    .setAuthor({
      name: authorName,
      url: resolveAuthorUrl(seerrMediaUrl, currentSeerrUrl),
    })
    .setTitle(titleWithYear)
    .setURL(imdbId ? `https://www.imdb.com/title/${imdbId}/` : undefined)
    .setColor(
      status === "success"
        ? COLORS.SUCCESS
        : status === "search"
          ? COLORS.SEARCH
          : COLORS.DEFAULT
    );

  const backdropPath = findBestBackdrop(details);
  const backdrop = backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : null;
  const poster = details.poster_path ? `https://image.tmdb.org/t/p/w342${details.poster_path}` : null;

  if (backdrop && isValidUrl(backdrop)) {
    embed.setImage(backdrop);
  } else if (poster && isValidUrl(poster)) {
    embed.setThumbnail(poster);
  }

  embed.addFields(
    { name: headerLine, value: overview.length ? overview : t("embeds.no_description") },
    { name: t("embeds.genre"), value: genres, inline: true },
    { name: t("embeds.runtime"), value: runtime, inline: true },
    { name: t("embeds.rating"), value: rating, inline: true }
  );

  return embed;
}

/** "Request season 2", "Requested seasons 1, 2 and 3 with anime tag, stay tuned!", ... */
function requestLabel(prefix, mediaType, seasons, tags) {
  let label = t(`buttons.${prefix}`);
  if (mediaType === "tv" && seasons.length > 0) {
    if (seasons.includes("all")) label = t(`buttons.${prefix}_all`);
    else if (seasons.length === 1) label = t(`buttons.${prefix}_season`, { season: seasons[0] });
    else label = t(`buttons.${prefix}_seasons`, { list: seasons.slice(0, -1).join(", "), last: seasons.at(-1) });
  }
  if (tags.length > 0) label += t(tags.length > 1 ? "buttons.with_tags" : "buttons.with_tag", { tags: tags.join(", ") });
  return label;
}

const SEASONS_PER_MENU = 24;
const MAX_SEASON_MENUS = 4;

const seasonOption = (s) => ({
  label: t("buttons.season_option", { number: s.season_number, episodes: s.episode_count }),
  value: String(s.season_number),
});

/**
 * The season picker for a show: one menu for up to 24 seasons, otherwise up to 4 menus of
 * 24 seasons each (Discord allows 25 options per menu and 5 rows per message).
 */
export function seasonMenus(tmdbId, details, tagsParam) {
  const seen = new Set();
  const seasons = (details?.seasons ?? []).filter((s) => {
    if (s.season_number <= 0 || seen.has(s.season_number)) return false;
    seen.add(s.season_number);
    return true;
  });
  if (seasons.length === 0) return [];
  const all = { label: t("buttons.all_seasons"), value: "all" };

  if (seasons.length <= SEASONS_PER_MENU) {
    const options = [all, ...seasons.map(seasonOption)];
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`select_seasons|${tmdbId}|${tagsParam}`)
      .setPlaceholder(t("buttons.select_seasons"))
      .setMinValues(1)
      .setMaxValues(Math.min(25, options.length))
      .addOptions(options);
    return [new ActionRowBuilder().addComponents(menu)];
  }

  const rows = [];
  for (let index = 0; index < MAX_SEASON_MENUS && index * SEASONS_PER_MENU < seasons.length; index++) {
    const batch = seasons.slice(index * SEASONS_PER_MENU, (index + 1) * SEASONS_PER_MENU);
    const options = [...(index === 0 ? [all] : []), ...batch.map(seasonOption)];
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`select_seasons|${tmdbId}|${tagsParam}|${index}`)
      .setPlaceholder(t("buttons.seasons_range", { from: index === 0 ? 1 : batch[0].season_number, to: batch.at(-1).season_number }))
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options);
    rows.push(new ActionRowBuilder().addComponents(menu));
  }
  const shown = MAX_SEASON_MENUS * SEASONS_PER_MENU;
  if (seasons.length > shown) {
    logger.warn(`[SEASON SELECTOR] Show has ${seasons.length} seasons, but Discord limit allows only ${shown} to be shown in ${MAX_SEASON_MENUS} menus`);
  }
  return rows;
}

export function buildButtons(
  tmdbId,
  imdbId,
  requested = false,
  mediaType = "movie",
  details = null,
  requestedSeasons = [],
  requestedTags = [],
  selectedSeasons = [],
  selectedTags = []
) {
  const rows = [];
  const buttons = [];

  if (imdbId) {
    const letterboxdUrl = `https://letterboxd.com/imdb/${imdbId}`;
    const imdbUrl = `https://www.imdb.com/title/${imdbId}/`;
    if (isValidUrl(letterboxdUrl)) {
      buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Letterboxd").setURL(letterboxdUrl));
    }
    if (isValidUrl(imdbUrl)) {
      buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("IMDb").setURL(imdbUrl));
    }
  }

  if (requested) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`requested|${tmdbId}|${mediaType}`)
        .setLabel(requestLabel("requested", mediaType, requestedSeasons, requestedTags) + t("buttons.stay_tuned"))
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );
  } else {
    const seasonsParam = selectedSeasons.join(",");
    const tagsParam = selectedTags.join(",");
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`request_btn|${tmdbId}|${mediaType}|${seasonsParam}|${tagsParam}`)
        .setLabel(requestLabel("request", mediaType, selectedSeasons, selectedTags))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(mediaType === "tv" && selectedSeasons.length === 0)
    );
  }

  if (buttons.length > 0) {
    rows.push(new ActionRowBuilder().addComponents(...buttons.slice(0, 5)));
  }

  if (mediaType === "tv" && !requested && selectedSeasons.length === 0) {
    rows.push(...seasonMenus(tmdbId, details, selectedTags.join(",")));
  }

  return rows;
}
