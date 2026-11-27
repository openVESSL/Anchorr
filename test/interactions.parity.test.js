// Parity net for slash commands, autocomplete, buttons and select menus.
// Seerr is a fake HTTP server: it serves requests, services and, in v2, all metadata.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { applyConfig } from "./helpers/config.js";
import { captureHandler, createInteraction } from "./helpers/interaction.js";
import { startFakeServer } from "./helpers/http.js";

// Seerr detail payloads (camelCase, as Seerr returns them); mediaInfo drives availability.
const MOVIES = {
  603: {
    id: 603, title: "The Matrix", releaseDate: "1999-03-31", overview: "Neo wakes up.", runtime: 136,
    genres: [{ id: 28, name: "Action" }], originalLanguage: "en", backdropPath: "/matrix.jpg", posterPath: "/matrix-p.jpg",
    voteAverage: 8.263, externalIds: { imdbId: "tt0133093" },
    credits: { crew: [{ job: "Director", department: "Directing", name: "Lana Wachowski" }, { job: "Director", department: "Directing", name: "Lilly Wachowski" }] },
    mediaInfo: null,
  },
  604: { id: 604, title: "Already Here", releaseDate: "2003-05-15", overview: "x", runtime: 100, genres: [], originalLanguage: "en", mediaInfo: { status: 5 } },
  605: { id: 605, title: "Over Quota", releaseDate: "2003-11-05", overview: "x", runtime: 100, genres: [], originalLanguage: "en", mediaInfo: null },
  606: { id: 606, title: "Spirited Away", releaseDate: "2001-07-20", overview: "x", runtime: 125, genres: [{ id: 16, name: "Animation" }], originalLanguage: "ja", mediaInfo: null },
};
const SHOWS = {
  1399: {
    id: 1399, name: "Game of Thrones", firstAirDate: "2011-04-17", overview: "Winter is coming.",
    episodeRunTime: [60], genres: [{ id: 18, name: "Drama" }], originalLanguage: "en",
    voteAverage: 8.456, externalIds: { imdbId: "tt0944947" }, createdBy: [{ name: "David Benioff" }, { name: "D. B. Weiss" }],
    seasons: [
      { seasonNumber: 0, episodeCount: 5 },
      { seasonNumber: 1, episodeCount: 10 },
      { seasonNumber: 2, episodeCount: 10 },
    ],
    mediaInfo: { status: 3, seasons: [] },
  },
};
const SEARCHABLE = [
  { id: 603, mediaType: "movie", title: "The Matrix", releaseDate: "1999-03-31" },
  { id: 1399, mediaType: "tv", name: "Game of Thrones", firstAirDate: "2011-04-17" },
  { id: 1, mediaType: "person", name: "Keanu Reeves" },
];

const { writeConfig } = await import("../utils/configFile.js");
const { t: translate } = await import("../utils/i18n.js");
const { registerInteractions } = await import("../bot/interactions.js");
const { pendingRequests } = await import("../bot/botState.js");
const { getSeerrErrorMessage } = await import("../bot/interactions/shared.js");
const { default: logger } = await import("../utils/logger.js");

