import {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from "discord.js";
import * as tmdbApi from "../api/tmdb.js";
import { isValidUrl } from "../utils/url.js";
import logger from "../utils/logger.js";

let dailyRandomPickTimer = null;

export function scheduleDailyRandomPick(client) {
  if (dailyRandomPickTimer) {
    clearInterval(dailyRandomPickTimer);
  }

  const enabled = process.env.DAILY_RANDOM_PICK_ENABLED === "true";
  if (!enabled) return;

  const channelId = process.env.DAILY_RANDOM_PICK_CHANNEL_ID;
  const intervalMinutes = parseInt(process.env.DAILY_RANDOM_PICK_INTERVAL || "1440");

  if (!channelId) {
    logger.warn("Daily Random Pick is enabled but no channel is configured. Skipping.");
    return;
  }

  if (intervalMinutes < 1) {
    logger.warn("Daily Random Pick interval must be at least 1 minute. Skipping.");
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  logger.info(
    `📅 Daily Random Pick scheduled every ${intervalMinutes} minute${intervalMinutes !== 1 ? "s" : ""}`
  );

  sendDailyRandomPick(client).catch((err) =>
    logger.error("Error sending initial random pick:", err)
  );

  dailyRandomPickTimer = setInterval(async () => {
    await sendDailyRandomPick(client);
  }, intervalMs);
}

export async function sendDailyRandomPick(client) {
  try {
    const TMDB_API_KEY = process.env.TMDB_API_KEY;
    const channelId = process.env.DAILY_RANDOM_PICK_CHANNEL_ID;

    if (!TMDB_API_KEY || !channelId) return;

    const randomMedia = await tmdbApi.tmdbGetRandomMedia(TMDB_API_KEY);
    if (!randomMedia) {
      logger.warn("Could not fetch random media for daily pick");
      return;
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      logger.warn(`Daily Random Pick channel not found: ${channelId}`);
      return;
    }

    const mediaType = randomMedia.media_type;
    const isMovie = mediaType === "movie";
    const title = isMovie ? randomMedia.title : randomMedia.name;
    const year = isMovie
      ? randomMedia.release_date?.slice(0, 4)
      : randomMedia.first_air_date?.slice(0, 4);
    const details = randomMedia.details || randomMedia;

    const emoji = isMovie ? "🎬" : "📺";
    const backdrop = randomMedia.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${randomMedia.backdrop_path}`
      : null;

    let overview = randomMedia.overview || "No description available.";
    if (overview.length > 300) {
      overview = overview.substring(0, 297) + "...";
    }

    const embed = new EmbedBuilder()
      .setAuthor({ name: `${emoji} Today's Random Pick` })
      .setTitle(`${title}${year ? ` (${year})` : ""}`)
      .setDescription(overview)
      .setColor("#f5a962")
      .addFields({
        name: "Rating",
        value: randomMedia.vote_average
          ? `⭐ ${randomMedia.vote_average.toFixed(1)}/10`
          : "N/A",
        inline: true,
      });

    if (details.genres && Array.isArray(details.genres)) {
      const genreNames = details.genres.map((g) => g.name).join(", ");
      if (genreNames) {
        embed.addFields({ name: "Genres", value: genreNames, inline: true });
      }
    }

    if (backdrop && isValidUrl(backdrop)) {
      embed.setImage(backdrop);
    }

    const buttonComponents = [];

    if (isMovie) {
      const letterboxdUrl = `https://letterboxd.com/search/${encodeURIComponent(title)}/`;
      if (isValidUrl(letterboxdUrl)) {
        buttonComponents.push(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("Letterboxd")
            .setURL(letterboxdUrl)
        );
      }
    }

    let imdbId = null;
    if (details.external_ids?.imdb_id) {
      imdbId = details.external_ids.imdb_id;
    }
    if (imdbId) {
      const imdbUrl = `https://www.imdb.com/title/${imdbId}/`;
      if (isValidUrl(imdbUrl)) {
        buttonComponents.push(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("IMDb")
            .setURL(imdbUrl)
        );
      }
    }

    buttonComponents.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Primary)
        .setLabel("Request")
        .setCustomId(`request_random_${randomMedia.id}_${mediaType}`)
    );

    const button = new ActionRowBuilder().addComponents(buttonComponents);

    await channel.send({ embeds: [embed], components: [button] });

    logger.info(`Sent daily random pick: ${title} (${randomMedia.id} - ${mediaType})`);
  } catch (error) {
    logger.error(`Failed to send daily random pick: ${error.message}`);
  }
}
