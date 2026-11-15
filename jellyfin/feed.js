/**
 * Jellyfin item feed: finds new movies, shows, seasons and episodes without any Jellyfin
 * plugin. A WebSocket delivers LibraryChanged events live; a catch-up poll (on connect and
 * every few minutes) picks up whatever was added while Anchorr was offline.
 *
 * Every new item becomes the same payload the Jellyfin Webhook plugin used to send and
 * goes through the same handler, so dedup, episode batching and channel routing are shared.
 * Like the plugin, an item waits until Jellyfin has identified it (provider IDs).
 */
import http from "../utils/http.js";
import WebSocket from "ws";
import { fetchRecentlyAdded, jellyfinAuthHeaders } from "../api/jellyfin.js";
import { TIMEOUTS } from "../lib/constants.js";
import logger from "../utils/logger.js";
import { PersistentMap } from "../utils/persistentMap.js";
import { settings } from "../utils/settings.js";

const NOTIFY_TYPES = new Set(["Movie", "Series", "Season", "Episode"]);
const ITEM_FIELDS =
  "ProviderIds,Overview,Genres,Path,ProductionYear,RunTimeTicks,DateCreated,SeriesName,SeriesId,SeasonId,IndexNumber,ParentIndexNumber,IndexNumberEnd";
const METADATA_WAIT_MS = 30_000;
const MAX_METADATA_ATTEMPTS = 4; // then sent with whatever Jellyfin has
const POLL_INTERVAL_MS = Number(process.env.JELLYFIN_POLLING_INTERVAL) || 15 * 60_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const RECENT_DISPATCH_LIMIT = 2000;
const NEVER_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const CURSOR_KEY = "cursor";

const pad = (n) => String(n).padStart(2, "0");

