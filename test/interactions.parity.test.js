// Parity net for slash commands, autocomplete, buttons and select menus.
// Seerr is a fake HTTP server (the stable boundary); TMDB is replaced at module level
// because v1 hardcodes its URL. v2 swaps that mock for the Seerr metadata source.
import assert from "node:assert/strict";
import test, { after, before, mock } from "node:test";

import { applyConfig } from "./helpers/config.js";
import { captureHandler, createInteraction } from "./helpers/interaction.js";
import { startFakeServer } from "./helpers/http.js";

const realTmdb = await import("../api/tmdb.js");

const MOVIES = {
  603: { id: 603, title: "The Matrix", release_date: "1999-03-31", overview: "Neo wakes up.", runtime: 136, genres: [{ id: 28, name: "Action" }], original_language: "en", backdrop_path: "/matrix.jpg", poster_path: "/matrix-p.jpg" },
  604: { id: 604, title: "Already Here", release_date: "2003-05-15", overview: "x", runtime: 100, genres: [], original_language: "en" },
  605: { id: 605, title: "Over Quota", release_date: "2003-11-05", overview: "x", runtime: 100, genres: [], original_language: "en" },
};
const SHOWS = {
  1399: {
    id: 1399, name: "Game of Thrones", first_air_date: "2011-04-17", overview: "Winter is coming.",
    episode_run_time: [60], genres: [{ id: 18, name: "Drama" }], original_language: "en",
    seasons: [
      { season_number: 0, episode_count: 5 },
      { season_number: 1, episode_count: 10 },
      { season_number: 2, episode_count: 10 },
    ],
  },
};
const IMDB = { 603: "tt0133093", 1399: "tt0944947" };

mock.module("../api/tmdb.js", {
  namedExports: {
    ...realTmdb,
    tmdbSearch: async (query) =>
      [
        { id: 603, media_type: "movie", title: "The Matrix", release_date: "1999-03-31" },
        { id: 1399, media_type: "tv", name: "Game of Thrones", first_air_date: "2011-04-17" },
        { id: 1, media_type: "person", name: "Keanu Reeves" },
      ].filter((r) => (r.title || r.name).toLowerCase().includes(query.toLowerCase())),
    tmdbGetTrending: async () => [
      { id: 550, media_type: "movie", title: "Fight Club", release_date: "1999-10-15" },
      { id: 1396, media_type: "tv", name: "Breaking Bad", first_air_date: "2008-01-20" },
    ],
    tmdbGetDetails: async (id, type) => (type === "tv" ? SHOWS : MOVIES)[id],
    tmdbGetExternalImdb: async (id) => IMDB[id] ?? null,
  },
});

const { writeConfig } = await import("../utils/configFile.js");
const { t: translate } = await import("../utils/i18n.js");
const { registerInteractions } = await import("../bot/interactions.js");
const { pendingRequests } = await import("../bot/botState.js");

let seerr;
let dispatch;
before(async () => {
  seerr = await startFakeServer({
    "GET /api/v1/movie/603": () => ({ mediaInfo: null }),
    "GET /api/v1/movie/604": () => ({ mediaInfo: { status: 5 } }),
    "GET /api/v1/movie/605": () => ({ mediaInfo: null }),
    "GET /api/v1/tv/1399": () => ({ mediaInfo: { status: 3, seasons: [] } }),
    "GET /api/v1/service/radarr": () => [{ id: 0, name: "Radarr", isDefault: true }],
    "GET /api/v1/service/sonarr": () => [{ id: 1, name: "Sonarr", isDefault: true }],
    "GET /api/v1/service/radarr/0": () => ({ profiles: [{ id: 4, name: "HD-1080p" }], tags: [{ id: 3, label: "kids" }] }),
    "GET /api/v1/service/sonarr/1": () => ({ profiles: [{ id: 6, name: "WEB-720p" }], tags: [{ id: 7, label: "anime" }] }),
    "POST /api/v1/request": ({ body }) =>
      body.mediaId === 605 ? { status: 403, json: { message: "Movie Quota exceeded" } } : { status: 201, json: { id: 99 } },
  });
  applyConfig({
    LANGUAGE: "en",
    GUILD_ID: "guild-1",
    SEERR_URL: seerr.url,
    SEERR_API_KEY: "seerr-key",
    TMDB_API_KEY: "tmdb-key",
    SEERR_AUTO_APPROVE: "false",
    NOTIFY_ON_AVAILABLE: "true",
    PRIVATE_MESSAGE_MODE: "false",
    ROLE_ALLOWLIST: undefined,
    ROLE_BLOCKLIST: undefined,
  });
  writeConfig({ USER_MAPPINGS: [{ discordUserId: "user-1", seerrUserId: 42 }] });
  dispatch = captureHandler(registerInteractions);
});
after(() => seerr.close());

const MAUVE_SUCCESS = 0xa6e3a1;
const PEACH_SEARCH = 0xfab387;

const posts = () => seerr.requests.filter((r) => r.method === "POST");
const lastPost = () => posts().at(-1);
const command = (commandName, options) => createInteraction({ type: "command", commandName, options });
const autocomplete = (commandName, focused, options = {}) =>
  createInteraction({ type: "autocomplete", commandName, focused, options });
