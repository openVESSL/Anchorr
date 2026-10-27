import fs from "fs";
import path from "path";
import { CONFIG_PATH } from "../utils/configFile.js";
import logger from "../utils/logger.js";

// Shared mutable bot state — imported by app.js and route files alike.
// Using a plain object so property writes are visible to all importers.
export const botState = {
  isBotRunning: false,
  discordClient: null,
  jellyfinWebSocketClient: null,
};

// --- PENDING REQUESTS TRACKING ---
// Map to track user requests: key = "tmdbId-mediaType", value = Set of Discord user IDs
export const pendingRequests = new Map();

export const PENDING_REQUESTS_PATH = path.join(
  path.dirname(CONFIG_PATH),
  "pending-requests.json"
);

export function savePendingRequests() {
  try {
    const serialized = {};
    for (const [key, userSet] of pendingRequests) {
      serialized[key] = Array.from(userSet);
    }
    fs.writeFileSync(
      PENDING_REQUESTS_PATH,
      JSON.stringify(serialized, null, 2),
      { encoding: "utf-8", mode: 0o600 }
    );
  } catch (err) {
    logger.warn(`⚠️ Failed to persist pending requests to disk: ${err.message}`);
  }
}

export function loadPendingRequests() {
  if (!fs.existsSync(PENDING_REQUESTS_PATH)) return;
  try {
    const raw = fs.readFileSync(PENDING_REQUESTS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    for (const [key, userArray] of Object.entries(parsed)) {
      if (Array.isArray(userArray) && userArray.length > 0) {
        pendingRequests.set(key, new Set(userArray));
      }
    }
    logger.info(`✅ Loaded ${pendingRequests.size} pending request(s) from disk`);
  } catch (err) {
    logger.error(`Failed to load pending requests from disk: ${err.message}`);
    try {
      const corruptPath = PENDING_REQUESTS_PATH.replace(".json", `.corrupt.${Date.now()}.json`);
      fs.renameSync(PENDING_REQUESTS_PATH, corruptPath);
      logger.warn(`Corrupted pending requests file moved to ${path.basename(corruptPath)} — starting with empty state`);
    } catch (_) {
      // Cannot rename; original file stays in place
    }
  }
}

// --- REQUEST CHANNEL TRACKING ---
// key = "tmdbId-mediaType", value = channel ID the request was made in.
// Kept in its own file so the pending-requests.json format is unchanged.
export const requestChannels = new Map();

export const REQUEST_CHANNELS_PATH = path.join(
  path.dirname(CONFIG_PATH),
  "request-channels.json"
);

function saveRequestChannels() {
  try {
    fs.writeFileSync(
      REQUEST_CHANNELS_PATH,
      JSON.stringify(Object.fromEntries(requestChannels), null, 2),
      { encoding: "utf-8", mode: 0o600 }
    );
  } catch (err) {
    logger.warn(`⚠️ Failed to persist request channels to disk: ${err.message}`);
  }
}

export function loadRequestChannels() {
  if (!fs.existsSync(REQUEST_CHANNELS_PATH)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(REQUEST_CHANNELS_PATH, "utf-8"));
    for (const [key, channelId] of Object.entries(parsed)) {
      if (typeof channelId === "string") requestChannels.set(key, channelId);
    }
  } catch (err) {
    logger.error(`Failed to load request channels from disk: ${err.message}`);
  }
}

/**
 * Remember who requested a title (and where) so they can be notified once it
 * is available. No-op unless a notification option that needs it is enabled.
 */
export function trackRequest(tmdbId, mediaType, userId, channelId) {
  if (
    process.env.NOTIFY_ON_AVAILABLE !== "true" &&
    process.env.NOTIFY_TAG_REQUESTERS !== "true"
  ) {
    return;
  }
  const requestKey = `${tmdbId}-${mediaType}`;
  if (!pendingRequests.has(requestKey)) {
    pendingRequests.set(requestKey, new Set());
  }
  pendingRequests.get(requestKey).add(userId);
  savePendingRequests();
  if (channelId) {
    requestChannels.set(requestKey, channelId);
    saveRequestChannels();
  }
}

export function takeRequestChannel(requestKey) {
  const channelId = requestChannels.get(requestKey);
  if (channelId !== undefined) {
    requestChannels.delete(requestKey);
    saveRequestChannels();
  }
  return channelId;
}
