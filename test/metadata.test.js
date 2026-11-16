// Metadata follows the bot language, and a language change does not serve cached results
// in the previous language.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { applyConfig } from "./helpers/config.js";
import { startFakeServer } from "./helpers/http.js";

const { searchTitles } = await import("../api/metadata.js");
const { default: cache } = await import("../utils/cache.js");

let seerr;
before(async () => {
  seerr = await startFakeServer({
    "GET /api/v1/search": ({ url }) => ({
      results: [{ id: 1, mediaType: "movie", title: url.searchParams.get("language") === "de" ? "Der Pate" : "The Godfather" }],
    }),
  });
});
after(() => seerr.close());

test("search uses the bot language and caches per language", async (t) => {
  cache.clearAll();
  const restore = applyConfig({ SEERR_URL: seerr.url, SEERR_API_KEY: "k", LANGUAGE: "de" });
  assert.equal((await searchTitles("godfather"))[0].title, "Der Pate");
  restore();
  t.after(applyConfig({ SEERR_URL: seerr.url, SEERR_API_KEY: "k", LANGUAGE: "en" }));
  assert.equal((await searchTitles("godfather"))[0].title, "The Godfather");
  assert.deepEqual(seerr.requests.map((r) => r.query.get("language")), ["de", "en"]);
});
