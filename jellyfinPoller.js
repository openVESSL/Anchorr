import * as jellyfinApi from "./api/jellyfin.js";
import { processAndSendNotification } from "./jellyfinWebhook.js";
import logger from "./utils/logger.js";
import {
  fetchLibraryMap,
  resolveConfigLibraryId,
  getLibraryChannels,
  resolveTargetChannel,
  deduplicator,
} from "./jellyfin/libraryResolver.js";

class JellyfinPoller {
  constructor() {
    this.intervalId = null;
    this.isRunning = false;
    this.client = null;
    this.pendingRequests = null;
  }

  /**
   * Start the polling service
   * @param {Object} discordClient - Discord.js client instance
   * @param {Map} pendingRequests - Map of pending user requests
   */
  start(discordClient, pendingRequests) {
    if (this.isRunning) {
      logger.warn("Jellyfin polling service is already running");
      return;
    }

    const enabled = process.env.JELLYFIN_POLLING_ENABLED === "true";
    if (!enabled) {
      logger.info("Jellyfin polling is disabled in configuration");
      return;
    }

    const apiKey = process.env.JELLYFIN_API_KEY;
    const baseUrl = process.env.JELLYFIN_BASE_URL;
    const serverId = process.env.JELLYFIN_SERVER_ID;

    if (!apiKey || !baseUrl || !serverId) {
      logger.error(
        "Jellyfin polling requires JELLYFIN_API_KEY, JELLYFIN_BASE_URL, and JELLYFIN_SERVER_ID"
      );
      return;
    }

    this.client = discordClient;
    this.pendingRequests = pendingRequests;
    this.isRunning = true;

    const interval = parseInt(
      process.env.JELLYFIN_POLLING_INTERVAL || "300000",
      10
    );
    logger.info(
      `🔄 Jellyfin polling service started (interval: ${interval / 1000}s)`
    );

    // Run immediately on start
    this.poll();

    // Then run at intervals
    this.intervalId = setInterval(() => this.poll(), interval);
  }

  /**
   * Stop the polling service
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    this.client = null;
    this.pendingRequests = null;
    logger.info("⏹️ Jellyfin polling service stopped");
  }

  /**
   * Perform a single poll operation
   */
  async poll() {
    try {
      const apiKey = process.env.JELLYFIN_API_KEY;
      const baseUrl = process.env.JELLYFIN_BASE_URL;
      const serverId = process.env.JELLYFIN_SERVER_ID;

      logger.info("🔍 Polling Jellyfin for recently added items...");

      const { libraries, libraryIds, libraryIdMap } = await fetchLibraryMap();

      logger.info(
        `📚 Found ${libraries.length} libraries: ${libraries.map((l) => l.Name).join(", ")}`
      );
      logger.info(
        `📚 Virtual Folder IDs: ${libraries.map((l) => `${l.Name}=${l.ItemId}`).join(", ")}`
      );
      logger.info(
        `📚 Collection IDs: ${libraries.map((l) => `${l.Name}=${l.CollectionId || l.ItemId}`).join(", ")}`
      );

      const items = await jellyfinApi.fetchRecentlyAdded(apiKey, baseUrl, 50);

      if (items.length === 0) {
        logger.info("No recently added items found");
        return;
      }

      logger.info(`📦 Found ${items.length} recently added items`);

      // Log first few items for debugging
      items.slice(0, 3).forEach((item) => {
        logger.info(
          `  - ${item.Type}: ${item.Name} (ID: ${item.Id}, ParentId: ${item.ParentId})`
        );
      });

      // Debug: Log full first item to see what fields we have
      if (items.length > 0) {
        logger.info(
          `🔍 DEBUG - First item full data: ${JSON.stringify(items[0], null, 2)}`
        );
      }

      // Get notification type filters
      const notifyMovies = process.env.JELLYFIN_NOTIFY_MOVIES !== "false";
      const notifySeries = process.env.JELLYFIN_NOTIFY_SERIES !== "false";
      const notifySeasons = process.env.JELLYFIN_NOTIFY_SEASONS !== "false";
      const notifyEpisodes = process.env.JELLYFIN_NOTIFY_EPISODES !== "false";

      const libraryChannels = getLibraryChannels();
      const defaultChannelId = process.env.JELLYFIN_CHANNEL_ID;

      logger.info(`📚 Library channels configured: ${JSON.stringify(libraryChannels)}`);
      logger.info(`📢 Default channel: ${defaultChannelId}`);

      for (const item of items) {
        const itemId = item.Id;
        const itemType = item.Type;

        // Check if we should notify for this type
        if (
          (itemType === "Movie" && !notifyMovies) ||
          (itemType === "Series" && !notifySeries) ||
          (itemType === "Season" && !notifySeasons) ||
          (itemType === "Episode" && !notifyEpisodes)
        ) {
          logger.debug(`Skipping ${itemType} notification (disabled in config)`);
          continue;
        }

        // Deduplication
        if (deduplicator.checkAndRecord(itemId)) {
          logger.info(`⏭️ Skipping ${itemType} "${item.Name}" - already notified recently`);
          continue;
        }

        // Resolve library ID
        let libraryId = null;
        logger.info(
          `🔎 Item "${item.Name}" (${itemType}) - ParentId from /Items/Latest: ${item.ParentId}`
        );

        if (item.ParentId && libraryIds.has(item.ParentId)) {
          libraryId = item.ParentId;
          logger.info(`✅ ParentId matched a known library: ${libraryId}`);
        } else if (item.ParentId) {
          logger.info(`⚠️ ParentId ${item.ParentId} not in library set, traversing up...`);
          libraryId = await jellyfinApi.findLibraryId(itemId, apiKey, baseUrl, libraryIds);
        } else {
          logger.info(`⚠️ No ParentId provided, traversing up from item ${itemId}...`);
          libraryId = await jellyfinApi.findLibraryId(itemId, apiKey, baseUrl, libraryIds);
        }

        logger.info(`🔍 Processing ${itemType} "${item.Name}" - Detected LibraryId: ${libraryId}`);

        const configLibraryId = resolveConfigLibraryId(libraryId, libraryIdMap);
        const targetChannelId = resolveTargetChannel(configLibraryId, libraryChannels);

        if (!targetChannelId) continue;

        logger.info(`✅ Will send to channel: ${targetChannelId}`);

        const webhookData = jellyfinApi.transformToWebhookFormat(item, baseUrl, serverId);

        try {
          await processAndSendNotification(
            webhookData,
            this.client,
            this.pendingRequests,
            targetChannelId
          );
          logger.info(`✅ Sent notification for ${itemType}: ${item.Name}`);
        } catch (err) {
          logger.error(`Failed to send notification for ${itemId}:`, err);
        }
      }

      // Cleanup old deduplicator entries
      deduplicator.cleanup();
    } catch (err) {
      logger.error("Error during Jellyfin polling:", err);
    }
  }
}

// Export singleton instance
export const jellyfinPoller = new JellyfinPoller();
