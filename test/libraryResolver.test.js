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
