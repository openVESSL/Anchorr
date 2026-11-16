// Dashboard Overview: server names and versions, Seerr request counts, the latest requests
// with approve/decline, and the activity log.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { getActivity, recordActivity, resetActivityCache } from "../utils/activity.js";
import { startApp } from "./helpers/app.js";
import { startFakeServer } from "./helpers/http.js";

let jellyfin;
let seerr;
let app;

before(async () => {
  jellyfin = await startFakeServer({
    "GET /System/Info/Public": () => ({ ServerName: "Living room", Version: "10.11.2", Id: "srv-1" }),
    "POST /Users/AuthenticateByName": () => ({ AccessToken: "tok", User: { Id: "u1", Name: "admin", Policy: { IsAdministrator: true } }, ServerId: "srv-1" }),
    "GET /Auth/Keys": () => ({ Items: [{ AppName: "Anchorr", AccessToken: "jf-key", IsActive: true, DateCreated: "2026-01-01" }] }),
    "POST /Sessions/Logout": () => ({ status: 204 }),
  });
  seerr = await startFakeServer({
    "GET /api/v1/settings/about": () => ({ version: "3.5.2" }),
    "GET /api/v1/request/count": () => ({ total: 12, movie: 8, tv: 4, pending: 2, approved: 9, declined: 1, processing: 3, available: 6 }),
    "GET /api/v1/request": () => ({
      pageInfo: { results: 12 },
      results: [
        {
          id: 7,
          type: "movie",
          status: 1,
          is4k: false,
          createdAt: "2026-11-15T10:00:00.000Z",
          media: { tmdbId: 603, status: 2 },
          seasons: [],
          requestedBy: { displayName: "Ana", avatar: "/avatarproxy/abc" },
        },
      ],
    }),
    "GET /api/v1/movie/603": () => ({ id: 603, title: "The Matrix", releaseDate: "1999-03-31", posterPath: "/m.jpg" }),
    "POST /api/v1/request/7/approve": () => ({ json: { id: 7, status: 2 } }),
  });
  app = await startApp({ SEERR_URL: seerr.url, SEERR_API_KEY: "seerr-key" });
  const claim = await app.call("POST", "/api/setup/jellyfin", { url: jellyfin.url, username: "admin", password: "pw" }, { auth: false });
  assert.equal(claim.status, 200);
  app.cookie = claim.token;
});
after(async () => {
  app?.stop();
  await jellyfin?.close();
  await seerr?.close();
});

test("overview and requests need a session", async () => {
  assert.equal((await app.call("GET", "/api/overview", undefined, { auth: false })).status, 401);
  assert.equal((await app.call("POST", "/api/requests/7/approve", undefined, { auth: false })).status, 401);
});

test("overview shows the Jellyfin server name, the Seerr version and request counts", async () => {
  const { status, json } = await app.call("GET", "/api/overview");
  assert.equal(status, 200);
  assert.equal(json.jellyfin.serverName, "Living room");
  assert.equal(json.jellyfin.version, "10.11.2");
  assert.equal(json.jellyfin.url, jellyfin.url, "for the card's link to Jellyfin");
  assert.equal(json.seerr.version, "3.5.2");
  assert.equal(json.requestCounts.pending, 2);
  assert.equal(json.discord, null, "bot is not running");
  assert.ok(Array.isArray(json.activity.recent));
});

test("recent requests carry the title, poster and requester", async () => {
  const { status, json } = await app.call("GET", "/api/requests/recent");
  assert.equal(status, 200);
  const [r] = json.results;
  assert.equal(r.title, "The Matrix");
  assert.equal(r.year, "1999");
  assert.equal(r.poster, "https://image.tmdb.org/t/p/w154/m.jpg");
  assert.equal(r.requestedBy.name, "Ana");
  assert.equal(r.requestedBy.avatar, `${seerr.url}/avatarproxy/abc`);
  const list = seerr.requests.find((q) => q.path === "/api/v1/request");
  assert.equal(list.query.get("sort"), "added");
});

test("approve goes to Seerr; unknown ids and actions are refused", async () => {
  const ok = await app.call("POST", "/api/requests/7/approve");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 2);
  assert.ok(seerr.requests.some((q) => q.method === "POST" && q.path === "/api/v1/request/7/approve"));
  assert.equal((await app.call("POST", "/api/requests/7/delete")).status, 400);
  assert.equal((await app.call("POST", "/api/requests/..%2Fsettings/approve")).status, 400);
  assert.equal((await app.call("POST", "/api/requests/8/approve")).status, 404);
});

test("activity keeps the newest event first and counts the last week", () => {
  resetActivityCache();
  recordActivity("notification", { title: "Dune", detail: "Movie" });
  recordActivity("request", { title: "Severance", detail: "tv", user: "ana" });
  resetActivityCache(); // read back from disk
  const { recent, week } = getActivity();
  assert.equal(recent[0].title, "Severance");
  assert.equal(recent[1].title, "Dune");
  assert.equal(week.request, 1);
  assert.equal(week.notification, 1);
});
