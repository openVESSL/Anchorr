/**
 * Decides whether and when a new Jellyfin item is announced.
 *
 * Movies are posted at once, once. Series, seasons and episodes of one series are collected
 * into a batch and posted after a quiet period, as the highest level that arrived (a new
 * show is one post, not one per episode). Items already covered by a post are skipped.
 *
 * Item ids starting with "test-" (single test) or "batch-" (batch test) come from the
 * dashboard's test buttons: they go to the default channel and are never remembered.
 */
import { debounce } from "../utils/debounce.js";
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";
import {
  findLegacyItemKey,
  getItemLevel,
  IN_PROGRESS_TTL_MS,
  SEASON_NOTIFICATION_DELAY_MS,
  SERIES_BURST_WINDOW_MS,
  sentNotifications,
} from "./dedup.js";
import { buildIdentityKey } from "./libraryResolver.js";
import { chooseLibraryChannel } from "./libraryDetection.js";
import { applySeriesProviderIds } from "./notificationMetadata.js";
import { processAndSendNotification } from "./notificationSender.js";

const DEFAULT_DEBOUNCE_MS = 60_000;
const NEW_SERIES_DEBOUNCE_MS = 120_000; // episodes of a new show wait longer so the show itself can arrive first
const BATCH_TEST_DEBOUNCE_MS = 3000;
const FLUSH_ABOVE_SEASONS = 10;
const FLUSH_ABOVE_EPISODES = 30;
const STALE_BATCH_MS = 14 * 24 * 60 * 60 * 1000;

const batches = new Map(); // series identity key -> batch waiting to be posted

// Long-running servers: drop batches that never fired
setInterval(() => {
  const cutoff = Date.now() - STALE_BATCH_MS;
  let removed = 0;
  for (const [key, batch] of batches) {
    if (batch.timestamp < cutoff) {
      batches.delete(key);
      removed++;
    }
  }
  if (removed > 0) logger.debug(`Periodic cleanup: Removed ${removed} old debouncer(s)`);
}, 24 * 60 * 60 * 1000);

const isTestItem = (data) => data.ItemId.startsWith("test-") || data.ItemId.startsWith("batch-");

/**
 * Handles one new Jellyfin item from the feed (or a dashboard test). Never throws: a
 * failure is logged and the next item is handled normally.
 */
export async function handleJellyfinItem(data, client, pendingRequests, onPendingRequestsChanged) {
  try {
    if (!data?.ItemId) return;
    const isTest = isTestItem(data);
    const library = await chooseLibraryChannel(data, isTest);
    if (!library) return; // its library is turned off

    // Provider ids are per item; artwork, requests and series dedup need the series' ids
    await applySeriesProviderIds(data);

    const send = (item, options) =>
      processAndSendNotification(item, client, pendingRequests, { libraryChannelId: library.channelId, onPendingRequestsChanged, ...options });

    if (data.ItemType === "Movie") return await handleMovie(data, send);
    if (["Series", "Season", "Episode"].includes(data.ItemType)) return await handleSeriesItem(data, send, isTest);
    await send(data, { isTest });
  } catch (err) {
    logger.error("Error handling Jellyfin item:", err);
  }
}

async function handleMovie(data, send) {
  if (data.ItemId.startsWith("test-")) return send(data, { isTest: true });
  const key = buildIdentityKey(data) || `id:${data.ItemId}`;
  if (sentNotifications.has(key)) {
    logger.info(`[DEDUP] Duplicate movie notification suppressed for "${data.Name}" (key: ${key})`);
    return;
  }
  await send(data, { isTest: false });
  sentNotifications.set(key, { level: 0 });
}

/**
 * True when an earlier post already covers this item: a pending batch that already fired,
 * or a higher-level post (a season may still follow its series after a few minutes).
 */
function isBlocked(burst, level, seriesKey, data) {
  const sentLevel = burst?.level ?? 0;
  if (sentLevel === -1) {
    // A batch for this series is pending: join it, unless it already fired
    const blocked = !batches.has(seriesKey);
    logger.debug(`[${blocked ? "BLOCKED" : "ALLOWED"}] ${data.ItemType} "${data.Name}": series already in progress${blocked ? " with no active debouncer" : ", adding to its batch"}`);
    return blocked;
  }
  if (sentLevel <= 0 || level >= sentLevel) return false;
  if (level === 2 && sentLevel === 3) {
    const minutes = Math.round((Date.now() - burst.timestamp) / 60_000);
    if (Date.now() - burst.timestamp > SEASON_NOTIFICATION_DELAY_MS) {
      logger.info(`[ALLOWED] Season notification allowed: ${minutes} minutes since series notification`);
      return false;
    }
    logger.info(`[TIME BLOCKED] Season notification blocked: only ${minutes} minutes since series notification (need ${SEASON_NOTIFICATION_DELAY_MS / 60_000})`);
  }
  return true;
}

