import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIdentityKey,
  buildLegacyChildIdentityKey,
} from "../jellyfin/libraryResolver.js";

test("season identity uses the parent series TMDB ID", () => {
  const key = buildIdentityKey({
    ItemType: "Season",
    Provider_tmdb: "119980",
    SeriesProvider_tmdb: "87382",
    SeriesId: "ramy-series",
    SeasonNumber: 1,
  });

  assert.equal(key, "series:tmdb:87382:s1");
});

test("season identity falls back to SeriesId instead of its season TMDB ID", () => {
  const key = buildIdentityKey({
    ItemType: "Season",
    Provider_tmdb: "119980",
    SeriesId: "ramy-series",
    SeasonNumber: 1,
  });

  assert.equal(key, "series:id:ramy-series:s1");
});

test("legacy season keys remain derivable for persisted-state migration", () => {
  const key = buildLegacyChildIdentityKey({
    ItemType: "Season",
    Provider_tmdb: "119980",
    SeriesId: "ramy-series",
    SeasonNumber: 1,
  });

  assert.equal(key, "series:tmdb:119980:s1");
});

test("library detection fetches the Jellyfin libraries once, then reuses them", async (t) => {
  const { startFakeServer } = await import("./helpers/http.js");
  const { applyConfig } = await import("./helpers/config.js");
  const { chooseLibraryChannel, libraryCache } = await import("../jellyfin/libraryDetection.js");
  const jf = await startFakeServer({
    "GET /Library/VirtualFolders": () => [{ ItemId: "lib-movies", CollectionId: "col-movies", Name: "Movies", CollectionType: "movies", Locations: ["/media/movies"] }],
  });
  t.after(() => jf.close());
  t.after(applyConfig({ JELLYFIN_BASE_URL: jf.url, JELLYFIN_API_KEY: "key", JELLYFIN_CHANNEL_ID: "chan", JELLYFIN_NOTIFICATION_LIBRARIES: { "lib-movies": "chan-movies" } }));
  libraryCache.data = null;

  for (const id of ["m1", "m2", "m3"]) {
    const { channelId } = await chooseLibraryChannel({ ItemType: "Movie", ItemId: id, Path: `/media/movies/${id}.mkv` }, false);
    assert.equal(channelId, "chan-movies");
  }
  assert.equal(jf.requests.filter((r) => r.path === "/Library/VirtualFolders").length, 1);
});
