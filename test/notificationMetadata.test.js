import assert from "node:assert/strict";
import test from "node:test";

import {
  getBackdropItemId,
  getNotificationTmdbId,
  resolveSeriesProviderIds,
} from "../jellyfin/notificationMetadata.js";

const ramySeason = {
  ItemType: "Season",
  ItemId: "season-1",
  SeriesId: "ramy-series",
  Name: "Season 1",
  Provider_tmdb: "119980",
};

test("season TMDB IDs are never treated as TV-series IDs", () => {
  assert.equal(getNotificationTmdbId(ramySeason), null);
  assert.equal(
    getNotificationTmdbId({
      ...ramySeason,
      SeriesProvider_tmdb: "87382",
    }),
    "87382"
  );
});

test("season and episode backdrops fall back to the parent series", () => {
  assert.equal(getBackdropItemId(ramySeason), "ramy-series");
  assert.equal(
    getBackdropItemId({
      ItemType: "Episode",
      ItemId: "episode-1",
      SeriesId: "ramy-series",
    }),
    "ramy-series"
  );
});

test("missing series provider IDs are resolved through Jellyfin", async () => {
  let request;
  const httpClient = {
    async get(url, options) {
      request = { url, options };
      return {
        data: {
          Items: [{ ProviderIds: { Tmdb: "87382", Imdb: "tt7649694" } }],
        },
      };
    },
  };

  const providerIds = await resolveSeriesProviderIds(ramySeason, {
    apiKey: "test-api-key",
    baseUrl: "https://jellyfin.example/jellyfin",
    httpClient,
  });

  assert.deepEqual(providerIds, { Tmdb: "87382", Imdb: "tt7649694" });
  assert.equal(request.url, "https://jellyfin.example/jellyfin/Items");
  assert.equal(request.options.params.Ids, "ramy-series");
});