const button = (customId) => createInteraction({ type: "button", customId });
const buttons = (reply) => reply.components[0].components.map((c) => [c.label, c.custom_id ?? c.url, c.disabled]);

function configure(t, values) {
  t.after(applyConfig(values));
}

// ----- slash commands -----

test("/search movie: shows details with a Request button and a Radarr tag picker, requests nothing", async () => {
  const before = posts().length;
  const calls = await dispatch(command("search", { title: "603|movie" }));

  assert.deepEqual(calls.map((c) => c.method), ["deferReply", "editReply"]);
  assert.equal(calls[0].flags, undefined, "public reply by default");
  const [embed] = calls[1].embeds;
  assert.equal(embed.author.name, "🎬 Movie found:");
  assert.equal(embed.author.url, `${seerr.url}/movie/603`);
  assert.equal(embed.title, "The Matrix (1999)");
  assert.equal(embed.url, "https://www.imdb.com/title/tt0133093/");
  assert.equal(embed.color, PEACH_SEARCH);
  assert.equal(embed.image.url, "https://image.tmdb.org/t/p/w1280/matrix.jpg");
  assert.deepEqual(
    embed.fields.map((f) => [f.name, f.value]),
    [["Summary", "Neo wakes up."], ["Genre", "Action"], ["Runtime", "2h 16m"], ["Rating", "N/A"]]
  );
  assert.deepEqual(buttons(calls[1]), [
    ["Letterboxd", "https://letterboxd.com/imdb/tt0133093", undefined],
    ["IMDb", "https://www.imdb.com/title/tt0133093/", undefined],
    ["Request", "request_btn|603|movie||", false],
  ]);
  const tagMenu = calls[1].components[1].components[0];
  assert.equal(tagMenu.custom_id, "select_tags|603|");
  assert.deepEqual(tagMenu.options.map(({ label, value }) => ({ label, value })), [{ label: "kids", value: "3" }]);
  assert.equal(posts().length, before);
});

test("/request movie: requests as the mapped Seerr user and remembers the requester", async () => {
  const calls = await dispatch(command("request", { title: "603|movie" }));

  const post = lastPost();
  assert.equal(post.headers["x-api-user"], "42");
  assert.deepEqual(post.body, { mediaType: "movie", mediaId: 603, isAutoApproved: false });

  const [embed] = calls.at(-1).embeds;
  assert.equal(embed.author.name, "✅ Successfully requested!");
  assert.equal(embed.author.url, `${seerr.url}/movie/603?manage=1`);
  assert.equal(embed.color, MAUVE_SUCCESS);
  assert.deepEqual(buttons(calls.at(-1)).at(-1), ["Requested, stay tuned!", "requested|603|movie", true]);
  assert.deepEqual([...pendingRequests.get("603-movie")], ["user-1"]);
});

test("/request movie with a quality option sends that profile and server", async () => {
  await dispatch(command("request", { title: "603|movie", quality: "4|0|radarr" }));
  assert.equal(lastPost().body.profileId, 4);
  assert.equal(lastPost().body.serverId, 0);
});

test("/request for something already available does not request it again", async () => {
  const before = posts().length;
  const calls = await dispatch(command("request", { title: "604|movie" }));
  assert.equal(posts().length, before);
  assert.deepEqual(calls.at(-1), {
    method: "followUp",
    content: "✅ This content is already available in your library!",
    flags: 64,
  });
});

test("/request over quota shows Seerr's reason privately", async () => {
  const calls = await dispatch(command("request", { title: "605|movie" }));
  assert.deepEqual(calls.at(-1), {
    method: "followUp",
    content: translate("seerr_request_errors.quota", { msg: "Movie Quota exceeded" }),
    flags: 64,
  });
});

test("/request TV: requests nothing yet and opens the season picker", async () => {
  const before = posts().length;
  const calls = await dispatch(command("request", { title: "1399|tv" }));

  assert.equal(posts().length, before);
  const reply = calls.at(-1);
  assert.equal(reply.embeds[0].author.name, "📺 TV show found:");
  assert.equal(reply.embeds[0].fields.find((f) => f.name === "Runtime").value, "1h 0m");
  assert.deepEqual(buttons(reply).at(-1), ["Request", "request_btn|1399|tv||", true]);
  const picker = reply.components[1].components[0];
  assert.equal(picker.custom_id, "select_seasons|1399|");
  assert.deepEqual(picker.options.map((o) => o.value), ["all", "1", "2"], "specials (season 0) are hidden");
});

test("private mode: replies are only visible to the user", async (t) => {
  configure(t, { PRIVATE_MESSAGE_MODE: "true" });
  const calls = await dispatch(command("search", { title: "603|movie" }));
  assert.equal(calls[0].flags, 64);
});

test("commands are disabled while Seerr or TMDB is not configured", async (t) => {
  configure(t, { TMDB_API_KEY: undefined });
  const calls = await dispatch(command("search", { title: "603|movie" }));
  assert.deepEqual(calls, [
    {
      method: "reply",
      content: "⚠️ This command is disabled because Seerr or TMDB configuration is missing.",
      flags: 64,
    },
  ]);
});