async function handleSeriesItem(data, send, isTest) {
  // A Series item has no SeriesId: it is its own series
  const seriesId = data.SeriesId || (data.ItemType === "Series" ? data.ItemId : null);
  const seriesKey =
    buildIdentityKey({
      ItemType: "Series",
      Provider_tmdb: data.ItemType === "Series" ? data.Provider_tmdb : data.SeriesProvider_tmdb,
      SeriesId: seriesId,
      Name: data.SeriesName || (data.ItemType === "Series" ? data.Name : null),
      ItemId: seriesId,
    }) || `id:${seriesId}`;
  // burstKey: short-lived, groups one import burst for the series.
  // itemKey: permanent, stops file upgrades from re-announcing an item.
  const burstKey = `burst:${seriesKey}`;
  const itemKey = `item:${buildIdentityKey(data) || `id:${data.ItemId}`}`;
  const level = getItemLevel(data.ItemType);
  const isSingleTest = data.ItemId.startsWith("test-");
  logger.debug(`[DEDUP] Series identity key for "${data.Name}": ${seriesKey} (raw SeriesId: ${seriesId})`);

  let sentLevel = 0;
  if (!isSingleTest) {
    const matchedKey = isTest ? null : sentNotifications.has(itemKey) ? itemKey : findLegacyItemKey(data);
    if (matchedKey) {
      logger.info(`[DEDUP] Duplicate ${data.ItemType} notification suppressed for "${data.Name}" (key: ${matchedKey})`);
      return;
    }
    const burst = sentNotifications.get(burstKey);
    sentLevel = burst?.level ?? 0;
    logger.debug(`[DUPLICATE CHECK] ${data.ItemType} "${data.Name}" - SeriesId: ${seriesId}, sentLevel: ${sentLevel}, currentLevel: ${level}, has debouncer: ${batches.has(seriesKey)}`);
    if (isBlocked(burst, level, seriesKey, data)) {
      logger.info(`[BLOCKED] Skipping ${data.ItemType} notification for ${data.Name}: already sent level ${sentLevel} (current level: ${level})`);
      // Only mark items the sent post actually covered: a series post covers everything,
      // a season post only its own seasons' episodes. -1 means nothing was sent yet.
      const covered = sentLevel === 3 || (sentLevel === 2 && burst.seasons?.includes(data.SeasonNumber));
      if (covered && !isTest) sentNotifications.set(itemKey, { level });
      return;
    }
  }

  if (!seriesId || isSingleTest) {
    await send(data, { isTest });
    if (!isTest) sentNotifications.set(itemKey, { level });
    return;
  }

  const batch = batches.get(seriesKey) ?? startBatch(seriesKey, burstKey, data, level, sentLevel, send);
  // A flushed batch is being posted: items of the same import count as covered by that post
  if (batch.flushed) {
    if (!isTest) sentNotifications.set(itemKey, { level });
    return;
  }
  if (!isTest) batch.itemKeys.set(itemKey, level);
  // The post shows the highest level received (Series > Season > Episode), the latest of it
  if (level >= getItemLevel(batch.latestData.ItemType)) batch.latestData = data;
  if (!addToBatch(batch, data)) return;

  batch.sender(
    batch.latestData,
    batch.episodeCount,
    { episodes: batch.episodes, firstEpisode: batch.firstEpisode, lastEpisode: batch.lastEpisode },
    batch.seasonCount,
    { seasons: batch.seasons }
  );
  // A whole season or show at once: post now instead of waiting
  if (batch.episodeCount > FLUSH_ABOVE_EPISODES || batch.seasonCount > FLUSH_ABOVE_SEASONS) {
    batch.flushed = true;
    batch.sender.flush();
  }
  logger.debug(`[DEBOUNCER] Batch for ${seriesId}: ${batch.episodeCount} episode(s), ${batch.seasonCount} season(s)`);
}

