import WebSocket from "ws";
import logger from "./utils/logger.js";
import * as jellyfinApi from "./api/jellyfin.js";
import { processAndSendNotification } from "./jellyfinWebhook.js";
import {
  fetchLibraryMap,
  resolveConfigLibraryId,
  getLibraryChannels,
  resolveTargetChannel,
  deduplicator,
} from "./jellyfin/libraryResolver.js";

/**
 * Jellyfin WebSocket Client for real-time notifications
 * Listens for LibraryChanged events and sends Discord notifications instantly
 */
export class JellyfinWebSocketClient {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.isRunning = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 0; // Unlimited retries
    this.baseReconnectDelay = 1000; // Start at 1 second
    this.maxReconnectDelay = 60000; // Cap at 60 seconds
    this.client = null;
    this.pendingRequests = null;
    this.libraryIdMap = new Map(); // Collection ID → Virtual Folder ID mapping
    this.keepAliveCount = 0; // Count keep-alive messages for logging
  }

  /**
   * Start WebSocket connection
   */
  async start(discordClient, pendingRequests) {
    try {
      this.client = discordClient;
      this.pendingRequests = pendingRequests;
      this.isRunning = true;

      await this.connect();
    } catch (err) {
      logger.error("Failed to start Jellyfin WebSocket client:", err);
      this.isRunning = false;
    }
  }

  /**
   * Connect to Jellyfin WebSocket
   */
  async connect() {
    try {
      const apiKey = process.env.JELLYFIN_API_KEY;
      const baseUrl = process.env.JELLYFIN_BASE_URL;

      if (!apiKey || !baseUrl) {
        logger.warn(
          "Jellyfin WebSocket: Missing JELLYFIN_API_KEY or JELLYFIN_BASE_URL"
        );
        return;
      }

      // Convert HTTP URL to WebSocket URL
      const wsUrl = baseUrl
        .replace("https://", "wss://")
        .replace("http://", "ws://")
        .replace(/\/$/, "");

      const deviceId = "anchorr-bot";
      const fullUrl = `${wsUrl}/socket?api_key=${apiKey}&deviceId=${deviceId}`;

      logger.info(`🔌 Connecting to Jellyfin WebSocket: ${wsUrl}/socket`);
      logger.debug(`   Base URL: ${baseUrl}`);
      logger.debug(`   WebSocket URL: ${wsUrl}/socket`);

      this.ws = new WebSocket(fullUrl);

      this.ws.on("open", () => {
        logger.info("✅ Connected to Jellyfin WebSocket");
        this.isConnected = true;
        this.reconnectAttempts = 0;

        // Send initial connection message (required by Jellyfin)
        const initMessage = {
          MessageType: "SessionsStart",
          Data: "0,1000",
        };

        try {
          this.ws.send(JSON.stringify(initMessage));
          logger.info("📤 Sent SessionsStart subscription message");
        } catch (err) {
          logger.error("Failed to send SessionsStart message:", err);
        }

        // Fetch and cache library mappings on connection
        this.refreshLibraryMappings();
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        logger.error("Jellyfin WebSocket error:", err?.message || err);
        if (err?.code) logger.error("Error code:", err.code);
      });

      this.ws.on("close", (code, reason) => {
        logger.warn(
          `❌ Disconnected from Jellyfin WebSocket (code: ${code}, reason: ${
            reason || "N/A"
          })`
        );

        const closeCodeMap = {
          1000: "Normal closure",
          1001: "Going away",
          1002: "Protocol error",
          1003: "Unsupported data",
          1006: "Abnormal closure",
          1007: "Invalid frame payload",
          1008: "Policy violation",
          1009: "Message too big",
          1010: "Missing extension",
          1011: "Internal server error",
        };
        const codeDescription = closeCodeMap[code] || "Unknown code";
        logger.warn(`   Code: ${code} (${codeDescription})`);

        this.isConnected = false;

        if (this.isRunning) {
          logger.info("⏳ Attempting to reconnect...");
          this.attemptReconnect();
        }
      });
    } catch (err) {
      logger.error("Failed to connect to Jellyfin WebSocket:", err);
      if (this.isRunning) {
        this.attemptReconnect();
      }
    }
  }

  /**
   * Attempt to reconnect with exponential backoff
   */
  attemptReconnect() {
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    logger.info(
      `⏳ WebSocket reconnect attempt ${this.reconnectAttempts + 1} in ${delay}ms`
    );

    setTimeout(() => {
      if (this.isRunning) {
        this.connect();
      }
    }, delay);

    this.reconnectAttempts++;
  }

  /**
   * Refresh library ID mappings (Collection → Virtual Folder)
   */
  async refreshLibraryMappings() {
    try {
      const { libraries, libraryIdMap } = await fetchLibraryMap();
      this.libraryIdMap = libraryIdMap;
      logger.info(`✅ Cached ${libraries.length} library mappings`);
    } catch (err) {
      logger.warn("Failed to refresh library mappings:", err?.message || err);
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  async handleMessage(data) {
    try {
      const messageStr = data.toString();

      if (!messageStr || messageStr.trim() === "") {
        return;
      }

      const message = JSON.parse(messageStr);

      if (message.MessageType !== "KeepAlive") {
        logger.info(`📡 WebSocket message: ${message.MessageType}`);
        if (message.Data) {
          const dataPreview =
            message.Data.length > 200
              ? message.Data.substring(0, 200) + "..."
              : message.Data;
          logger.debug(`   Data: ${dataPreview}`);
        }
      } else {
        if (!this.keepAliveCount) this.keepAliveCount = 0;
        this.keepAliveCount++;
        if (this.keepAliveCount % 100 === 0) {
          logger.debug(`🔄 KeepAlive messages: ${this.keepAliveCount}`);
        }
      }

      if (message.MessageType === "LibraryChanged") {
        await this.handleLibraryChanged(message);
      } else if (message.MessageType === "KeepAlive") {
        // Ignore keepalive messages silently
      } else {
        logger.debug(`Unhandled WebSocket message type: ${message.MessageType}`);
      }
    } catch (err) {
      logger.warn("Failed to parse WebSocket message:", err?.message || err);
      logger.debug("Raw message data:", data.toString().substring(0, 500));
    }
  }

  /**
   * Handle LibraryChanged event
   */
  async handleLibraryChanged(message) {
    try {
      const libraryUpdate = JSON.parse(message.Data);
      const itemsAdded = libraryUpdate.ItemsAdded || [];

      if (itemsAdded.length === 0) {
        return;
      }

      logger.info(
        `📡 LibraryChanged: ${itemsAdded.length} item(s) added (+ ${
          (libraryUpdate.ItemsUpdated || []).length
        } updated, - ${(libraryUpdate.ItemsRemoved || []).length} removed)`
      );

      const apiKey = process.env.JELLYFIN_API_KEY;
      const baseUrl = process.env.JELLYFIN_BASE_URL;
      const serverId = process.env.JELLYFIN_SERVER_ID;
      const libraryChannels = getLibraryChannels();
      const defaultChannelId = process.env.JELLYFIN_CHANNEL_ID;

      for (const itemId of itemsAdded) {
        try {
          await this.processNewItem(
            itemId,
            libraryUpdate,
            apiKey,
            baseUrl,
            serverId,
            libraryChannels,
            defaultChannelId
          );
        } catch (err) {
          logger.warn(`Failed to process item ${itemId}:`, err?.message || err);
        }
      }
    } catch (err) {
      logger.error("Failed to handle LibraryChanged event:", err?.message || err);
    }
  }

  /**
   * Process a newly added item
   */
  async processNewItem(
    itemId,
    libraryUpdate,
    apiKey,
    baseUrl,
    serverId,
    libraryChannels,
    defaultChannelId
  ) {
    // Deduplication
    if (deduplicator.checkAndRecord(itemId)) {
      const lastSeen = deduplicator.seenItems.get(itemId);
      logger.info(
        `⏭️ Skipping item ${itemId} - already notified recently (${Math.round(
          (Date.now() - lastSeen) / 60000
        )} minutes ago)`
      );
      return;
    }

    logger.info(`🔍 Processing newly added item: ${itemId}`);

    const item = await jellyfinApi.fetchItemDetails(itemId, apiKey, baseUrl);
    if (!item) {
      logger.warn(`Failed to fetch details for item ${itemId}`);
      return;
    }

    const itemType = item.Type || "Unknown";
    logger.info(`📺 Item: "${item.Name}" (${itemType}) - ParentId: ${item.ParentId}`);

    // Determine library ID — prefer CollectionFolders from the event payload
    let libraryId = null;
    if (libraryUpdate.CollectionFolders && libraryUpdate.CollectionFolders.length > 0) {
      libraryId = libraryUpdate.CollectionFolders[0];
      logger.info(`✅ Library ID from CollectionFolders: ${libraryId}`);
    } else if (item.ParentIds && item.ParentIds.length > 0) {
      libraryId = item.ParentIds[0];
      logger.info(`✅ Library ID from item ParentIds: ${libraryId}`);
    } else if (item.ParentId) {
      libraryId = item.ParentId;
      logger.info(`✅ Library ID from item ParentId: ${libraryId}`);
    }

    if (!libraryId) {
      logger.warn(`❌ Could not determine library ID for item ${itemId} - skipping notification`);
      return;
    }

    const configLibraryId = resolveConfigLibraryId(libraryId, this.libraryIdMap);
    const targetChannelId = resolveTargetChannel(configLibraryId, libraryChannels);

    if (!targetChannelId) return;

    logger.info(`✅ Will send to channel: ${targetChannelId}`);

    try {
      const webhookData = jellyfinApi.transformToWebhookFormat(item, baseUrl, serverId);

      await processAndSendNotification(
        webhookData,
        this.client,
        this.pendingRequests,
        targetChannelId
      );

      logger.info(`📤 Notification sent for "${item.Name}"`);
    } catch (err) {
      logger.error(`Failed to send notification for item ${itemId}:`, err?.message || err);
    }
  }

  /**
   * Stop WebSocket connection
   */
  stop() {
    logger.info("Stopping Jellyfin WebSocket client...");
    this.isRunning = false;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    logger.info("✅ WebSocket client stopped");
  }
}

export default JellyfinWebSocketClient;
