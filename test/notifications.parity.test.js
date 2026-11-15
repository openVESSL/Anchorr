// Parity net for Jellyfin -> Discord notifications. Input is the webhook-shaped item payload
// (v2 builds the same shape from the Jellyfin API), output is what Discord would receive.
// Runtime/rating/director come from external metadata, which is blocked here: those fields
// show their fallback values on purpose.
import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { applyConfig } from "./helpers/config.js";
import { createFakeDiscord } from "./helpers/discord.js";

// Fake timers before the module loads: its import-time intervals must not keep the process alive.
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
const { handleJellyfinWebhook } = await import("../jellyfinWebhook.js");

const MAUVE = 0xcba6f7;
const BLUE = 0x89b4fa;
const GREEN = 0xa6e3a1;

const BASE = {
  LANGUAGE: "en",
  JELLYFIN_CHANNEL_ID: "chan-default",
  JELLYFIN_BASE_URL: "https://jf.example.com",
  JELLYFIN_API_KEY: "test-key",
  JELLYFIN_NOTIFICATION_LIBRARIES: undefined,
  JELLYFIN_NOTIFY_MOVIES: undefined,
  JELLYFIN_NOTIFY_SERIES: undefined,
  JELLYFIN_NOTIFY_EPISODES: undefined,
  JELLYFIN_EPISODE_CHANNEL_ID: undefined,
  NOTIFY_ON_AVAILABLE: undefined,
};

function configure(t, values = {}) {
  t.after(applyConfig({ ...BASE, ...values }));
}

const send = (body, discord, pending = new Map(), onChange = () => {}) =>
  handleJellyfinWebhook({ body }, null, discord.client, pending, onChange);

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

// Dedup keys on the TMDB id, so every movie gets its own unless a test shares one on purpose.
let nextTmdb = 1000;
const movie = (id, extra = {}) => ({
  ItemType: "Movie",
  ItemId: id,
  ServerId: "srv1",
  Name: "The Matrix",
  Year: 1999,
  Overview: "A hacker learns the truth.",
  Genres: "Action, Sci-Fi",
  Provider_tmdb: String(nextTmdb++),
  Provider_imdb: "tt0133093",
  ...extra,
});

const episode = (series, n, extra = {}) => ({
  ItemType: "Episode",
  ItemId: `${series}-ep${n}`,
  SeriesId: series,
  SeriesName: "Show",
  Name: `Ep ${n}`,
  SeasonNumber: 1,
  EpisodeNumber: n,
  Year: 2021,
  RunTime: "00:42:00",
  SeriesProvider_tmdb: `tmdb-${series}`,
  ...extra,
});

test("movie: posts the full embed with link buttons to the default channel", async (t) => {
  configure(t);
  const discord = createFakeDiscord();
  await send(movie("movie-full"), discord);

  assert.equal(discord.sent.length, 1);
  const [post] = discord.sent;
  assert.equal(post.channelId, "chan-default");

  const [embed] = post.embeds;
  const watchUrl = "https://jf.example.com/web/index.html#!/details?id=movie-full&serverId=srv1";
  assert.equal(embed.author.name, "🎬 New movie added!");
  assert.equal(embed.title, "The Matrix (1999)");
  assert.equal(embed.url, watchUrl);
  assert.equal(embed.color, MAUVE);
  assert.deepEqual(
    embed.fields.map((f) => [f.name, f.value]),
    [
      ["Summary", "A hacker learns the truth."],
      ["Genre", "Action, Sci-Fi"],
      ["Runtime", "Unknown"],
      ["Rating", "N/A"],
    ]
  );
  assert.equal(embed.image.url, "https://jf.example.com/Items/movie-full/Images/Backdrop");

  assert.deepEqual(
    post.components[0].components.map((b) => [b.label, b.url]),
    [
      ["Letterboxd", "https://letterboxd.com/imdb/tt0133093"],
      ["IMDb", "https://www.imdb.com/title/tt0133093/"],
      ["▶ Watch Now!", watchUrl],
    ]
  );
});

test("movie: the same item is announced only once", async (t) => {
  configure(t);
  const discord = createFakeDiscord();
  const item = movie("movie-dedup");
  await send(item, discord);
  await send({ ...item }, discord);
  assert.equal(discord.sent.length, 1);
});

test("movie: a new file of an announced movie (same TMDB id) is not re-announced", async (t) => {
  configure(t);
  const discord = createFakeDiscord();
  await send(movie("movie-1080p", { Provider_tmdb: "777" }), discord);
  await send(movie("movie-2160p", { Provider_tmdb: "777" }), discord);
  assert.equal(discord.sent.length, 1);
});