let seerr;
let dispatch;
let guestCreationFails = false;
before(async () => {
  seerr = await startFakeServer({
    ...Object.fromEntries(Object.entries(MOVIES).map(([id, m]) => [`GET /api/v1/movie/${id}`, () => m])),
    ...Object.fromEntries(Object.entries(SHOWS).map(([id, s]) => [`GET /api/v1/tv/${id}`, () => s])),
    "GET /api/v1/movie/603/ratingscombined": () => ({ imdb: { criticsScore: 8.7 }, rt: { criticsScore: 83 } }),
    "GET /api/v1/search": ({ url }) =>
      url.searchParams.get("query") === "seerr is down"
        ? { status: 500, json: { message: "Internal Server Error" } }
        : { results: SEARCHABLE.filter((r) => (r.title || r.name).toLowerCase().includes(url.searchParams.get("query").toLowerCase())) },
    "GET /api/v1/discover/trending": () => ({
      results: [
        { id: 550, mediaType: "movie", title: "Fight Club", releaseDate: "1999-10-15" },
        { id: 1396, mediaType: "tv", name: "Breaking Bad", firstAirDate: "2008-01-20" },
      ],
    }),
    "GET /api/v1/service/radarr": () => [{ id: 0, name: "Radarr", isDefault: true }],
    "GET /api/v1/service/sonarr": () => [{ id: 1, name: "Sonarr", isDefault: true }],
    "GET /api/v1/service/radarr/0": () => ({ profiles: [{ id: 4, name: "HD-1080p" }], tags: [{ id: 3, label: "kids" }] }),
    "GET /api/v1/service/sonarr/1": () => ({ profiles: [{ id: 6, name: "WEB-720p" }], tags: [{ id: 7, label: "anime" }] }),
    "POST /api/v1/user": () => (guestCreationFails ? { status: 500, json: { message: "nope" } } : { status: 201, json: { id: 500 } }),
    "GET /api/v1/user/500": () => ({ id: 500, email: "discord@anchorr.invalid", permissions: 32 }),
    "POST /api/v1/request": ({ body }) =>
      body.mediaId === 605 ? { status: 403, json: { message: "Movie Quota exceeded" } } : { status: 201, json: { id: 99 } },
  });
  applyConfig({
    LANGUAGE: "en",
    GUILD_ID: "guild-1",
    SEERR_URL: seerr.url,
    SEERR_API_KEY: "seerr-key",
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

const posts = () => seerr.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/request");
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
    [["Directed by Lana Wachowski, Lilly Wachowski", "Neo wakes up."], ["Genre", "Action"], ["Runtime", "2h 16m"], ["Rating", "8.7/10"]]
  );
  assert.deepEqual(buttons(calls[1]), [
    ["Letterboxd", "https://letterboxd.com/imdb/tt0133093", undefined],
    ["IMDb", "https://www.imdb.com/title/tt0133093/", undefined],
    ["Request", "request_btn|603|movie||", false],
  ]);
  const tagMenu = calls[1].components[1].components[0];
  assert.equal(tagMenu.custom_id, "select_tags|603||movie");
  assert.deepEqual(tagMenu.options.map(({ label, value }) => ({ label, value })), [{ label: "kids", value: "3" }]);
  assert.equal(posts().length, before);
});

test("/request movie: requests as the mapped Seerr user and remembers the requester", async () => {
  const calls = await dispatch(command("request", { title: "603|movie" }));

  const post = lastPost();
  assert.equal(post.headers["x-api-user"], "42");
  assert.deepEqual(post.body, { mediaType: "movie", mediaId: 603 });

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

test("/search by typed text while Seerr fails: the member gets an error instead of a stuck reply", async () => {
  const calls = await dispatch(command("search", { title: "seerr is down" }));
  assert.deepEqual(calls.at(-1), {
    method: "followUp",
    content: translate("seerr_request_errors.server_error"),
    flags: 64,
  });
});

test("a refused Seerr redirect is reported as unreachable, without Seerr's address", () => {
  const err = Object.assign(new Error("Refused a redirect from http://seerr.lan:5055 to http://elsewhere"), { code: "EREDIRECT" });
  assert.equal(getSeerrErrorMessage(err), translate("seerr_request_errors.unreachable"));
});

test("a failing Discord delete is logged, and the private answer still goes out", async (t) => {
  const warnings = t.mock.method(logger, "warn", () => {});
  const interaction = command("search", { title: "seerr is down" });
  interaction.deleteReply = async () => {
    throw Object.assign(new Error("Service Unavailable"), { code: 0 });
  };
  const calls = await dispatch(interaction);
  assert.equal(calls.at(-1).method, "followUp");
  assert.ok(warnings.mock.calls.some((c) => /thinking reply/.test(c.arguments[0])));
});

test("an already deleted thinking reply is not logged as a problem", async (t) => {
  const warnings = t.mock.method(logger, "warn", () => {});
  const interaction = command("search", { title: "seerr is down" });
  interaction.deleteReply = async () => {
    throw Object.assign(new Error("Unknown Message"), { code: 10008 });
  };
  await dispatch(interaction);
  assert.equal(warnings.mock.calls.some((c) => /thinking reply/.test(c.arguments[0])), false);
});

test("when Discord refuses the private answer, it is logged instead of shown as a Seerr error", async (t) => {
  const errors = t.mock.method(logger, "error", () => {});
  const interaction = command("request", { title: "604|movie" });
  const sent = [];
  interaction.followUp = async (payload) => {
    sent.push(payload);
    throw new Error("Missing Access");
  };
  await dispatch(interaction);
  assert.equal(sent.length, 1, "no second, misleading error reply");
  assert.ok(errors.mock.calls.some((c) => /private reply/.test(c.arguments[0])));
});

test("/request movie: if showing the result fails after the request went through, the member is told it was requested", async (t) => {
  t.mock.method(logger, "error", () => {});
  const before = posts().length;
  const interaction = command("request", { title: "603|movie" });
  interaction.editReply = async () => {
    throw new Error("Invalid Form Body");
  };
  const calls = await dispatch(interaction);
  assert.equal(posts().length, before + 1);
  assert.deepEqual(calls.at(-1), {
    method: "followUp",
    content: translate("replies.pick_requested", { title: "The Matrix" }),
    flags: 64,
  });
});

test("/request movie in private mode: a failed result display still confirms the request", async (t) => {
  configure(t, { PRIVATE_MESSAGE_MODE: "true" });
  t.mock.method(logger, "error", () => {});
  const interaction = command("request", { title: "603|movie" });
  const edits = [];
  interaction.editReply = async (payload) => {
    edits.push(payload);
    if (payload.embeds) throw new Error("Invalid Form Body");
  };
  await dispatch(interaction);
  assert.equal(edits.at(-1).content, translate("replies.pick_requested", { title: "The Matrix" }));
});

test("/search: when Discord refuses the result, the member gets a generic error, not a Seerr error", async (t) => {
  const errors = t.mock.method(logger, "error", () => {});
  const interaction = command("search", { title: "603|movie" });
  interaction.editReply = async () => {
    throw new Error("Invalid Form Body");
  };
  const calls = await dispatch(interaction);
  assert.deepEqual(calls.at(-1), { method: "followUp", content: translate("replies.unexpected"), flags: 64 });
  const logged = errors.mock.calls.find((c) => /could not show the result/i.test(String(c.arguments[0])));
  assert.ok(logged);
  assert.doesNotMatch(logged.arguments[0], /Matrix/, "the title is an argument, never part of the format string");
  assert.ok(logged.arguments.every((a) => typeof a === "string"), "only the error message is logged, not the error object");
});

test("/request TV: requests nothing yet and opens the season picker", async () => {
  const before = posts().length;
  const calls = await dispatch(command("request", { title: "1399|tv" }));

  assert.equal(posts().length, before);
  const reply = calls.at(-1);
  assert.equal(reply.embeds[0].author.name, "📺 TV show found:");
  assert.deepEqual(
    reply.embeds[0].fields.map((f) => [f.name, f.value]),
    [
      ["Created by David Benioff", "Winter is coming."],
      ["Genre", "Drama"],
      ["Runtime", "1h 0m"],
      ["Rating", "8.5/10"], // no IMDb score for shows in Seerr: TMDB score
    ]
  );
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

test("commands are disabled while Seerr is not configured", async (t) => {
  configure(t, { SEERR_API_KEY: undefined });
  const calls = await dispatch(command("search", { title: "603|movie" }));
  assert.deepEqual(calls, [
    {
      method: "reply",
      content: "⚠️ This command is disabled because Seerr is not configured.",
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
  // v1 also listed Radarr tags here, which a show request then dropped
  const tagMenu = calls[1].components[2].components[0];
  assert.equal(tagMenu.custom_id, "select_tags|1399|1|tv");
  assert.deepEqual(tagMenu.options.map((o) => o.label), ["anime"]);
});

test("the tag picker keeps the media type, also for a show without chosen seasons", async () => {
  const select = (customId) =>
    createInteraction({ type: "select", customId, values: ["7"], messageComponents: [{ components: [{ customId, options: [] }] }] });
  const detailsFetched = () => seerr.requests.filter((r) => r.method === "GET" && /^\/api\/v1\/(tv|movie)\/1399$/.test(r.path)).at(-1)?.path;
  await dispatch(select("select_tags|1399||tv"));
  assert.equal(detailsFetched(), "/api/v1/tv/1399", "v1 treated it as movie 1399");
});

test("Request button for chosen seasons requests exactly those seasons", async () => {
  const calls = await dispatch(button("request_btn|1399|tv|1,2|"));
  assert.equal(lastPost().headers["x-api-user"], "42");
  assert.deepEqual(lastPost().body, { mediaType: "tv", mediaId: 1399, seasons: [1, 2] });
  assert.equal(calls.at(-1).embeds[0].author.name, "✅ Successfully requested!");
  assert.deepEqual(buttons(calls.at(-1)).at(-1), ["Requested seasons 1 and 2, stay tuned!", "requested|1399|tv", true]);
});

test("Request button for a movie requests it", async () => {
  const before = posts().length;
  await dispatch(button("request_btn|603|movie||"));
  assert.equal(posts().length, before + 1);
  assert.deepEqual(lastPost().body, { mediaType: "movie", mediaId: 603 });
});

test("the disabled Requested button explains itself", async () => {
  const calls = await dispatch(button("requested|603|movie"));
  assert.deepEqual(calls, [{ method: "reply", content: "This item was already requested.", flags: 64 }]);
});

test("Daily Random Pick button requests the title and confirms privately", async () => {
  const calls = await dispatch(button("request_random_603_movie"));
  assert.deepEqual(lastPost().body, { mediaType: "movie", mediaId: 603 });
  assert.deepEqual(calls.at(-1), { method: "followUp", content: "✅ **The Matrix** has been requested!", flags: 64 });
});

test("Daily Random Pick: a show asks for its seasons explicitly, like /request", async () => {
  await dispatch(button("request_random_1399_tv"));
  assert.deepEqual(lastPost().body.seasons, [1, 2], "v1 sent 'all'; specials stay out");
});

test("Daily Random Pick: anime is requested as anime, like /request", async () => {
  await dispatch(button("request_random_606_movie"));
  assert.equal(lastPost().body.isAnime, true);
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

// ----- Discord users without a mapping (audit S1) -----

test("unmapped user, guest account cannot be created: told to link, nothing requested as admin", async () => {
  guestCreationFails = true;
  const before = posts().length;
  const calls = await dispatch(createInteraction({ type: "command", commandName: "request", options: { title: "603|movie" }, userId: "user-2" }));
  guestCreationFails = false;

  assert.equal(posts().length, before);
  assert.deepEqual(calls.at(-1), { method: "followUp", content: translate("seerr_request_errors.not_linked"), flags: 64 });
});

test("unmapped user requests through the guest account, which is created once and remembered", async () => {
  const userPosts = () => seerr.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/user").length;
  const created = userPosts();

  await dispatch(createInteraction({ type: "command", commandName: "request", options: { title: "603|movie" }, userId: "user-2" }));
  assert.equal(lastPost().headers["x-api-user"], "500");
  assert.equal(userPosts(), created + 1);

  await dispatch(createInteraction({ type: "button", customId: "request_btn|603|movie||", userId: "user-3" }));
  assert.equal(lastPost().headers["x-api-user"], "500");
  assert.equal(userPosts(), created + 1, "the saved guest id is reused");
});
