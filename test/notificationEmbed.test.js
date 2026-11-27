// Discord refuses embeds with texts over its limits, which used to make the whole post fail.
import assert from "node:assert/strict";
import test from "node:test";

import { applyConfig } from "./helpers/config.js";

const { buildItemNotification } = await import("../jellyfin/notificationEmbed.js");

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
  assert.equal(list.value.length, 1024);
});

test("short texts stay exactly as they are", (t) => {
  t.after(applyConfig({ JELLYFIN_BASE_URL: "https://jf.example.com", LANGUAGE: "en" }));
  const movie = { ItemType: "Movie", ItemId: "m2", ServerId: "srv", Name: "The Matrix", Year: 1999, Overview: "Neo wakes up.", Genres: ["Action"] };
  const json = buildItemNotification(movie, { details: null, omdb: null, imdbId: null, batch: {} }).embed.toJSON();
  assert.equal(json.title, "The Matrix (1999)");
  assert.ok(json.fields.some((f) => f.value === "Neo wakes up."));
});