test("available DM goes to the requester and clears the pending request", async (t) => {
  configure(t, { NOTIFY_ON_AVAILABLE: "true" });
  const discord = createFakeDiscord();
  const pending = new Map([["4242-movie", new Set(["user-1"])]]);
  let changed = 0;
  await send(movie("movie-dm", { Provider_tmdb: "4242" }), discord, pending, () => changed++);

  assert.equal(discord.dms.length, 1);
  const [dm] = discord.dms;
  assert.equal(dm.userId, "user-1");
  assert.equal(dm.embeds[0].author.name, "✅ Your request is now available!");
  assert.equal(dm.embeds[0].description, "The Matrix is now available on Jellyfin!");
  assert.equal(dm.embeds[0].color, GREEN);
  assert.deepEqual(dm.components[0].components.map((b) => b.label), ["▶ Watch Now!"]);
  assert.equal(pending.has("4242-movie"), false);
  assert.equal(changed, 1);
});

test("available DM is sent even when movie channel announcements are off", async (t) => {
  configure(t, { NOTIFY_ON_AVAILABLE: "true", JELLYFIN_NOTIFY_MOVIES: "false" });
  const discord = createFakeDiscord();
  const pending = new Map([["4343-movie", new Set(["user-2"])]]);
  await send(movie("movie-dm-only", { Provider_tmdb: "4343" }), discord, pending);

  assert.equal(discord.sent.length, 0);
  assert.deepEqual(discord.dms.map((d) => d.userId), ["user-2"]);
});

test("library mapping routes to the library channel and skips unmapped libraries", async (t) => {
  configure(t, {
    JELLYFIN_NOTIFICATION_LIBRARIES: { "lib-movies": { channel: "chan-lib", isAnime: false } },
  });
  const discord = createFakeDiscord();
  await send(movie("movie-lib", { LibraryId: "lib-movies" }), discord);
  await send(movie("movie-unmapped", { LibraryId: "lib-other", Name: "Other" }), discord);

  assert.deepEqual(discord.sent.map((s) => s.channelId), ["chan-lib"]);
});

test("a Jellyfin URL Discord cannot open drops the link and the Watch button only", async (t) => {
  // Discord rejects dotless hosts (Docker service names, localhost); LAN IPs pass the check.
  configure(t, { JELLYFIN_BASE_URL: "http://jellyfin:8096" });
  const discord = createFakeDiscord();
  await send(movie("movie-lan"), discord);

  const [post] = discord.sent;
  assert.equal(post.embeds[0].url, undefined);
  assert.deepEqual(post.components[0].components.map((b) => b.label), ["Letterboxd", "IMDb"]);
});

test("episodes of one series are batched into a single post after the debounce", async (t) => {
  configure(t, { JELLYFIN_NOTIFY_EPISODES: "true", JELLYFIN_EPISODE_CHANNEL_ID: "chan-ep" });
  const discord = createFakeDiscord();
  for (const n of [1, 2, 3]) await send(episode("series-batch", n), discord);
  assert.equal(discord.sent.length, 0, "nothing is posted while the debounce is pending");

  mock.timers.tick(130_000); // new series: 120s debounce
  await flush();

  assert.equal(discord.sent.length, 1);
  const [post] = discord.sent;
  const [embed] = post.embeds;
  assert.equal(post.channelId, "chan-ep");
  assert.equal(embed.author.name, "📺 3 new episodes added!");
  assert.equal(embed.title, "Show (2021)");
  assert.equal(embed.color, BLUE);
  const runtime = embed.fields.find((f) => f.name === "Runtime");
  assert.equal(runtime.value, "00:42:00");
  const list = embed.fields.find((f) => f.name === "Episodes Added");
  assert.equal(list.value, "**S01E01**: Ep 1\n**S01E02**: Ep 2\n**S01E03**: Ep 3");
});

test("episodes are not announced when episode notifications are off", async (t) => {
  configure(t, { JELLYFIN_NOTIFY_EPISODES: "false" });
  const discord = createFakeDiscord();
  await send(episode("series-off", 1), discord);
  mock.timers.tick(130_000);
  await flush();
  assert.equal(discord.sent.length, 0);
});

test("a single episode uses the SxxEyy title", async (t) => {
  configure(t, { JELLYFIN_NOTIFY_EPISODES: "true" });
  const discord = createFakeDiscord();
  await send(episode("series-single", 7, { SeasonNumber: 2 }), discord);
  mock.timers.tick(130_000);
  await flush();

  assert.equal(discord.sent.length, 1);
  assert.equal(discord.sent[0].channelId, "chan-default");
  assert.equal(discord.sent[0].embeds[0].author.name, "📺 New episode added!");
  assert.equal(discord.sent[0].embeds[0].title, "Show - S02E07");
});

test("an unreachable channel does not throw out of the handler", async (t) => {
  configure(t, { JELLYFIN_CHANNEL_ID: "chan-gone" });
  const discord = createFakeDiscord({ missingChannels: ["chan-gone"] });
  await send(movie("movie-gone"), discord);
  assert.equal(discord.sent.length, 0);
});
