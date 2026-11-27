// Discord refuses embeds with texts over its limits, which used to make the whole post fail.
import assert from "node:assert/strict";
import test from "node:test";

import { applyConfig } from "./helpers/config.js";

const { buildAvailableDm, buildItemNotification } = await import("../jellyfin/notificationEmbed.js");

test("long overviews, titles and episode lists are cut to Discord's limits", (t) => {
  t.after(applyConfig({ JELLYFIN_BASE_URL: "https://jf.example.com", LANGUAGE: "en" }));

  const movie = { ItemType: "Movie", ItemId: "m1", ServerId: "srv", Name: "M".repeat(300), Year: 1999, Overview: "a".repeat(1500), Genres: ["g".repeat(1100)] };
  const { embed, title } = buildItemNotification(movie, { details: null, omdb: null, imdbId: null, batch: {} });
  const json = embed.toJSON();
  const fieldValues = json.fields.map((f) => f.value);

  assert.equal(json.title.length, 256);
  assert.ok(json.title.endsWith("…"));
  assert.equal(title, json.title, "the available DM reuses the cut title");
  assert.ok(fieldValues.every((v) => v.length <= 1024), "no field over 1024 characters");
  assert.ok(fieldValues.some((v) => v.length === 1024 && v.endsWith("…")), "the overview is cut, not dropped");

  const episodes = Array.from({ length: 10 }, (_, i) => ({ SeasonNumber: 1, EpisodeNumber: i + 1, Name: "e".repeat(200) }));
  const batch = { episodeCount: 10, episodeDetails: { episodes } };
  const show = { ItemType: "Episode", ItemId: "e1", ServerId: "srv", SeriesId: "s1", SeriesName: "Show", Year: 2020 };
  const list = buildItemNotification(show, { details: null, omdb: null, imdbId: null, batch }).embed.toJSON().fields.at(-1);
  assert.ok(list.value.length <= 1024);
  const lines = list.value.split("\n");
  const hidden = 10 - (lines.length - 1);
  assert.equal(lines.at(-1), `…and ${hidden} more`, "the list says how many episodes it leaves out");
  assert.ok(lines.slice(0, -1).every((line) => line.endsWith("e".repeat(200))), "only whole lines are listed");
});

test("a long director list is cut in the field name instead of failing the post", (t) => {
  t.after(applyConfig({ JELLYFIN_BASE_URL: "https://jf.example.com", LANGUAGE: "en" }));
  const directors = Array.from({ length: 26 }, (_, i) => `Director Number ${i + 1}`).join(", ");
  const movie = { ItemType: "Movie", ItemId: "m3", ServerId: "srv", Name: "The ABCs of Death", Year: 2012, Overview: "x", Genres: ["Horror"] };
  const json = buildItemNotification(movie, { details: null, omdb: { Director: directors }, imdbId: null, batch: {} }).embed.toJSON();
  const heading = json.fields[0].name;
  assert.equal(heading.length, 256);
  assert.ok(heading.startsWith("Directed by Director Number 1,"));
});

test("an emoji at the cut is never split in half", (t) => {
  t.after(applyConfig({ JELLYFIN_BASE_URL: "https://jf.example.com", LANGUAGE: "en" }));
  const overview = "a".repeat(1022) + "😀" + "b".repeat(10);
  const movie = { ItemType: "Movie", ItemId: "m4", ServerId: "srv", Name: "Smile", Year: 2022, Overview: overview, Genres: ["Horror"] };
  const value = buildItemNotification(movie, { details: null, omdb: null, imdbId: null, batch: {} }).embed.toJSON().fields[0].value;
  assert.ok(value.isWellFormed(), "no lone half of a surrogate pair");
  assert.equal(value, "a".repeat(1022) + "…");
});

test("a single huge episode name is cut, so the list still names the first episode", (t) => {
  t.after(applyConfig({ JELLYFIN_BASE_URL: "https://jf.example.com", LANGUAGE: "en" }));
  const episodes = [
    { SeasonNumber: 1, EpisodeNumber: 1, Name: "x".repeat(2000) },
    { SeasonNumber: 1, EpisodeNumber: 2, Name: "Second" },
  ];
  const show = { ItemType: "Episode", ItemId: "e2", ServerId: "srv", SeriesId: "s2", SeriesName: "Show", Year: 2020 };
  const batch = { episodeCount: 2, episodeDetails: { episodes } };
  const list = buildItemNotification(show, { details: null, omdb: null, imdbId: null, batch }).embed.toJSON().fields.at(-1);
  const [first, more] = list.value.split("\n");
  assert.ok(list.value.length <= 1024);
  assert.ok(first.startsWith("**S01E01**: xxx") && first.endsWith("…"));
  assert.equal(more, "…and 1 more");
});

test("season lists and the available DM stay within Discord's limits", (t) => {
  t.after(applyConfig({ JELLYFIN_BASE_URL: "https://jf.example.com", LANGUAGE: "en" }));
  const seasons = Array.from({ length: 10 }, (_, i) => ({ SeasonNumber: i + 1, Name: "s".repeat(300) }));
  const show = { ItemType: "Season", ItemId: "se1", ServerId: "srv", SeriesId: "s3", SeriesName: "Show", Year: 2020, Name: "n".repeat(5000) };
  const post = buildItemNotification(show, { details: null, omdb: null, imdbId: null, batch: { seasonCount: 10, seasonDetails: { seasons } } });
  const list = post.embed.toJSON().fields.at(-1);
  assert.ok(list.value.length <= 1024);
  assert.match(list.value.split("\n").at(-1), /^…and \d+ more$/);

  const dm = buildAvailableDm(show, post).embeds[0].toJSON();
  assert.equal(dm.description.length, 4096);
  assert.ok(dm.description.endsWith("…"));
});

test("short texts stay exactly as they are", (t) => {
  t.after(applyConfig({ JELLYFIN_BASE_URL: "https://jf.example.com", LANGUAGE: "en" }));
  const movie = { ItemType: "Movie", ItemId: "m2", ServerId: "srv", Name: "The Matrix", Year: 1999, Overview: "Neo wakes up.", Genres: ["Action"] };
  const json = buildItemNotification(movie, { details: null, omdb: null, imdbId: null, batch: {} }).embed.toJSON();
  assert.equal(json.title, "The Matrix (1999)");
  assert.ok(json.fields.some((f) => f.value === "Neo wakes up."));
});
