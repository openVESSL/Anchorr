// Parity net for Jellyfin -> Discord notifications. Input is the webhook-shaped item payload
// (v2 builds the same shape from the Jellyfin API), output is what Discord would receive.
// Runtime/rating/director come from Seerr metadata. Most tests run without Seerr, so those
// fields show their fallback values; the "with Seerr" tests use a fake Seerr.
import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { applyConfig } from "./helpers/config.js";
import { createFakeDiscord } from "./helpers/discord.js";
import { startFakeServer } from "./helpers/http.js";

// Fake timers before the module loads: its import-time intervals must not keep the process alive.
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
const { handleJellyfinItem } = await import("../jellyfin/itemHandler.js");
const { sentNotifications } = await import("../jellyfin/dedup.js");

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
  SEERR_URL: undefined,
  SEERR_API_KEY: undefined,
};

function configure(t, values = {}) {
  t.after(applyConfig({ ...BASE, ...values }));
}

const send = (body, discord, pending = new Map(), onChange = () => {}) =>
  handleJellyfinItem(body, discord.client, pending, onChange);

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

const show = (series, extra = {}) => ({
  ItemType: "Series",
  ItemId: series,
  Name: "Show",
  Year: 2021,
  Provider_tmdb: `tmdb-${series}`,
  ...extra,
});
const season = (series, n, extra = {}) => ({
  ItemType: "Season",
  ItemId: `${series}-s${n}`,
  SeriesId: series,
  SeriesName: "Show",
  Name: `Season ${n}`,
  SeasonNumber: n,
  IndexNumber: n,
  SeriesProvider_tmdb: `tmdb-${series}`,
  ...extra,
});

test("a new show is one post: its episodes join it and are not announced later", async (t) => {
  configure(t, { JELLYFIN_NOTIFY_EPISODES: "true" });
  const discord = createFakeDiscord();
  await send(episode("show-a", 1), discord);
  await send(show("show-a"), discord);
  await send(episode("show-a", 2), discord);
  mock.timers.tick(130_000);
  await flush();
  assert.equal(discord.sent.length, 1);
  assert.equal(discord.sent[0].embeds[0].author.name, "📺 New TV show added!");

  await send(episode("show-a", 3), discord); // covered by the show post
  await send(episode("show-a", 1), discord); // already announced
  mock.timers.tick(130_000);
  await flush();
  assert.equal(discord.sent.length, 1);
});

test("a test movie is posted every time and never remembered", async (t) => {
  configure(t);
  const discord = createFakeDiscord();
  await send(movie("test-1"), discord);
  await send(movie("test-1"), discord);
  assert.equal(discord.sent.length, 2);
  assert.equal(sentNotifications.has("test:test-1"), false);
});

test("a large import posts once when the batch flushes early, with no repeat afterwards", async (t) => {
  configure(t, { JELLYFIN_NOTIFY_EPISODES: "true", JELLYFIN_NOTIFY_SEASONS: "true" });
  const discord = createFakeDiscord();
  for (let n = 1; n <= 11; n++) await send(season("show-seasons", n), discord);
  await flush();
  assert.equal(discord.sent.length, 1, "posted as soon as it passed 10 seasons");
  mock.timers.tick(130_000);
  await flush();
  assert.equal(discord.sent.length, 1, "no trailing post repeating the seasons");

  for (let n = 1; n <= 31; n++) await send(episode("show-big", n), discord);
  await flush();
  assert.equal(discord.sent.length, 2, "posted as soon as it passed 30 episodes");
  mock.timers.tick(130_000);
  await flush();
  assert.equal(discord.sent.length, 2);
  assert.equal(discord.edits.length, 0, "the post is not rewritten by a smaller trailing batch");
});

test("a season right after its show's post is skipped, a later one is announced", async (t) => {
  configure(t, { JELLYFIN_NOTIFY_SEASONS: "true" });
  const discord = createFakeDiscord();
  await send(show("show-b"), discord);
  mock.timers.tick(70_000);
  await flush();
  assert.equal(discord.sent.length, 1);

  await send(season("show-b", 1), discord);
  mock.timers.tick(70_000);
  await flush();
  assert.equal(discord.sent.length, 1, "within 3 minutes of the show post");

  mock.timers.tick(3 * 60_000);
  await send(season("show-b", 2), discord);
  mock.timers.tick(70_000);
  await flush();
  assert.equal(discord.sent.length, 2);
  assert.equal(discord.sent[1].embeds[0].author.name, "📺 New season added!");
  assert.equal(discord.sent[1].embeds[0].title, "Show - Season 2");
});

