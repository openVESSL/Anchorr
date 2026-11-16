/**
 * The Discord post for a new Jellyfin item, and the "your request is available" DM.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { findBestBackdrop } from "../api/metadata.js";
import { buildJellyfinUrl } from "../utils/jellyfinUrl.js";
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";
import { hhmmssToMinutes, minutesToHhMm } from "../utils/time.js";
import { isDiscordLinkableUrl, isValidUrl } from "../utils/url.js";
import { getBackdropItemId, isSeriesChild } from "./notificationMetadata.js";

const TMDB_IMAGES = "https://image.tmdb.org/t/p";
const MAX_LISTED = 10;
const shown = (key) => settings[key] !== "false";

/** Removes Jellyfin/TMDB tags such as [tvdbid-123], [imdbid-123] and a trailing (?). */
export function cleanTitle(title) {
  if (!title) return title;
  return title
    .replace(/\[tvdbid-\d+\]/gi, "")
    .replace(/\[imdbid-\d+\]/gi, "")
    .replace(/\(\?\)$/, "")
    .trim();
}

const watchUrl = (data) => buildJellyfinUrl("web/index.html", `!/details?id=${data.ItemId}&serverId=${data.ServerId}`);
const linkButton = (label, url) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);

function runtimeOf(data, details, omdb) {
  const { ItemType, RunTime } = data;
  let runtime = "Unknown";
  if (ItemType === "Episode" && RunTime) {
    runtime = RunTime; // Jellyfin already gives "00:25:02"
  } else if (omdb?.Runtime && omdb.Runtime !== "N/A") {
    const match = String(omdb.Runtime).match(/(\d+)/);
    if (match) runtime = minutesToHhMm(parseInt(match[1], 10));
  } else if (ItemType === "Movie" && details?.runtime > 0) {
    runtime = minutesToHhMm(details.runtime);
  } else if ((ItemType === "Series" || ItemType === "Season") && details?.episode_run_time?.length > 0) {
    runtime = minutesToHhMm(details.episode_run_time[0]);
  }
  // Metadata often has no runtime (shows especially); Jellyfin knows the file's length
  if (runtime === "Unknown" && RunTime) runtime = minutesToHhMm(hhmmssToMinutes(RunTime));
  return runtime;
}

function summaryHeading(itemType, omdb) {
  if (itemType === "Movie" && omdb?.Director && omdb.Director !== "N/A") return `Directed by ${omdb.Director}`;
  if (omdb?.Writer && omdb.Writer !== "N/A") return `Created by ${omdb.Writer.split(",")[0].trim()}`;
  return "Summary";
}

function headingOf(data, { episodeCount, episodeDetails, seasonCount, seasonDetails }) {
  const name = cleanTitle(data.Name);
  // Series items have no SeriesName
  const series = cleanTitle(data.SeriesName || data.Name) || "Unknown Series";
  const year = data.Year || "?";
  switch (data.ItemType) {
    case "Movie":
      return { author: "🎬 New movie added!", title: `${name || "Unknown Title"} (${year})` };
    case "Series":
      return { author: "📺 New TV show added!", title: `${series} (${year})` };
    case "Season":
      if (seasonCount > 1 && seasonDetails) return { author: `📺 ${seasonCount} new seasons added!`, title: `${series} (${year})` };
      return { author: "📺 New season added!", title: `${series} - Season ${data.SeasonNumber || data.IndexNumber || "?"}` };
    case "Episode": {
      if (episodeCount > 1 && episodeDetails) return { author: `📺 ${episodeCount} new episodes added!`, title: `${series} (${year})` };
      const season = String(data.SeasonNumber || 1).padStart(2, "0");
      const episode = String(data.EpisodeNumber || data.IndexNumber || 1).padStart(2, "0");
      return { author: "📺 New episode added!", title: `${series} - S${season}E${episode}` };
    }
    default:
      return { author: "✨ New item added", title: name || "Unknown Title" };
  }
}

function colorOf(itemType, episodeCount) {
  if (itemType === "Movie") return settings.EMBED_COLOR_MOVIE || "#cba6f7";
  if (itemType === "Series") return settings.EMBED_COLOR_SERIES || "#cba6f7";
  if (itemType === "Season") return settings.EMBED_COLOR_SEASON || "#89b4fa";
  if (itemType === "Episode" && episodeCount > 5) return settings.EMBED_COLOR_EPISODE_MANY || "#89b4fa";
  if (itemType === "Episode" && episodeCount > 1) return settings.EMBED_COLOR_EPISODE_FEW || "#89b4fa";
  return settings.EMBED_COLOR_EPISODE_SINGLE || "#89b4fa";
}

function addBatchList(embed, data, { episodeCount, episodeDetails, seasonCount, seasonDetails }) {
  if (data.ItemType === "Season") {
    if (seasonCount > 1 && seasonDetails && seasonDetails.seasons.length <= MAX_LISTED) {
      const number = (s) => s.SeasonNumber || s.IndexNumber || 0;
      const list = [...seasonDetails.seasons]
        .sort((a, b) => number(a) - number(b))
        .map((s) => {
          const n = s.SeasonNumber || s.IndexNumber || "?";
          return `**Season ${n}**: ${s.Name || `Season ${n}`}`;
        })
        .join("\n");
      embed.addFields({ name: "Seasons Added", value: list, inline: false });
    } else if (seasonCount > MAX_LISTED) {
      embed.addFields({ name: "Seasons Added", value: `${seasonCount} seasons (too many to list individually)`, inline: false });
    }
  }
  if (data.ItemType === "Episode") {
    if (episodeCount > 1 && episodeDetails && episodeDetails.episodes.length <= MAX_LISTED) {
      const list = [...episodeDetails.episodes]
        .sort((a, b) => (a.EpisodeNumber || 0) - (b.EpisodeNumber || 0))
        .map((ep) => {
          const s = String(ep.SeasonNumber || 1).padStart(2, "0");
          const e = String(ep.EpisodeNumber || 0).padStart(2, "0");
          return `**S${s}E${e}**: ${ep.Name || "Unknown Episode"}`;
        })
        .join("\n");
      embed.addFields({ name: "Episodes Added", value: list, inline: false });
    } else if (episodeCount > MAX_LISTED) {
      embed.addFields({ name: "Episodes Added", value: `${episodeCount} episodes (too many to list individually)`, inline: false });
    }
  }
}