// ----- season picker and buttons -----

test("picking a season enables the Request button for that season", async () => {
  const calls = await dispatch(
    createInteraction({
      type: "select",
      customId: "select_seasons|1399|",
      values: ["1"],
      messageComponents: [{ components: [{ customId: "select_seasons|1399|", options: [] }] }],
    })
  );
  assert.deepEqual(calls.map((c) => c.method), ["deferUpdate", "editReply"]);
  assert.deepEqual(buttons(calls[1]).at(-1), ["Request season 1", "request_btn|1399|tv|1|", false]);
  // v1 also lists Radarr tags here (known bug, fixed in v2): only check the Sonarr tag and the customId.
  const tagMenu = calls[1].components[2].components[0];
  assert.equal(tagMenu.custom_id, "select_tags|1399|1");
  assert.ok(tagMenu.options.some((o) => o.label === "anime"));
});

test("Request button for chosen seasons requests exactly those seasons", async () => {
  const calls = await dispatch(button("request_btn|1399|tv|1,2|"));
  assert.equal(lastPost().headers["x-api-user"], "42");
  assert.deepEqual(lastPost().body, { mediaType: "tv", mediaId: 1399, seasons: [1, 2], isAutoApproved: false });
  assert.equal(calls.at(-1).embeds[0].author.name, "✅ Successfully requested!");
  assert.deepEqual(buttons(calls.at(-1)).at(-1), ["Requested seasons 1 and 2, stay tuned!", "requested|1399|tv", true]);
});

test("Request button for a movie requests it", async () => {
  const before = posts().length;
  await dispatch(button("request_btn|603|movie||"));
  assert.equal(posts().length, before + 1);
  assert.deepEqual(lastPost().body, { mediaType: "movie", mediaId: 603, isAutoApproved: false });
});

test("the disabled Requested button explains itself", async () => {
  const calls = await dispatch(button("requested|603|movie"));
  assert.deepEqual(calls, [{ method: "reply", content: "This item was already requested.", flags: 64 }]);
});

test("Daily Random Pick button requests the title and confirms privately", async () => {
  const calls = await dispatch(button("request_random_603_movie"));
  assert.deepEqual(lastPost().body, { mediaType: "movie", mediaId: 603, isAutoApproved: false });
  assert.deepEqual(calls.at(-1), { method: "followUp", content: "✅ **The Matrix** has been requested!", flags: 64 });
});

// ----- autocomplete -----

test("title autocomplete lists movies and shows only, with year", async () => {
  const calls = await dispatch(autocomplete("search", { name: "title", value: "e" }));
  assert.deepEqual(calls[0].choices, [
    { name: "🎬 The Matrix (1999)", value: "603|movie" },
    { name: "📺 Game of Thrones (2011)", value: "1399|tv" },
  ]);
});

test("empty title autocomplete returns nothing", async () => {
  const calls = await dispatch(autocomplete("search", { name: "title", value: "" }));
  assert.deepEqual(calls[0].choices, []);
});

test("/trending autocomplete lists trending titles", async () => {
  const calls = await dispatch(autocomplete("trending", { name: "title", value: "" }));
  assert.deepEqual(calls[0].choices, [
    { name: "🎬 Fight Club (1999)", value: "550|movie" },
    { name: "📺 Breaking Bad (2008)", value: "1396|tv" },
  ]);
});

test("server and quality autocomplete only offer the matching service", async () => {
  const servers = await dispatch(autocomplete("request", { name: "server", value: "" }, { title: "1399|tv" }));
  assert.deepEqual(servers[0].choices, [{ name: "📺 Sonarr (default)", value: "1|sonarr" }]);

  const qualities = await dispatch(autocomplete("request", { name: "quality", value: "" }, { title: "603|movie" }));
  assert.deepEqual(qualities[0].choices, [{ name: "HD-1080p (Radarr)", value: "4|0|radarr" }]);
});

test("tag autocomplete lists unique tag labels", async () => {
  const calls = await dispatch(autocomplete("request", { name: "tag", value: "" }));
  assert.deepEqual(calls[0].choices, [
    { name: "kids", value: "kids" },
    { name: "anime", value: "anime" },
  ]);
});

// ----- permissions -----

test("denied users get a private message; denied autocomplete returns nothing", async (t) => {
  configure(t, { ROLE_ALLOWLIST: ["vip"] });
  const before = posts().length;

  const calls = await dispatch(command("request", { title: "603|movie" }));
  assert.deepEqual(calls, [{ method: "reply", content: translate("permission_errors.denied"), flags: 64 }]);

  const ac = await dispatch(autocomplete("search", { name: "title", value: "matrix" }));
  assert.deepEqual(ac, [{ method: "respond", choices: [] }]);

  const dm = await dispatch(createInteraction({ type: "button", customId: "request_btn|603|movie||", guildId: null, member: null }));
  assert.deepEqual(dm, [{ method: "reply", content: translate("permission_errors.dm_denied"), flags: 64 }]);
  assert.equal(posts().length, before);
});
