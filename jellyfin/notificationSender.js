/**
 * Posts one Jellyfin item (or a batch of its seasons/episodes) to Discord and sends the
 * "now available" DMs to the members who requested it.
 */
import { getDetails, getExtras, isMetadataConfigured } from "../api/metadata.js";
import { recordActivity } from "../utils/activity.js";
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";
import { buildAvailableDm, buildItemNotification } from "./notificationEmbed.js";
import { applySeriesProviderIds, getNotificationTmdbId, isSeriesChild } from "./notificationMetadata.js";

// A batched episode post is edited while more episodes of that series arrive
const episodeMessages = new Map(); // SeriesId -> { messageId, channelId }
const EPISODE_MESSAGE_TTL_MS = 6 * 60 * 60 * 1000;

/** Members waiting for this item (NOTIFY_ON_AVAILABLE); their pending request is cleared. */
function takeRequesters(data, tmdbId, pendingRequests, onPendingRequestsChanged) {
  if (settings.NOTIFY_ON_AVAILABLE !== "true" || !tmdbId || !pendingRequests) return [];
  const key = data.ItemType === "Movie" ? `${tmdbId}-movie` : ["Series", "Season", "Episode"].includes(data.ItemType) ? `${tmdbId}-tv` : null;
  if (!key || !pendingRequests.has(key)) {
    logger.debug(`No matching pending requests found for ${tmdbId}`);
    return [];
  }
  const users = Array.from(pendingRequests.get(key));
  pendingRequests.delete(key);
  onPendingRequestsChanged?.();
  logger.info(`Found ${users.length} users to notify for ${data.ItemType === "Movie" ? "movie" : "TV show"} ${tmdbId}`);
  return users;
}

async function fetchMetadata(tmdbId, itemType) {
  if (!tmdbId || !isMetadataConfigured()) return { details: null, omdb: null };
  const id = parseInt(tmdbId, 10);
  const type = itemType === "Movie" ? "movie" : "tv";
  let details = null;
  try {
    details = await getDetails(id, type);
  } catch (e) {
    logger.warn(`Could not fetch Seerr details for ${tmdbId}: ${e?.message || e}`);
  }
  // OMDb-style extras (rating, director/creator) from Seerr
  return { details, omdb: details ? await getExtras(id, type) : null };
}

/**
 * The channel announcing this kind of item: the episode/season channel when set, then the
 * library channel, then the default one. False when that kind of item is not announced.
 */
function announcementChannel(data, libraryChannelId) {
  const kinds = {
    Episode: { on: settings.JELLYFIN_NOTIFY_EPISODES === "true", channel: settings.JELLYFIN_EPISODE_CHANNEL_ID },
    Season: { on: settings.JELLYFIN_NOTIFY_SEASONS === "true", channel: settings.JELLYFIN_SEASON_CHANNEL_ID },
    Movie: { on: settings.JELLYFIN_NOTIFY_MOVIES !== "false" },
    Series: { on: settings.JELLYFIN_NOTIFY_SERIES !== "false" },
  };
  const kind = kinds[data.ItemType];
  if (kind && !kind.on) {
    logger.info(`${data.ItemType} notifications disabled. Skipping channel announcement for: ${data.Name}`);
    return false;
  }
  return kind?.channel || libraryChannelId || settings.JELLYFIN_CHANNEL_ID;
}

async function postToChannel(client, channelId, data, post, { batch, isTest }) {
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (error) {
    logger.error(`❌ Failed to fetch Discord channel ${channelId} for "${data.Name}" (${data.ItemType}): ${error.message}`);
    throw new Error(`Discord channel ${channelId} not accessible`);
  }
  const components = post.buttons ? [post.buttons] : [];
  const editable = data.ItemType === "Episode" && batch.episodeCount > 1 && batch.episodeDetails && data.SeriesId;

  const existing = editable && episodeMessages.get(data.SeriesId);
  if (existing) {
    try {
      const existingChannel = await client.channels.fetch(existing.channelId);
      const message = await existingChannel.messages.fetch(existing.messageId);
      await message.edit({ embeds: [post.embed], components });
      logger.info(`Updated existing message for: ${post.title} (${batch.episodeCount} episodes total)`);
      return;
    } catch (err) {
      logger.warn(`Failed to edit existing message for ${data.SeriesId}, sending new one:`, err);
    }
  }

  let sent;
  try {
    sent = await channel.send({ embeds: [post.embed], ...(post.buttons && { components }) });
  } catch (error) {
    logger.error(`Failed to send Discord message:`, error);
    throw new Error(`Failed to send Discord notification: ${error.message}`);
  }
  if (!isTest) {
    recordActivity("notification", { title: data.ItemType === "Movie" ? data.Name : data.SeriesName || data.Name, detail: data.ItemType });
  }
  if (editable) {
    const seriesId = data.SeriesId;
    episodeMessages.set(seriesId, { messageId: sent.id, channelId: channel.id });
    setTimeout(() => episodeMessages.delete(seriesId), EPISODE_MESSAGE_TTL_MS);
  }
}

/**
 * Announces an item. `batch` carries the seasons/episodes collected for one series
 * (episodeCount, episodeDetails, seasonCount, seasonDetails); test items are not recorded
 * as activity.
 */
export async function processAndSendNotification(
  data,
  client,
  pendingRequests,
  { libraryChannelId = null, batch = {}, isTest = false, onPendingRequestsChanged = null } = {}
) {
  batch = { episodeCount: 0, episodeDetails: null, seasonCount: 0, seasonDetails: null, ...batch };
  // The feed calls this directly too, so resolve the parent series ids here as well
  await applySeriesProviderIds(data);

  // A season's Provider_tmdb is a TMDB season ID, not a TV-series ID.
  const tmdbId = getNotificationTmdbId(data);
  const testPrefix = isTest ? "[TEST NOTIFICATION] " : "";
  logger.info(`${testPrefix}New item: ItemType=${data.ItemType}, Name=${data.Name}, tmdbId=${tmdbId}, Provider_imdb=${data.Provider_imdb}`);

  const requesters = takeRequesters(data, tmdbId, pendingRequests, onPendingRequestsChanged);
  const { details, omdb } = await fetchMetadata(tmdbId, data.ItemType);
  // Seerr's IMDb id first, then Jellyfin's
  const imdbId = details?.external_ids?.imdb_id || (isSeriesChild(data.ItemType) ? data.SeriesProvider_imdb : data.Provider_imdb);
  const post = buildItemNotification(data, { details, omdb, imdbId, batch });

  const channelId = announcementChannel(data, libraryChannelId);
  if (channelId === false) {
    // this kind of item is not announced; DMs below still go out
  } else if (!channelId) {
    logger.error(`❌ No Discord channel configured for ${data.ItemType} "${data.Name}" — set JELLYFIN_CHANNEL_ID or configure a library channel in the dashboard`);
  } else {
    await postToChannel(client, channelId, data, post, { batch, isTest });
    logger.info(`${testPrefix}Sent notification for: ${post.title}`);
  }

  for (const userId of requesters) {
    try {
      const user = await client.users.fetch(userId);
      await user.send(buildAvailableDm(data, post));
      logger.info(`Sent DM notification to user ${userId} for ${post.title}`);
    } catch (err) {
      logger.error(`Failed to send DM to user ${userId}:`, err?.message || err);
    }
  }
}