test("the same episode twice in one batch counts once", async (t) => {
  configure(t, { JELLYFIN_NOTIFY_EPISODES: "true" });
  const discord = createFakeDiscord();
  await send(episode("show-c", 4), discord);
  await send(episode("show-c", 4), discord);
  mock.timers.tick(130_000);
  await flush();
  assert.equal(discord.sent.length, 1);
  assert.equal(discord.sent[0].embeds[0].author.name, "📺 New episode added!");
});

test("a failed batch post does not block the series afterwards", async (t) => {
  configure(t, { JELLYFIN_NOTIFY_EPISODES: "true", JELLYFIN_EPISODE_CHANNEL_ID: "chan-gone" });
  const discord = createFakeDiscord({ missingChannels: ["chan-gone"] });
  await send(episode("show-d", 1), discord);
  mock.timers.tick(130_000);
  await flush();
  assert.equal(discord.sent.length, 0);

  t.after(applyConfig({ JELLYFIN_EPISODE_CHANNEL_ID: "chan-ep" }));
  await send(episode("show-d", 1), discord);
  mock.timers.tick(130_000);
  await flush();
  assert.equal(discord.sent.length, 1);
  assert.equal(discord.sent[0].channelId, "chan-ep");
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

test("with Seerr: movie shows runtime, IMDb rating and director like v1 with TMDB/OMDb keys", async (t) => {
  const seerr = await startFakeServer({
    "GET /api/v1/movie/9001": () => ({
      id: 9001, title: "The Matrix", runtime: 136, genres: [{ name: "Action" }], voteAverage: 8.2,
      externalIds: { imdbId: "tt0133093" },
      credits: { crew: [{ job: "Director", department: "Directing", name: "Lana Wachowski" }] },
    }),
    "GET /api/v1/movie/9001/ratingscombined": () => ({ imdb: { criticsScore: 8.7 } }),
  });
  t.after(() => seerr.close());
  configure(t, { SEERR_URL: seerr.url, SEERR_API_KEY: "seerr-key" });

  const discord = createFakeDiscord();
  await send(movie("movie-seerr", { Provider_tmdb: "9001" }), discord);

  assert.deepEqual(
    discord.sent[0].embeds[0].fields.map((f) => [f.name, f.value]),
    [
      ["Directed by Lana Wachowski", "A hacker learns the truth."],
      ["Genre", "Action, Sci-Fi"],
      ["Runtime", "2h 16m"],
      ["Rating", "8.7/10"],
    ]
  );
});

test("with Seerr: a new show gets its creator, the TMDB score as rating and Jellyfin's runtime", async (t) => {
  const seerr = await startFakeServer({
    "GET /api/v1/tv/9002": () => ({
      id: 9002, name: "Severance", episodeRunTime: [], // Seerr often has no runtime for shows
      genres: [{ name: "Drama" }], voteAverage: 8.37, externalIds: { imdbId: "tt11280740" },
      createdBy: [{ name: "Dan Erickson" }],
    }),
  });
  t.after(() => seerr.close());
  configure(t, { SEERR_URL: seerr.url, SEERR_API_KEY: "seerr-key" });

  const discord = createFakeDiscord();
  await send(
    { ItemType: "Series", ItemId: "series-seerr", ServerId: "srv1", Name: "Severance", Year: 2022, Overview: "Work and life, split.", Provider_tmdb: "9002", RunTime: "00:55:00" },
    discord
  );
  mock.timers.tick(70_000);
  await flush();

  assert.equal(discord.sent.length, 1);
  assert.equal(discord.sent[0].embeds[0].author.name, "📺 New TV show added!");
  assert.deepEqual(
    discord.sent[0].embeds[0].fields.map((f) => [f.name, f.value]),
    [
      ["Created by Dan Erickson", "Work and life, split."],
      ["Genre", "Drama"],
      ["Runtime", "55m"],
      ["Rating", "8.4/10"],
    ]
  );
});

test("without Seerr, a movie still shows Jellyfin's runtime", async (t) => {
  configure(t);
  const discord = createFakeDiscord();
  await send(movie("movie-runtime", { RunTime: "02:16:00" }), discord);
  assert.equal(discord.sent[0].embeds[0].fields.find((f) => f.name === "Runtime").value, "2h 16m");
});
