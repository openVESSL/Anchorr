// Parity net for the Daily Random Pick post. Titles come from a fake Seerr; Math.random is
// pinned so the "trending" strategy and its first title are always picked.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { applyConfig } from "./helpers/config.js";
import { createFakeDiscord } from "./helpers/discord.js";
import { startFakeServer } from "./helpers/http.js";

const { scheduleDailyRandomPick, sendDailyRandomPick } = await import("../bot/dailyPick.js");
const { default: logger } = await import("../utils/logger.js");
const { default: cache } = await import("../utils/cache.js");

let trending = [];
let seerr;
before(async () => {
  seerr = await startFakeServer({
    "GET /api/v1/discover/trending": () => ({ results: trending }),
    "GET /api/v1/movie/603": () => ({
      id: 603, title: "The Matrix", genres: [{ name: "Action" }, { name: "Sci-Fi" }], externalIds: { imdbId: "tt0133093" },
    }),
    "GET /api/v1/tv/1399": () => ({ id: 1399, name: "Game of Thrones", genres: [], externalIds: {} }),
  });
});
after(() => seerr.close());

function configure(t, values = {}) {
  t.mock.method(Math, "random", () => 0);
  cache.clearAll(); // trending is cached between calls
  t.after(applyConfig({ SEERR_URL: seerr.url, SEERR_API_KEY: "seerr-key", DAILY_RANDOM_PICK_CHANNEL_ID: "chan-pick", ...values }));
}

test("movie pick: embed, rating, genres, backdrop and Letterboxd/IMDb/Request buttons", async (t) => {
  configure(t);
  trending = [{
    id: 603, mediaType: "movie", title: "The Matrix", releaseDate: "1999-03-31",
    overview: "Neo wakes up.", voteAverage: 8.217, backdropPath: "/matrix.jpg",
  }];
  const discord = createFakeDiscord();
  await sendDailyRandomPick(discord.client);

  assert.equal(discord.sent.length, 1);
  const [post] = discord.sent;
  assert.equal(post.channelId, "chan-pick");
  const [embed] = post.embeds;
  assert.equal(embed.author.name, "🎬 Today's Random Pick");
  assert.equal(embed.title, "The Matrix (1999)");
  assert.equal(embed.description, "Neo wakes up.");
  assert.equal(embed.color, 0xf5a962);
  assert.deepEqual(embed.fields.map((f) => [f.name, f.value]), [["Rating", "⭐ 8.2/10"], ["Genres", "Action, Sci-Fi"]]);
  assert.equal(embed.image.url, "https://image.tmdb.org/t/p/w1280/matrix.jpg");
  assert.deepEqual(
    post.components[0].components.map((b) => [b.label, b.url ?? b.custom_id]),
    [
      ["Letterboxd", "https://letterboxd.com/search/The%20Matrix/"],
      ["IMDb", "https://www.imdb.com/title/tt0133093/"],
      ["Request", "request_random_603_movie"],
    ]
  );
});

test("TV pick: no Letterboxd button, long overview is cut to 300 characters", async (t) => {
  configure(t);
  trending = [{ id: 1399, mediaType: "tv", name: "Game of Thrones", firstAirDate: "2011-04-17", overview: "x".repeat(400) }];
  const discord = createFakeDiscord();
  await sendDailyRandomPick(discord.client);

  const [post] = discord.sent;
  assert.equal(post.embeds[0].author.name, "📺 Today's Random Pick");
  assert.equal(post.embeds[0].description, `${"x".repeat(297)}...`);
  assert.deepEqual(post.embeds[0].fields.map((f) => [f.name, f.value]), [["Rating", "N/A"]]);
  assert.deepEqual(post.components[0].components.map((b) => b.label), ["Request"]);
});

test("nothing is posted without a channel, without Seerr, or when no title is found", async (t) => {
  const discord = createFakeDiscord();
  trending = [{ id: 603, mediaType: "movie", title: "The Matrix" }];

  configure(t, { DAILY_RANDOM_PICK_CHANNEL_ID: undefined });
  await sendDailyRandomPick(discord.client);

  t.after(applyConfig({ DAILY_RANDOM_PICK_CHANNEL_ID: "chan-pick", SEERR_API_KEY: undefined }));
  await sendDailyRandomPick(discord.client);

  t.after(applyConfig({ SEERR_API_KEY: "seerr-key" }));
  trending = [];
  await sendDailyRandomPick(discord.client);

  assert.equal(discord.sent.length, 0);
});

test("an interval a timer cannot hold is refused instead of firing every millisecond", (t) => {
  const discord = createFakeDiscord();
  const timers = t.mock.method(globalThis, "setInterval");
  const warnings = t.mock.method(logger, "warn", () => {});

  // about a month, not a number, and zero
  for (const interval of ["43200", "abc", "0", "1e3", "1.5"]) {
    configure(t, { DAILY_RANDOM_PICK_ENABLED: "true", DAILY_RANDOM_PICK_INTERVAL: interval });
    scheduleDailyRandomPick(discord.client);
  }

  assert.equal(timers.mock.callCount(), 0, "no timer is started");
  assert.equal(warnings.mock.calls.filter((c) => /between 1 and/.test(c.arguments[0])).length, 5);
  assert.equal(discord.sent.length, 0, "nothing is posted");
});

test("the longest allowed interval still schedules the pick", (t) => {
  const discord = createFakeDiscord();
  const timers = t.mock.method(globalThis, "setInterval", () => 1);
  t.mock.method(globalThis, "clearInterval", () => {});

  configure(t, { DAILY_RANDOM_PICK_ENABLED: "true", DAILY_RANDOM_PICK_INTERVAL: "35790" });
  scheduleDailyRandomPick(discord.client);

  assert.equal(timers.mock.callCount(), 1);
  assert.equal(timers.mock.calls[0].arguments[1], 35790 * 60000);
});
