// Parity net for the dashboard HTTP API. Starts the real app.js in a child process
// (temp data dir, free port, bot auto-start off, network guard) and talks to it over HTTP.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

let child;
let base;
before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "./test/setup.js", "app.js"], {
    cwd: ROOT,
    env: { ...process.env, WEBHOOK_PORT: String(port), BIND_HOST: "127.0.0.1", AUTO_START_BOT: "false", LIBRARY_SEEDED: "true" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("app.js did not start");
});
after(() => child?.kill());

let cookie = "";
async function api(method, url, body, { auth = true, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(auth && cookie && { cookie }),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}
const tokenFrom = (setCookie) => setCookie?.match(/auth_token=[^;]+/)?.[0];

// Tests run in order: first-run setup, then authenticated use.

test("health is public", async () => {
  const res = await api("GET", "/api/health", undefined, { auth: false });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "healthy");
});

test("config endpoints need a session", async () => {
  assert.equal((await api("GET", "/api/config", undefined, { auth: false })).status, 401);
  assert.equal((await api("POST", "/api/save-config", {}, { auth: false })).status, 401);
});

test("first run: no users yet, the first registration becomes the admin and is logged in", async () => {
  const check = await api("GET", "/api/auth/check", undefined, { auth: false });
  assert.deepEqual(check.json, { isAuthenticated: false, hasUsers: false });

  const reg = await api("POST", "/api/auth/register", { username: "admin", password: "correct horse" }, { auth: false });
  assert.equal(reg.status, 200);
  assert.match(reg.setCookie, /auth_token=/);
  assert.match(reg.setCookie, /HttpOnly/i);
  assert.match(reg.setCookie, /SameSite=Strict/i);

  const second = await api("POST", "/api/auth/register", { username: "other", password: "x" }, { auth: false });
  assert.equal(second.status, 403);
});

test("login: wrong password is rejected, right password sets the session cookie", async () => {
  const bad = await api("POST", "/api/auth/login", { username: "admin", password: "nope" }, { auth: false });
  assert.equal(bad.status, 401);

  const good = await api("POST", "/api/auth/login", { username: "admin", password: "correct horse" }, { auth: false });
  assert.equal(good.status, 200);
  cookie = tokenFrom(good.setCookie);
  assert.ok(cookie);
  assert.equal((await api("GET", "/api/auth/check")).json.isAuthenticated, true);
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

test("v1: the Jellyfin webhook rejects calls without the shared secret", async () => {
  const res = await api("POST", "/jellyfin-webhook", { ItemId: "x", ItemType: "Movie" }, { auth: false });
  assert.equal(res.status, 401);
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
