// Moka mode: Moka pairs with Anchorr, the bot requests in Moka as the Discord member's
// Moka user, and Moka's "available" events become the usual announcements and DMs.
import assert from "node:assert/strict";
import test, { after, before, mock } from "node:test";

import { applyConfig } from "./helpers/config.js";
import { startApp } from "./helpers/app.js";
import { createFakeDiscord } from "./helpers/discord.js";
import { startFakeServer } from "./helpers/http.js";

const KEY = "moka-bot-key";
const ACT_AS_USER = 64;
const MANAGE_REQUESTS = 2;

let moka;
let discordApi;
let app;

before(async () => {
  moka = await startFakeServer({
    "GET /api/v1/me": ({ headers }) => {
      if (headers.authorization === `Bearer ${KEY}`) return { id: 5, username: "anchorr-bot", permissions: ACT_AS_USER | MANAGE_REQUESTS };
      if (headers.authorization === "Bearer person-key") return { id: 6, username: "ana", permissions: 4 };
      return { status: 401, json: { message: "not signed in" } };
    },
    "GET /api/v1/anchorr/links": () => [{ user_id: 7, username: "ana", discord_id: "111111111111111111" }],
    "POST /api/v1/requests": ({ headers }) => ({ json: { id: 1, title_id: 9, status: "pending", requested_by: headers["x-moka-user"] } }),
    "GET /api/v1/catalog/search": () => ({ results: [{ tmdb_id: 603, title: "The Matrix", year: 1999, vote_average: 8.2 }] }),
    "GET /api/v1/catalog/shows/search": () => ({ results: [{ tmdb_id: 1399, title: "Thrones", year: 2011, vote_average: 8.4 }] }),
    "GET /api/v1/catalog/movie/603": () => ({
      tmdb_id: 603, imdb_id: "tt0133093", title: "The Matrix", year: 1999, release_date: "1999-03-30", runtime_minutes: 136,
      genres: ["Action"], directors: ["Lana Wachowski"], cast: [], vote_average: 8.2, poster_path: "/p.jpg", backdrop_path: "/b.jpg",
      local: { title_id: 9, state: "available" },
    }),
    "POST /api/v1/auth/login": ({ body }) =>
      body.password === "right"
        ? { json: { id: 1, username: body.username, permissions: body.username === "admin" ? 1 : 4 }, headers: { "set-cookie": "moka_session=s1; Path=/; HttpOnly" } }
        : { status: 401, json: { message: "wrong credentials" } },
    "POST /api/v1/auth/logout": () => ({}),
  });
  discordApi = await startFakeServer({
    "GET /users/@me": ({ headers }) => (headers.authorization === "Bot good-token" ? { id: "bot-1", username: "Popcorn" } : { status: 401, json: {} }),
    "GET /applications/@me": () => ({ flags: 1 << 15 }),
    "GET /users/@me/guilds": () => [{ id: "g1", name: "Home" }],
  });
  app = await startApp({ MOKA_URL: moka.url, DISCORD_API_URL: discordApi.url });
});
after(async () => {
  app?.stop();
  await moka?.close();
  await discordApi?.close();
});

const call = (method, url, body, headers = {}) => app.call(method, url, body, { auth: false, headers });
const asMoka = { authorization: `Bearer ${KEY}` };

// ----- pairing (Anchorr in a child process, tests in order) -----

test("before Moka pairs: setup waits for Moka and the Jellyfin and Seerr steps are closed", async () => {
  const state = (await call("GET", "/api/setup/state")).json;
  assert.equal(state.mokaMode, true);
  assert.equal(state.moka, false);
  assert.equal(state.needsSetup, true);
  assert.equal((await call("POST", "/api/setup/jellyfin", { url: "http://jf.example.com", apiKey: "x" })).status, 404, "nobody claims the install through Jellyfin");
  assert.equal((await call("POST", "/api/auth/jellyfin", { username: "admin", password: "right" })).status, 400, "no Moka sign-in before pairing");
});

test("pairing needs a key that works at MOKA_URL and acts for others", async () => {
  const body = { api_key: "stolen", guest_user_id: 3, discord_token: "good-token" };
  assert.equal((await call("POST", "/api/moka/pair", body)).status, 401);
  assert.equal((await call("POST", "/api/moka/pair", { ...body, api_key: "person-key" })).status, 403, "a person's key cannot pair");
  assert.equal((await call("POST", "/api/moka/pair", { ...body, api_key: KEY, discord_token: "bad-token" })).status, 400);
});

test("pairing saves the key and token, picks the only Discord server, and reports the bot", async () => {
  const res = await call("POST", "/api/moka/pair", { api_key: KEY, guest_user_id: 3, discord_token: "good-token", public_url: "https://moka.example.com/" });
  assert.equal(res.status, 200);
  assert.equal(res.json.bot_name, "Popcorn");
  assert.equal(res.json.guild_id, "g1");
  assert.deepEqual(res.json.guilds, [{ id: "g1", name: "Home" }]);
  assert.match(res.json.invite_url, /client_id=bot-1/);

  const state = (await call("GET", "/api/setup/state")).json;
  assert.deepEqual([state.moka, state.needsSetup], [true, false]);
  assert.equal((await call("GET", "/api/moka/status")).status, 401, "status needs Moka's key");
  assert.equal((await call("GET", "/api/moka/status", undefined, asMoka)).json.bot_name, "Popcorn");
  assert.equal((await call("POST", "/api/moka/events", { event: "available" })).status, 401, "events need Moka's key");
  assert.equal((await call("POST", "/api/moka/events", { event: "available" }, asMoka)).status, 200);
});

