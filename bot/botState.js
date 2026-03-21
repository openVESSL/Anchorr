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
    logger.warn(`⚠️ Failed to load pending requests from disk: ${err.message}`);
  }
}
