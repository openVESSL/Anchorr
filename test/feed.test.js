// Jellyfin feed: new items from the WebSocket and the catch-up poll become the payload the
// Webhook plugin used to send, only once Jellyfin has identified them.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { WebSocketServer } from "ws";

import { applyConfig } from "./helpers/config.js";
import { startFakeServer } from "./helpers/http.js";
import { JellyfinFeed, hasMetadata, ticksToHhMmSs, toWebhookPayload } from "../jellyfin/feed.js";

const MOVIE = {
  Id: "m1", Type: "Movie", ServerId: "srv", Name: "The Matrix", ProductionYear: 1999, Overview: "Neo.",
  Genres: ["Action"], RunTimeTicks: 81_600_000_000, Path: "/media/movies/The Matrix (1999)/m.mkv",
  ProviderIds: { Tmdb: "603", Imdb: "tt0133093" }, DateCreated: "2026-11-15T10:00:00.0000000Z",
};
const EPISODE = {
  Id: "e1", Type: "Episode", ServerId: "srv", Name: "Pilot", SeriesId: "s1", SeriesName: "Severance",
  SeasonId: "season1", ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 33_000_000_000, ProviderIds: {},
};

test("item -> webhook payload, in the plugin's field names and formats", () => {
  assert.equal(ticksToHhMmSs(81_600_000_000), "02:16:00");
  assert.deepEqual(toWebhookPayload(MOVIE, "http://jf"), {
    ItemType: "Movie", ItemId: "m1", ServerId: "srv", ServerUrl: "http://jf", Name: "The Matrix",
    Overview: "Neo.", Year: 1999, Genres: ["Action"], RunTime: "02:16:00",
    Path: "/media/movies/The Matrix (1999)/m.mkv", Provider_tmdb: "603", Provider_imdb: "tt0133093",
  });
  const episode = toWebhookPayload(EPISODE, "http://jf");
  assert.equal(episode.SeasonNumber, 1);
  assert.equal(episode.EpisodeNumber, 1);
  assert.equal(episode.SeriesId, "s1");
  assert.equal(episode.RunTime, "00:55:00");
  assert.equal("Provider_tmdb" in episode, false);
  const season = toWebhookPayload({ Id: "season2", Type: "Season", SeriesId: "s1", SeriesName: "Severance", IndexNumber: 2 }, "http://jf");
  assert.equal(season.SeasonId, "season2");
  assert.equal(season.SeasonNumber, 2);
});

test("an item is ready once Jellyfin identified it", () => {
  assert.equal(hasMetadata(MOVIE), true);
  assert.equal(hasMetadata({ Type: "Movie", ProviderIds: {} }), false);
  assert.equal(hasMetadata(EPISODE), true, "episodes are placed by series and number");
  assert.equal(hasMetadata({ Type: "Episode", ProviderIds: {} }), false);
});

// ----- live feed against a fake Jellyfin (HTTP + WebSocket on one port) -----

let jellyfin;
let wss;
let items = {};
let recent = [];
const sockets = [];

before(async () => {
  jellyfin = await startFakeServer({
    "GET /Items": ({ url }) => {
      const ids = url.searchParams.get("Ids");
      if (ids) return { Items: ids.split(",").map((id) => items[id]).filter(Boolean) };
      return { Items: recent, TotalRecordCount: recent.length };
    },
  });
  wss = new WebSocketServer({ server: jellyfin.server });
  wss.on("connection", (socket, req) => sockets.push({ socket, req }));
  applyConfig({ JELLYFIN_BASE_URL: jellyfin.url, JELLYFIN_API_KEY: "jf-key" });
});
after(async () => {
  wss.close();
  await jellyfin.close();
});

function memoryState(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { get: (k) => map.get(k), set: (k, v) => map.set(k, v), flush: () => true, map };
}

async function until(check, label) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("WebSocket: authenticates with a header and queues items from LibraryChanged", async (t) => {
  const dispatched = [];
  const feed = new JellyfinFeed({ dispatch: async (p) => dispatched.push(p), state: memoryState({ cursor: new Date().toISOString() }) });
  t.after(() => feed.stop());
  items = { m1: MOVIE, f1: { Id: "f1", Type: "Folder", ProviderIds: {} } };

  feed.start();
  await until(() => sockets.length === 1, "connection");
  const { socket, req } = sockets[0];
  assert.match(req.headers.authorization, /Token="jf-key"/);
  assert.doesNotMatch(req.url, /jf-key/i, "the key never goes in the URL");

  socket.send(JSON.stringify({ MessageType: "LibraryChanged", Data: { ItemsAdded: ["m1", "f1"] } }));
  await until(() => feed.pending.size === 2, "queued items");

  await feed.processQueue();
  assert.equal(feed.pending.size, 0, "folders are dropped, the movie is sent");
  assert.deepEqual(dispatched.map((p) => [p.ItemType, p.ItemId, p.Provider_tmdb]), [["Movie", "m1", "603"]]);

  // the same item reported again (e.g. by the catch-up poll) is not sent twice
  feed.enqueue("m1");
  assert.equal(feed.pending.size, 0);
});

test("items without metadata wait, then go out anyway after a few tries", async (t) => {
  const dispatched = [];
  const feed = new JellyfinFeed({ dispatch: async (p) => dispatched.push(p), state: memoryState() });
  t.after(() => feed.stop());
  items = { m2: { ...MOVIE, Id: "m2", ProviderIds: {} } };

  feed.enqueue("m2");
  for (let i = 0; i < 3; i++) await feed.processQueue();
  assert.equal(dispatched.length, 0, "still waiting for Jellyfin to identify it");
  await feed.processQueue();
  assert.equal(dispatched.length, 1);
});

test("catch-up poll: first start announces nothing old, later polls send only newer items at once", async (t) => {
  const state = memoryState();
  const dispatched = [];
  const feed = new JellyfinFeed({ dispatch: async (p) => dispatched.push(p.ItemId), state });
  t.after(() => feed.stop());
  feed.running = true; // poll without opening a socket

  recent = [MOVIE];
  await feed.poll();
  assert.ok(state.get("cursor"), "cursor stamped on first start");
  assert.equal(feed.pending.size, 0);

  state.set("cursor", "2026-11-15T09:00:00.000Z");
  recent = [MOVIE, { ...MOVIE, Id: "old", DateCreated: "2026-11-15T08:00:00.0000000Z" }];
  items = { m1: MOVIE };
  await feed.poll();
  assert.deepEqual(dispatched, ["m1"], "identified items do not wait for the queue timer");
  assert.equal(feed.pending.size, 0);
  assert.equal(state.get("cursor"), "2026-11-15T10:00:00.000Z");
});

test("stop closes the connection and does not reconnect", async (t) => {
  const feed = new JellyfinFeed({ dispatch: async () => {}, state: memoryState({ cursor: new Date().toISOString() }) });
  const before = sockets.length;
  feed.start();
  await until(() => sockets.length === before + 1, "connection");
  feed.stop();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(sockets.length, before + 1);
  assert.equal(feed.ws, null);
  t.after(() => feed.stop());
});