function startBatch(seriesKey, burstKey, data, level, sentLevel, send) {
  const isBatchTest = data.ItemId.startsWith("batch-");
  const isNewSeries = sentLevel === 0;
  const debounceMs = isBatchTest
    ? BATCH_TEST_DEBOUNCE_MS
    : isNewSeries && level < 3
      ? NEW_SERIES_DEBOUNCE_MS
      : parseInt(settings.WEBHOOK_DEBOUNCE_MS) || DEFAULT_DEBOUNCE_MS;
  logger.info(`[DEBOUNCER] Creating debouncer for ${data.ItemType} "${data.Name}" with ${debounceMs}ms timeout (new series: ${isNewSeries}, lower level: ${level < 3}${isBatchTest ? ", batch test" : ""})`);

  const batch = {
    sender: null,
    latestData: data,
    episodeCount: 0,
    episodes: [],
    firstEpisode: null,
    lastEpisode: null,
    seasonCount: 0,
    seasons: [],
    timestamp: Date.now(),
    itemKeys: new Map(), // itemKey -> level, remembered after a successful post
  };

  // The closure holds its own batch: a late trailing call must not touch a newer batch.
  batch.sender = debounce(async (latestData, episodeCount, episodeDetails, seasonCount, seasonDetails) => {
    // Items arriving while this send is in flight belong to the next trailing call.
    const itemKeysInSend = batch.itemKeys;
    batch.itemKeys = new Map();
    const seasonsInSend = [...batch.seasons, latestData]
      .map((item) => item.SeasonNumber ?? (item.ItemType === "Season" ? item.IndexNumber : null))
      .filter((n) => n != null);
    try {
      logger.info(`[DEBOUNCER] Firing debouncer for ${seriesKey} after ${debounceMs}ms wait. Episodes: ${episodeCount}, Seasons: ${seasonCount}`);
      await send(latestData, {
        batch: { episodeCount, episodeDetails, seasonCount, seasonDetails },
        isTest: latestData.ItemId.startsWith("batch-"),
      });
      const levelSent = getItemLevel(latestData.ItemType);
      // Overwrites the in-progress marker
      sentNotifications.set(burstKey, { level: levelSent, timestamp: Date.now(), seasons: seasonsInSend }, SERIES_BURST_WINDOW_MS);
      logger.info(`[SENT NOTIFICATION] Set sentLevel=${levelSent} for ${seriesKey} (${latestData.Name})`);
      for (const [key, itemLevel] of itemKeysInSend) sentNotifications.set(key, { level: itemLevel });
    } catch (error) {
      logger.error(
        `Error in debounced notification for series ${seriesKey} (${itemKeysInSend.size} item(s) not marked as sent, they can be announced again):`,
        error
      );
      // Clear the in-progress marker so the series is not blocked after a failed post
      if (sentNotifications.get(burstKey)?.level === -1) sentNotifications.delete(burstKey);
    } finally {
      if (batches.get(seriesKey) === batch) batches.delete(seriesKey);
    }
  }, debounceMs);

  batches.set(seriesKey, batch);
  // Marks the series as in progress. If the batch never fires (crash), it expires on its own.
  sentNotifications.set(burstKey, { level: -1, timestamp: Date.now() }, IN_PROGRESS_TTL_MS);
  return batch;
}

/** Adds a season or episode to the batch; false when the batch already has it. */
function addToBatch(batch, data) {
  if (data.ItemType === "Season") {
    const duplicate = batch.seasons.find(
      (s) =>
        (s.SeasonNumber !== undefined && s.SeasonNumber === data.SeasonNumber) ||
        (s.IndexNumber !== undefined && s.IndexNumber === data.IndexNumber)
    );
    if (duplicate) {
      logger.info(`[DEBOUNCER] Duplicate season skipped: S${data.SeasonNumber} (idx:${data.IndexNumber}, name:"${data.Name}")`);
      return false;
    }
    batch.seasonCount++;
    batch.seasons.push(data);
  }
  if (data.ItemType === "Episode") {
    const duplicate = batch.episodes.find(
      (ep) =>
        ep.EpisodeNumber !== undefined &&
        data.EpisodeNumber !== undefined &&
        ep.EpisodeNumber === data.EpisodeNumber &&
        ep.SeasonNumber === data.SeasonNumber
    );
    if (duplicate) {
      logger.info(`[DEBOUNCER] Duplicate episode skipped: S${data.SeasonNumber}E${data.EpisodeNumber} ("${data.Name}")`);
      return false;
    }
    batch.episodeCount++;
    batch.episodes.push(data);
    if (!batch.firstEpisode || data.EpisodeNumber < batch.firstEpisode.EpisodeNumber) batch.firstEpisode = data;
    if (!batch.lastEpisode || data.EpisodeNumber > batch.lastEpisode.EpisodeNumber) batch.lastEpisode = data;
  }
  return true;
}
