// Parity net for the dashboard HTTP API: the real app.js in a child process, over HTTP.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { startApp } from "./helpers/app.js";
import { startFakeServer } from "./helpers/http.js";

let app;
let jellyfin;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anchorr-api-"));
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
  app = await startApp({ ANCHORR_TEST_DATA_DIR: dataDir });
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

test("page loads (session checks) never use up the sign-in attempts", async () => {
  for (let i = 0; i < 30; i++) assert.equal((await api("GET", "/api/auth/check", undefined, { auth: false })).status, 200);
  const res = await api("POST", "/api/auth/login", { username: "admin", password: "correct horse" }, { auth: false });
  assert.equal(res.status, 200);
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

test("Seerr checks never send the stored key to another server", async () => {
  await api("POST", "/api/save-config", { SEERR_URL: "http://seerr.example.com", SEERR_API_KEY: "seerr-secret-1234" });
  for (const route of ["/api/test-seerr", "/api/seerr/quality-profiles", "/api/seerr/servers"]) {
    const other = await api("POST", route, { url: "http://evil.example.com", apiKey: "••••••••1234" });
    assert.equal(other.status, 403, `${route}: masked key, other host`);
    assert.equal((await api("POST", route, { url: "ftp://seerr.example.com", apiKey: "plain-key" })).status, 400, `${route}: not http(s)`);
    assert.equal((await api("POST", route, { url: "http://seerr.example.com" })).status, 400, `${route}: no key`);
  }
  await api("POST", "/api/save-config", { SEERR_API_KEY: "" });
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

  const pick = await api("POST", "/api/save-config", { DAILY_RANDOM_PICK_INTERVAL: "43200" });
  assert.equal(pick.status, 400);
  assert.equal(pick.json.errors[0].field, "DAILY_RANDOM_PICK_INTERVAL");
  assert.match(pick.json.errors[0].message, /between 1 and/);
});

test("the old Jellyfin Webhook plugin is acknowledged, ignored and reported to the dashboard", async () => {
  assert.equal((await api("GET", "/api/status")).json.legacyWebhookLastSeen, null);
  const res = await api("POST", "/jellyfin-webhook", { ItemId: "x", ItemType: "Movie" }, { auth: false });
  assert.equal(res.status, 200);
  assert.match(res.json.message, /no longer needs/);
  assert.equal(typeof (await api("GET", "/api/status")).json.legacyWebhookLastSeen, "number");
});

test("a config backup restores, keeps this install's secrets and port, and rejects other files", async () => {
  assert.equal((await api("GET", "/api/config/backup", undefined, { auth: false })).status, 401);
  assert.equal((await api("POST", "/api/config/restore", {}, { auth: false })).status, 401);

  const backup = await api("GET", "/api/config/backup");
  assert.equal(backup.status, 200);
  assert.match(backup.json.JWT_SECRET, /^b64:/, "the backup is the file as stored on disk");
  const before = (await api("GET", "/api/config")).json;

  assert.equal((await api("POST", "/api/config/restore", { hello: "world" })).status, 400);
  assert.equal((await api("POST", "/api/config/restore", { SEERR_URL: "not a url" })).status, 400);

  const res = await api("POST", "/api/config/restore", { ...backup.json, LANGUAGE: "fr", JWT_SECRET: "other", WEBHOOK_PORT: "1" });
  assert.equal(res.status, 200);
  const after = (await api("GET", "/api/config")).json;
  assert.equal(after.LANGUAGE, "fr");
  assert.equal(after.SEERR_URL, before.SEERR_URL);
  assert.equal("WEBHOOK_PORT" in after, "WEBHOOK_PORT" in before);
  assert.equal((await api("GET", "/api/status")).status, 200, "the session survives, so JWT_SECRET was kept");
});

test("upgrade checklist: only for installs migrated from 1.x, dismissable, session and JSON required", async () => {
  assert.equal((await api("GET", "/api/upgrade", undefined, { auth: false })).status, 401);
  assert.deepEqual((await api("GET", "/api/upgrade")).json, { show: false, items: [] }, "nothing for a 2.0 install");

  // restoring a 1.x backup runs the upgrade, like a first start of 2.0 on a 1.x config
  const current = (await api("GET", "/api/config/backup")).json;
  delete current.CONFIG_VERSION;
  const v1 = {
    ...current,
    TMDB_API_KEY: "",
    SEERR_AUTO_APPROVE: "true",
    USER_MAPPINGS: [{ discordUserId: "123456789012345678", seerrUserId: "2" }],
    WEEKLY_ROUNDUP_ENABLED: "true",
  };
  assert.equal((await api("POST", "/api/config/restore", v1)).status, 200);

  const { json } = await api("GET", "/api/upgrade");
  assert.equal(json.show, true);
  assert.ok(Date.parse(json.upgradedAt));
  const items = Object.fromEntries(json.items.map((i) => [i.id, i]));
  assert.deepEqual(
    json.items.map((i) => i.id),
    ["jellyfin_linked", "auto_approve", "time_zone", "webhook_plugin", "backup", "removed_keys"],
    "most important first; no Seerr guest item without Seerr"
  );
  assert.equal(items.jellyfin_linked.state, "done", "linked during the first run");
  assert.equal(items.auto_approve.state, "manual");
  assert.equal(items.webhook_plugin.state, "todo", "the plugin called earlier in this run");
  assert.match(items.backup.path, /backup-1\.x$/);

  // a plain HTML form (no JSON) cannot hide it
  const form = await api("POST", "/api/upgrade/dismiss", undefined, { headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(form.status, 415);
  assert.equal((await api("POST", "/api/upgrade/dismiss", {}, { auth: false })).status, 401);

  assert.equal((await api("POST", "/api/upgrade/dismiss", {})).status, 200);
  assert.deepEqual((await api("GET", "/api/upgrade")).json, { show: false, items: [] });

  // a restored file cannot carry a broken record
  const broken = (await api("GET", "/api/config/backup")).json;
  assert.equal((await api("POST", "/api/config/restore", { ...broken, UPGRADE_FROM_V1: null })).status, 400);
  assert.equal((await api("POST", "/api/config/restore", { ...broken, UPGRADE_FROM_V1: { at: "x" } })).status, 400);

  // the dashboard cannot bring it back or fake it
  const saved = await api("POST", "/api/save-config", { UPGRADE_DISMISSED_AT: "", UPGRADE_FROM_V1: { at: "x" } });
  assert.equal(saved.status, 200, "a damaged record never blocks saving settings");
  assert.deepEqual((await api("GET", "/api/upgrade")).json, { show: false, items: [] });
});

test("logs: the error and full log are served, nothing else", async () => {
  for (const kind of ["error", "all"]) {
    const res = await api("GET", `/api/logs/${kind}`);
    assert.equal(res.status, 200, kind);
    assert.ok(Array.isArray(res.json.entries));
  }
  for (const kind of ["other", "constructor", "..%2Fconfig"]) {
    assert.equal((await api("GET", `/api/logs/${kind}`)).status, 404, kind);
  }
});

test("saving never overwrites a config.json that cannot be read", async () => {
  const file = path.join(dataDir, "config.json");
  const good = fs.readFileSync(file, "utf-8");
  const broken = good.replace(/}\s*$/, ",}"); // a hand edit with a trailing comma
  fs.writeFileSync(file, broken);
  try {
    const res = await api("POST", "/api/save-config", { LANGUAGE: "en" });
    assert.equal(res.status, 500);
    assert.equal(fs.readFileSync(file, "utf-8"), broken, "the file is left as it was");
  } finally {
    fs.writeFileSync(file, good);
  }
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
