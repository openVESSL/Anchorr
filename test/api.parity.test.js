// Parity net for the dashboard HTTP API: the real app.js in a child process, over HTTP.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { startApp } from "./helpers/app.js";
import { startFakeServer } from "./helpers/http.js";

let app;
let jellyfin;
before(async () => {
  // Minimal Jellyfin so the first run can be claimed by an administrator (audit S4)
  jellyfin = await startFakeServer({
    "GET /System/Info/Public": () => ({ ServerName: "Home", Version: "12.4.0", Id: "srv-1" }),
    "POST /Users/AuthenticateByName": ({ body }) =>
      body.Username === "jf-admin" && body.Pw === "jf-pw"
        ? { AccessToken: "tok", User: { Id: "u1", Name: "jf-admin", Policy: { IsAdministrator: true } }, ServerId: "srv-1" }
        : { status: 401, json: {} },
    "GET /Auth/Keys": () => ({ Items: [{ AppName: "Anchorr", AccessToken: "jf-key", IsActive: true, DateCreated: "2026-01-01" }] }),
    "POST /Sessions/Logout": () => ({ status: 204 }),
  });
  app = await startApp();
});
after(async () => {
  app?.stop();
  await jellyfin?.close();
});

let cookie = "";
async function api(method, url, body, { auth = true, headers = {} } = {}) {
  app.cookie = cookie;
  return app.call(method, url, body, { auth, headers });
}
const tokenFrom = (setCookie) => setCookie?.match(/auth_token=[^;]+/)?.[0];

// Tests run in order: first-run setup, then authenticated use.

test("health is public", async () => {
  const res = await api("GET", "/api/health", undefined, { auth: false });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "healthy" }, "no version or bot details without login (audit S9)");
});

test("config endpoints need a session", async () => {
  assert.equal((await api("GET", "/api/config", undefined, { auth: false })).status, 401);
  assert.equal((await api("POST", "/api/save-config", {}, { auth: false })).status, 401);
});

test("first run: a Jellyfin admin claims the install, then one local account can be added", async () => {
  const check = await api("GET", "/api/auth/check", undefined, { auth: false });
  assert.deepEqual(check.json, { isAuthenticated: false, hasUsers: false, jellyfinLogin: false, needsSetup: true });
  assert.equal((await api("POST", "/api/auth/register", { username: "admin", password: "correct horse" }, { auth: false })).status, 401);

  const claim = await api("POST", "/api/setup/jellyfin", { url: jellyfin.url, username: "jf-admin", password: "jf-pw" }, { auth: false });
  assert.equal(claim.status, 200);
  assert.match(claim.setCookie, /auth_token=/);
  assert.match(claim.setCookie, /HttpOnly/i);
  assert.match(claim.setCookie, /SameSite=Strict/i);
  cookie = tokenFrom(claim.setCookie);

  assert.equal((await api("POST", "/api/auth/register", { username: "admin", password: "correct horse" })).status, 200);
  assert.equal((await api("POST", "/api/auth/register", { username: "other", password: "x" })).status, 403);
  cookie = "";
});

test("login: wrong password is rejected, right password sets the session cookie", async () => {
  const bad = await api("POST", "/api/auth/login", { username: "admin", password: "nope" }, { auth: false });
  assert.equal(bad.status, 401);

  const good = await api("POST", "/api/auth/login", { username: "admin", password: "correct horse" }, { auth: false });
  assert.equal(good.status, 200);
  cookie = tokenFrom(good.setCookie);
  assert.ok(cookie);
  assert.equal((await api("GET", "/api/auth/check")).json.isAuthenticated, true);
  const status = (await api("GET", "/api/status")).json;
  assert.match(status.version, /^[0-9]+.[0-9]+.[0-9]+/);
  assert.equal(status.isBotRunning, false);
});