test("the dashboard signs in Moka administrators only, and never shows Moka's key", async () => {
  assert.equal((await call("POST", "/api/auth/jellyfin", { username: "admin", password: "wrong" })).status, 401);
  assert.equal((await call("POST", "/api/auth/jellyfin", { username: "ana", password: "right" })).status, 403);
  const ok = await call("POST", "/api/auth/jellyfin", { username: "admin", password: "right" });
  assert.equal(ok.status, 200);
  const config = (await app.call("GET", "/api/config", undefined, { headers: { cookie: ok.token } })).json;
  assert.equal("MOKA_API_KEY" in config, false);
  assert.equal(config.MOKA_PUBLIC_URL, "https://moka.example.com");
});

test("turning the bot off in Moka forgets the key", async () => {
  assert.equal((await call("DELETE", "/api/moka/pair", undefined, asMoka)).status, 200);
  assert.equal((await call("GET", "/api/moka/status", undefined, asMoka)).status, 401);
  assert.equal((await call("GET", "/api/setup/state")).json.moka, false);
});

// ----- the bot's calls to Moka (in this process) -----

test("requests go to Moka as the linked member's user, or as the guest, with seasons", async (t) => {
  t.after(applyConfig({ MOKA_URL: moka.url, MOKA_API_KEY: KEY, MOKA_GUEST_USER_ID: "3" }));
  const { sendRequest } = await import("../api/seerr.js");
  const { getDiscordLinks } = await import("../api/moka.js");
  await getDiscordLinks({ fresh: true });

  await sendRequest({ tmdbId: "603", mediaType: "movie", discordUserId: "111111111111111111" });
  let req = moka.requests.at(-1);
  assert.equal(req.headers["x-moka-user"], "7");
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(req.body, { tmdb_id: 603, kind: "movie" });

  await sendRequest({ tmdbId: "1399", mediaType: "tv", seasons: ["2", "3"], discordUserId: "999" });
  req = moka.requests.at(-1);
  assert.equal(req.headers["x-moka-user"], "3", "unlinked members request as the guest");
  assert.deepEqual(req.body, { tmdb_id: 1399, kind: "show", seasons: [2, 3] });

  await sendRequest({ tmdbId: "1399", mediaType: "tv", seasons: ["all"], discordUserId: "999" });
  assert.deepEqual(moka.requests.at(-1).body, { tmdb_id: 1399, kind: "show" }, "all seasons: no list");
});

test("search mixes Moka's films and shows; details say when Moka already has a title", async (t) => {
  t.after(applyConfig({ MOKA_URL: moka.url, MOKA_API_KEY: KEY }));
  const metadata = await import("../api/metadata.js");
  const { checkMediaStatus } = await import("../api/seerr.js");
  const found = await metadata.searchTitles("matrix moka");
  assert.deepEqual(found.map((r) => [r.media_type, r.id]), [["movie", 603], ["tv", 1399]]);
  assert.equal(found[1].name, "Thrones");
  const details = await metadata.getDetails(603, "movie");
  assert.equal(details.external_ids.imdb_id, "tt0133093");
  assert.equal(details.credits.crew[0].name, "Lana Wachowski");
  assert.deepEqual(await checkMediaStatus(603, "movie", [], "", ""), { exists: true, available: true });
});

test("a Moka event becomes the usual announcement, with the requester mentioned and messaged once", async (t) => {
  mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => mock.timers.reset());
  t.after(
    applyConfig({
      MOKA_URL: moka.url, MOKA_API_KEY: KEY, LANGUAGE: "en", JELLYFIN_CHANNEL_ID: "chan-default",
      NOTIFY_ON_AVAILABLE: "true", NOTIFY_TAG_REQUESTERS: "true",
    })
  );
  const { toPayloads } = await import("../jellyfin/mokaFeed.js");
  const { handleJellyfinItem } = await import("../jellyfin/itemHandler.js");
  const event = {
    event: "available", occurred_at: 1_763_700_000,
    title: { id: 9, kind: "movie", tmdb_id: 603, imdb_id: "tt0133093", title: "The Matrix", year: 1999, runtime_minutes: 136, link: "https://moka.example.com/movie/603", episodes: [] },
    requester_user_ids: [7],
  };
  const discord = createFakeDiscord();
  for (const p of toPayloads(event)) await handleJellyfinItem(p, discord.client, new Map(), () => {});

  assert.equal(discord.sent.length, 1);
  assert.equal(discord.sent[0].content, "Requested by <@111111111111111111>");
  assert.equal(discord.sent[0].embeds[0].url, "https://moka.example.com/movie/603");
  assert.deepEqual(discord.dms.map((d) => d.userId), ["111111111111111111"]);

  const show = {
    ...event,
    title: { ...event.title, id: 20, kind: "show", tmdb_id: 1399, title: "Thrones", link: null, episodes: [{ id: 21, season: 1, episode: 1, name: "Winter" }, { id: 22, season: 1, episode: 2, name: "Kingsroad" }] },
  };
  const eps = toPayloads(show);
  assert.deepEqual(eps.map((e) => [e.ItemType, e.SeriesName, e.SeasonNumber, e.EpisodeNumber, e.SeriesProvider_tmdb]), [
    ["Episode", "Thrones", 1, 1, "1399"],
    ["Episode", "Thrones", 1, 2, "1399"],
  ]);
});