/** Jellyfin ticks (100 ns) -> "HH:MM:SS", the plugin's RunTime format. */
export function ticksToHhMmSs(ticks) {
  const total = Math.round(Number(ticks) / 10_000_000);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** Jellyfin item -> the payload the Webhook plugin sent ("Send All Properties"). */
export function toWebhookPayload(item, baseUrl) {
  const payload = {
    ItemType: item.Type,
    ItemId: item.Id,
    ServerId: item.ServerId,
    ServerUrl: baseUrl,
    Name: item.Name,
    Overview: item.Overview,
    Year: item.ProductionYear,
    Genres: item.Genres?.length ? item.Genres : undefined,
    RunTime: item.RunTimeTicks ? ticksToHhMmSs(item.RunTimeTicks) : undefined,
    Path: item.Path,
    Provider_tmdb: item.ProviderIds?.Tmdb,
    Provider_imdb: item.ProviderIds?.Imdb,
    Provider_tvdb: item.ProviderIds?.Tvdb,
  };
  if (item.Type === "Season" || item.Type === "Episode") {
    payload.SeriesId = item.SeriesId;
    payload.SeriesName = item.SeriesName;
  }
  if (item.Type === "Season") {
    payload.SeasonId = item.Id;
    payload.SeasonNumber = item.IndexNumber;
    payload.IndexNumber = item.IndexNumber;
  }
  if (item.Type === "Episode") {
    payload.SeasonId = item.SeasonId;
    payload.SeasonNumber = item.ParentIndexNumber;
    payload.EpisodeNumber = item.IndexNumber;
    payload.IndexNumber = item.IndexNumber;
    payload.EpisodeNumberEnd = item.IndexNumberEnd;
  }
  return Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

/** True once Jellyfin has identified the item, so the notification gets proper metadata. */
export function hasMetadata(item) {
  if (Object.values(item.ProviderIds || {}).some(Boolean)) return true;
  // Seasons and episodes often carry no provider IDs of their own
  return (item.Type === "Season" || item.Type === "Episode") && Boolean(item.SeriesId) && item.IndexNumber != null;
}

export class JellyfinFeed {
  /**
   * @param {object} options
   * @param {(payload: object) => Promise<void>} options.dispatch receives each new item
   * @param {PersistentMap} [options.state] where the catch-up cursor is kept
   * @param {typeof WebSocket} [options.WebSocketImpl]
   */
  constructor({ dispatch, state, WebSocketImpl = WebSocket }) {
    this.dispatch = dispatch;
    this.state = state ?? new PersistentMap("jellyfin-feed", NEVER_TTL_MS);
    this.WebSocketImpl = WebSocketImpl;
    this.pending = new Map(); // itemId -> attempts so far
    this.recentlyDispatched = new Set();
    this.running = false;
    this.ws = null;
    this.timers = new Set();
    this.queueTimer = null;
    this.reconnectAttempts = 0;
  }

  start() {
    if (this.running) return;
    if (!settings.JELLYFIN_BASE_URL || !settings.JELLYFIN_API_KEY) {
      logger.warn("Jellyfin feed not started: Jellyfin URL or API key is missing");
      return;
    }
    this.running = true;
    this.connect();
    this.every(POLL_INTERVAL_MS, () => this.poll());
    logger.info("📡 Watching Jellyfin for new items (WebSocket + catch-up poll)");
  }

  stop() {
    this.running = false;
    for (const timer of this.timers) clearTimeout(timer); // also clears intervals in Node
    this.timers.clear();
    this.queueTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  // ----- timers (unref'd: the feed never keeps the process alive on its own) -----

  later(ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  every(ms, fn) {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  // ----- WebSocket -----

  connect() {
    if (!this.running) return;
    const url = new URL(settings.JELLYFIN_BASE_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = url.pathname.replace(/\/$/, "") + "/socket";
    url.search = "";
    url.searchParams.set("deviceId", "anchorr-feed");

    let keepAlive = null;
    // The key goes in a header, never in the URL, so proxies do not log it
    const ws = new this.WebSocketImpl(url.href, { headers: jellyfinAuthHeaders(settings.JELLYFIN_API_KEY) });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      logger.info("✅ Connected to Jellyfin");
      this.poll(); // catch up on anything added while disconnected
    });
    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.MessageType === "ForceKeepAlive") {
        // Jellyfin drops clients that stay silent longer than this many seconds
        if (keepAlive) clearInterval(keepAlive);
        const everyMs = Math.max(5, Number(message.Data) || 60) * 500;
        keepAlive = this.every(everyMs, () => ws.readyState === 1 && ws.send(JSON.stringify({ MessageType: "KeepAlive" })));
      } else if (message.MessageType === "LibraryChanged") {
        const data = typeof message.Data === "string" ? JSON.parse(message.Data) : message.Data;
        for (const id of data?.ItemsAdded || []) this.enqueue(id);
      }
    });
    ws.on("error", (err) => {
      const rejected = /Unexpected server response: (401|403)/.test(err?.message || "");
      logger.error(
        rejected
          ? "Jellyfin rejected the API key for the live connection. Check the Jellyfin API key."
          : `Jellyfin connection error: ${err?.message || err}`
      );
    });
    ws.on("close", (code) => {
      if (keepAlive) {
        clearInterval(keepAlive);
        this.timers.delete(keepAlive);
      }
      if (this.ws === ws) this.ws = null;
      if (!this.running) return;
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
      this.reconnectAttempts++;
      logger.warn(`Jellyfin connection closed (code ${code}), reconnecting in ${Math.round(delay / 1000)}s`);
      this.later(delay, () => this.connect());
    });
  }

  // ----- new-item queue -----

  enqueue(itemId) {
    if (this.pending.has(itemId) || this.recentlyDispatched.has(itemId)) return;
    this.pending.set(itemId, 0);
    if (!this.queueTimer) {
      this.queueTimer = this.later(METADATA_WAIT_MS, () => {
        this.queueTimer = null;
        this.processQueue().catch((err) => logger.error(`Jellyfin feed: ${err.message}`));
      });
    }
  }

  async fetchItems(ids) {
    const items = [];
    for (let i = 0; i < ids.length; i += 50) {
      const url = new URL(settings.JELLYFIN_BASE_URL);
      url.pathname = url.pathname.replace(/\/$/, "") + "/Items";
      const res = await http.get(url.href, {
        headers: jellyfinAuthHeaders(settings.JELLYFIN_API_KEY),
        params: { Ids: ids.slice(i, i + 50).join(","), Fields: ITEM_FIELDS, EnableImages: false },
        timeout: TIMEOUTS.JELLYFIN_API,
      });
      items.push(...(res.data?.Items || []));
    }
    return items;
  }

  async processQueue() {
    const ids = [...this.pending.keys()];
    if (ids.length === 0) return;
    let items;
    try {
      items = await this.fetchItems(ids);
    } catch (err) {
      logger.warn(`Jellyfin feed: could not load new items, retrying: ${err.message}`);
      return this.retryLater();
    }
    const byId = new Map(items.map((item) => [item.Id, item]));

    for (const id of ids) {
      const item = byId.get(id);
      const attempts = this.pending.get(id) + 1;
      if (!item || !NOTIFY_TYPES.has(item.Type)) {
        this.pending.delete(id); // removed again, or a folder/person/etc.
        continue;
      }
      if (!hasMetadata(item) && attempts < MAX_METADATA_ATTEMPTS) {
        this.pending.set(id, attempts);
        continue;
      }
      this.pending.delete(id);
      this.remember(id);
      try {
        await this.dispatch(toWebhookPayload(item, settings.JELLYFIN_BASE_URL));
      } catch (err) {
        logger.error(`Jellyfin feed: notification for "${item.Name}" failed: ${err.message}`);
      }
    }
    this.retryLater();
  }

  retryLater() {
    if (this.pending.size > 0 && !this.queueTimer && this.running) {
      this.queueTimer = this.later(METADATA_WAIT_MS, () => {
        this.queueTimer = null;
        this.processQueue().catch((err) => logger.error(`Jellyfin feed: ${err.message}`));
      });
    }
  }

  remember(id) {
    this.recentlyDispatched.add(id);
    if (this.recentlyDispatched.size > RECENT_DISPATCH_LIMIT) {
      this.recentlyDispatched.delete(this.recentlyDispatched.values().next().value);
    }
  }

  // ----- catch-up poll -----

  async poll() {
    if (!this.running) return;
    const cursor = this.state.get(CURSOR_KEY);
    if (!cursor) {
      // First start: announce only what is added from now on, never the existing library
      this.state.set(CURSOR_KEY, new Date().toISOString());
      this.state.flush();
      logger.info("Jellyfin feed: first start, only items added from now on will be announced");
      return;
    }
    try {
      const { items, complete } = await fetchRecentlyAdded(
        settings.JELLYFIN_API_KEY,
        settings.JELLYFIN_BASE_URL,
        200,
        cursor
      );
      const cursorMs = Date.parse(cursor);
      let newest = cursorMs;
      for (const item of items) {
        const created = Date.parse(item.DateCreated);
        if (!NOTIFY_TYPES.has(item.Type) || !(created > cursorMs)) continue;
        this.enqueue(item.Id);
        newest = Math.max(newest, created);
      }
      if (complete && newest > cursorMs) {
        this.state.set(CURSOR_KEY, new Date(newest).toISOString());
        this.state.flush();
      }
    } catch (err) {
      logger.warn(`Jellyfin feed: catch-up poll failed: ${err.message}`);
    }
  }
}