test("saved secrets come back masked; resending the mask keeps them, an empty string clears them", async () => {
  const save = await api("POST", "/api/save-config", { SEERR_URL: "http://seerr.example.com/api/v1", SEERR_API_KEY: "seerr-secret-1234", LANGUAGE: "en" });
  assert.equal(save.status, 200);

  let config = (await api("GET", "/api/config")).json;
  assert.equal(config.SEERR_URL, "http://seerr.example.com", "trailing /api/v1 is stripped on save");
  assert.equal(config.SEERR_API_KEY, "••••••••1234");
  assert.equal("JWT_SECRET" in config, false);
  assert.equal("WEBHOOK_SECRET" in config, false);
  assert.ok(config.USERS.every((u) => !("password" in u)));

  await api("POST", "/api/save-config", { SEERR_API_KEY: config.SEERR_API_KEY, LANGUAGE: "de" });
  config = (await api("GET", "/api/config")).json;
  assert.equal(config.SEERR_API_KEY, "••••••••1234");
  assert.equal(config.LANGUAGE, "de");

  await api("POST", "/api/save-config", { SEERR_API_KEY: "" });
  assert.equal((await api("GET", "/api/config")).json.SEERR_API_KEY, "");
});

test("save keeps every dashboard field but drops unknown and protected keys (audit S5)", async () => {
  const res = await api("POST", "/api/save-config", {
    EMBED_COLOR_MOVIE: "#ff0000",
    EMBED_SHOW_GENRE: "false",
    DAILY_RANDOM_PICK_ENABLED: "true",
    DAILY_RANDOM_PICK_INTERVAL: "60",
    DEFAULT_SERVER_TV: "1|sonarr",
    startBot: false,
    WEBHOOK_PORT: "1",
    BIND_HOST: "0.0.0.0",
    LIBRARY_SEEDED: "false",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    "lib-checkbox": "true",
  });
  assert.equal(res.status, 200);

  const config = (await api("GET", "/api/config")).json;
  assert.equal(config.EMBED_COLOR_MOVIE, "#ff0000");
  assert.equal(config.EMBED_SHOW_GENRE, "false");
  assert.equal(config.DAILY_RANDOM_PICK_ENABLED, "true");
  assert.equal(config.DAILY_RANDOM_PICK_INTERVAL, "60");
  assert.equal(config.DEFAULT_SERVER_TV, "1|sonarr");
  for (const key of ["startBot", "WEBHOOK_PORT", "BIND_HOST", "LIBRARY_SEEDED", "NODE_TLS_REJECT_UNAUTHORIZED", "lib-checkbox"]) {
    assert.equal(key in config, false, `${key} must not be saved`);
  }
  assert.equal((await api("GET", "/api/health", undefined, { auth: false })).status, 200, "server still on its port");
});

test("invalid values are rejected per field (contract used by inline dashboard errors)", async () => {
  const res = await api("POST", "/api/save-config", { SEERR_URL: "not a url" });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.json.errors));
  assert.equal(res.json.errors[0].field, "SEERR_URL");
  assert.equal(typeof res.json.errors[0].message, "string");
});

test("the old Jellyfin Webhook plugin is acknowledged, ignored and reported to the dashboard", async () => {
  assert.equal((await api("GET", "/api/status")).json.legacyWebhookLastSeen, null);
  const res = await api("POST", "/jellyfin-webhook", { ItemId: "x", ItemType: "Movie" }, { auth: false });
  assert.equal(res.status, 200);
  assert.match(res.json.message, /no longer needs/);
  assert.equal(typeof (await api("GET", "/api/status")).json.legacyWebhookLastSeen, "number");
});

test("logout revokes the session", async () => {
  const old = cookie;
  assert.equal((await api("POST", "/api/auth/logout", {})).status, 200);
  cookie = old;
  assert.equal((await api("GET", "/api/config")).status, 403);
});

// v1 behavior, changed in v2 (audit S6: lockout per IP + username).
test("v1: five wrong passwords lock the account", async () => {
  let last;
  for (let i = 0; i < 5; i++) {
    last = await api("POST", "/api/auth/login", { username: "admin", password: `wrong-${i}` }, { auth: false });
  }
  assert.equal(last.status, 429);
  const locked = await api("POST", "/api/auth/login", { username: "admin", password: "correct horse" }, { auth: false });
  assert.equal(locked.status, 429);
});
