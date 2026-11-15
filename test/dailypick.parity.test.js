// Parity net for the Daily Random Pick post. The random title source (TMDB in v1) is mocked;
// v2 swaps it for Seerr discover data with the same fields.
import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { applyConfig } from "./helpers/config.js";
import { createFakeDiscord } from "./helpers/discord.js";

const realTmdb = await import("../api/tmdb.js");
let nextPick = null;
mock.module("../api/tmdb.js", {
  namedExports: { ...realTmdb, tmdbGetRandomMedia: async () => nextPick },
});
const { sendDailyRandomPick } = await import("../bot/dailyPick.js");

function configure(t, values = {}) {
  t.after(applyConfig({ TMDB_API_KEY: "tmdb-key", DAILY_RANDOM_PICK_CHANNEL_ID: "chan-pick", ...values }));
}

test("movie pick: embed, rating, genres, backdrop and Letterboxd/IMDb/Request buttons", async (t) => {
  configure(t);
  nextPick = {
    id: 603,
    media_type: "movie",
    title: "The Matrix",
    release_date: "1999-03-31",
    overview: "Neo wakes up.",
    vote_average: 8.217,
    backdrop_path: "/matrix.jpg",
    details: { genres: [{ name: "Action" }, { name: "Sci-Fi" }], external_ids: { imdb_id: "tt0133093" } },
  };
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
  nextPick = { id: 1399, media_type: "tv", name: "Game of Thrones", first_air_date: "2011-04-17", overview: "x".repeat(400) };
  const discord = createFakeDiscord();
  await sendDailyRandomPick(discord.client);

  const [post] = discord.sent;
  assert.equal(post.embeds[0].author.name, "📺 Today's Random Pick");
  assert.equal(post.embeds[0].description, `${"x".repeat(297)}...`);
  assert.deepEqual(post.embeds[0].fields.map((f) => [f.name, f.value]), [["Rating", "N/A"]]);
  assert.deepEqual(post.components[0].components.map((b) => b.label), ["Request"]);
});

test("nothing is posted without a channel or when no title is found", async (t) => {
  configure(t, { DAILY_RANDOM_PICK_CHANNEL_ID: undefined });
  nextPick = { id: 1, media_type: "movie", title: "X" };
  const discord = createFakeDiscord();
  await sendDailyRandomPick(discord.client);

  applyConfig({ DAILY_RANDOM_PICK_CHANNEL_ID: "chan-pick" });
  nextPick = null;
  await sendDailyRandomPick(discord.client);
  assert.equal(discord.sent.length, 0);
});