/**
 * The channel post for an item (or a batch of seasons/episodes) plus the values the
 * available DM reuses.
 */
export function buildItemNotification(data, { details, omdb, imdbId, batch }) {
  const { ItemType } = data;
  const single = !(batch.episodeCount > 1);
  const runtime = runtimeOf(data, details, omdb);
  const rating = omdb?.imdbRating ? `${omdb.imdbRating}/10` : "N/A";
  const genreList = Array.isArray(data.Genres) ? data.Genres.join(", ") : data.Genres || omdb?.Genre || "Unknown";
  const overview = data.Overview?.trim() || omdb?.Plot || "No description available.";
  const { author, title } = headingOf(data, batch);

  const embed = new EmbedBuilder().setAuthor({ name: author }).setTitle(title);
  if (isDiscordLinkableUrl(watchUrl(data))) embed.setURL(watchUrl(data));
  embed.setColor(colorOf(ItemType, batch.episodeCount));

  if (ItemType === "Episode" && single) {
    if (shown("EMBED_SHOW_OVERVIEW_EPISODES") && overview) embed.addFields({ name: "Episode Summary", value: overview });
  } else if (ItemType !== "Season") {
    const fields = [];
    if (shown("EMBED_SHOW_OVERVIEW_MOVIES")) fields.push({ name: summaryHeading(ItemType, omdb), value: overview });
    if (shown("EMBED_SHOW_GENRE")) fields.push({ name: "Genre", value: genreList || "Unknown", inline: true });
    if (shown("EMBED_SHOW_RUNTIME")) fields.push({ name: "Runtime", value: runtime || "Unknown", inline: true });
    if (shown("EMBED_SHOW_RATING")) fields.push({ name: "Rating", value: rating || "N/A", inline: true });
    if (fields.length > 0) embed.addFields(...fields);
  }
  addBatchList(embed, data, batch);

  const backdropPath = details ? findBestBackdrop(details) : null;
  // Seasons and episodes generally do not have their own backdrop in Jellyfin.
  if (isSeriesChild(ItemType) && !data.SeriesId) {
    logger.warn(`${ItemType} item missing SeriesId; backdrop fallback will use ItemId and may 404. ItemId=${data.ItemId}, Name=${data.Name}`);
  }
  const backdrop = backdropPath
    ? `${TMDB_IMAGES}/w1280${backdropPath}`
    : buildJellyfinUrl(`Items/${getBackdropItemId(data)}/Images/Backdrop`);
  if (shown("EMBED_SHOW_BACKDROP") && isValidUrl(backdrop)) embed.setImage(backdrop);

  // Series poster for a single episode
  if (ItemType === "Episode" && single && details?.poster_path) {
    const posterUrl = `${TMDB_IMAGES}/w500${details.poster_path}`;
    if (isValidUrl(posterUrl)) embed.setThumbnail(posterUrl);
  }

  const buttons = [];
  if (imdbId && shown("EMBED_SHOW_BUTTON_LETTERBOXD")) {
    const url = `https://letterboxd.com/imdb/${imdbId}`;
    if (isValidUrl(url)) buttons.push(linkButton("Letterboxd", url));
  }
  if (imdbId && shown("EMBED_SHOW_BUTTON_IMDB")) {
    const url = `https://www.imdb.com/title/${imdbId}/`;
    if (isValidUrl(url)) buttons.push(linkButton("IMDb", url));
  }
  if (shown("EMBED_SHOW_BUTTON_WATCH")) {
    if (isDiscordLinkableUrl(watchUrl(data))) buttons.push(linkButton("▶ Watch Now!", watchUrl(data)));
    else logger.warn(`Invalid watch URL generated: ${watchUrl(data)}. Skipping watch button.`);
  }

  return {
    embed,
    buttons: buttons.length > 0 ? new ActionRowBuilder().addComponents(buttons) : null,
    title,
    runtime,
    rating,
    genreList,
    backdropPath,
  };
}

/** "Your request is now available" DM for the members who requested the item. */
export function buildAvailableDm(data, post) {
  const embed = new EmbedBuilder().setAuthor({ name: "✅ Your request is now available!" }).setTitle(post.title);
  const url = watchUrl(data);
  const linkable = isDiscordLinkableUrl(url);
  if (linkable) embed.setURL(url);
  embed
    .setColor(settings.EMBED_COLOR_SUCCESS || "#a6e3a1")
    .setDescription(`${data.Name || data.SeriesName || "Your requested content"} is now available on Jellyfin!`)
    .addFields(
      { name: "Genre", value: post.genreList, inline: true },
      { name: "Runtime", value: post.runtime, inline: true },
      { name: "Rating", value: post.rating, inline: true }
    );
  if (post.backdropPath) {
    const backdropUrl = `${TMDB_IMAGES}/w1280${post.backdropPath}`;
    if (isValidUrl(backdropUrl)) embed.setImage(backdropUrl);
  }
  const message = { embeds: [embed] };
  if (linkable) message.components = [new ActionRowBuilder().addComponents(linkButton("▶ Watch Now!", url))];
  return message;
}
