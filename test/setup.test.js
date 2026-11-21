// First-run setup and dashboard sign-in through Jellyfin, against fake Jellyfin and Seerr
// servers and the real app.js. Passwords only travel to Jellyfin/Seerr.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { isAdminApiKey } from "../api/jellyfinAdmin.js";
import { startApp } from "./helpers/app.js";
import { startFakeServer } from "./helpers/http.js";

const USERS = {
  admin: { password: "admin-pw", token: "tok-admin", user: { Id: "u-admin", Name: "admin", Policy: { IsAdministrator: true } } },
  viewer: { password: "viewer-pw", token: "tok-viewer", user: { Id: "u-viewer", Name: "viewer", Policy: { IsAdministrator: false } } },
};
const ADMIN_TOKENS = new Set(["tok-admin"]);
const keys = [];
const tokenOf = (headers) => /Token="([^"]+)"/.exec(headers.authorization || "")?.[1];

let jellyfin;
let seerr;
let discord;
let app;

before(async () => {
  jellyfin = await startFakeServer({
    "GET /System/Info/Public": () => ({ ServerName: "Home", Version: "12.4.0", Id: "srv-1" }),
    "POST /Users/AuthenticateByName": ({ body }) => {
      const account = USERS[body.Username];
      if (!account || account.password !== body.Pw) return { status: 401, json: {} };
      return { AccessToken: account.token, User: account.user, ServerId: "srv-1" };
    },
    "GET /Auth/Keys": ({ headers }) => {
      const token = tokenOf(headers);
      if (!ADMIN_TOKENS.has(token) && !keys.some((k) => k.AccessToken === token)) return { status: 401, json: {} };
      return { Items: keys };
    },
    "POST /Auth/Keys": ({ url, headers }) => {
      if (!ADMIN_TOKENS.has(tokenOf(headers))) return { status: 403, json: {} };
      // Real Jellyfin lists every API key with IsActive: false
      keys.push({ AppName: url.searchParams.get("app"), AccessToken: `jf-key-${keys.length + 1}`, IsActive: false, DateCreated: new Date().toISOString() });
      return { status: 204 };
    },
    "POST /Sessions/Logout": () => ({ status: 204 }),
  });
  seerr = await startFakeServer({
    "POST /api/v1/auth/jellyfin": ({ body }) =>
      body.username === "admin" && body.password === "admin-pw"
        ? { json: { id: 1 }, headers: { "set-cookie": "connect.sid=s1; Path=/; HttpOnly" } }
        : { status: 401, json: { message: "Unauthorized" } },
    "GET /api/v1/settings/main": ({ headers }) =>
      headers.cookie === "connect.sid=s1" ? { apiKey: "seerr-key" } : { status: 403, json: {} },
    "POST /api/v1/auth/logout": () => ({ status: 200, json: {} }),
    "GET /api/v1/settings/about": ({ headers }) =>
      headers["x-api-key"] === "seerr-key" ? { version: "3.5.2" } : { status: 403, json: {} },
    "POST /api/v1/user": () => ({ status: 201, json: { id: 900 } }),
    "GET /api/v1/user/900": () => ({ id: 900, permissions: 32 }),
  });
  discord = await startFakeServer({
    "GET /users/@me": ({ headers }) => (headers.authorization === "Bot good-token" ? { id: "bot-1", username: "Anchorr" } : { status: 401, json: {} }),
    "GET /applications/@me": () => ({ flags: 1 << 15 }),
    "GET /users/@me/guilds": () => [{ id: "g1", name: "Home" }],
  });
  app = await startApp({ DISCORD_API_URL: discord.url });
});
after(async () => {
  app?.stop();
  await jellyfin?.close();
  await seerr?.close();
  await discord?.close();
});

const post = (url, body, opts) => app.call("POST", url, body, opts);
const get = (url, opts) => app.call("GET", url, undefined, opts);
const posts = (server, path) => server.requests.filter((r) => r.method === "POST" && r.path === path).length;

test("fresh install: setup needed, nothing can be claimed without Jellyfin", async () => {
  assert.deepEqual((await get("/api/setup/state")).json, { needsSetup: true, jellyfin: false, seerr: false, discord: false, discordServer: false, localAccount: false });
  const check = (await get("/api/auth/check")).json;
  assert.equal(check.needsSetup, true);
  assert.equal(check.jellyfinLogin, false);

  assert.equal((await post("/api/auth/register", { username: "x", password: "y" })).status, 401, "no anonymous local account (S4)");
  assert.equal((await post("/api/setup/seerr", { url: seerr.url, apiKey: "seerr-key" })).status, 401);
});

test("Jellyfin step: wrong password and non-admin accounts are refused and claim nothing", async () => {
  const wrong = await post("/api/setup/jellyfin", { url: jellyfin.url, username: "admin", password: "nope" });
  assert.equal(wrong.status, 401);
  const viewer = await post("/api/setup/jellyfin", { url: jellyfin.url, username: "viewer", password: "viewer-pw" });
  assert.equal(viewer.status, 403);
  assert.equal((await get("/api/setup/state")).json.needsSetup, true);
  assert.equal(keys.length, 0);
});

test("Jellyfin step: an admin sign-in creates the Anchorr API key and signs into the dashboard", async () => {
  const logoutsBefore = posts(jellyfin, "/Sessions/Logout");
  const res = await post("/api/setup/jellyfin", { url: `${jellyfin.url}/`, username: "admin", password: "admin-pw" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { success: true, serverName: "Home", version: "12.4.0", signedIn: true });
  assert.ok(res.token, "session cookie issued");
  app.cookie = res.token;

  assert.deepEqual(keys.map((k) => k.AppName), ["Anchorr"]);
  assert.equal(posts(jellyfin, "/Sessions/Logout"), logoutsBefore + 1, "the Jellyfin session is closed again");
  const state = (await get("/api/setup/state")).json;
  assert.equal(state.needsSetup, false);
  assert.equal(state.jellyfin, true);
  assert.equal((await get("/api/config")).json.JELLYFIN_API_KEY, "••••••••ey-1", "stored key, masked");
});

test("after setup the Jellyfin step needs a session, and re-linking reuses the key", async () => {
  assert.equal((await post("/api/setup/jellyfin", { url: jellyfin.url, username: "admin", password: "admin-pw" }, { auth: false })).status, 401);
  const again = await post("/api/setup/jellyfin", { url: jellyfin.url, username: "admin", password: "admin-pw" });
  assert.equal(again.status, 200);
  assert.equal(again.json.signedIn, false);
  assert.equal(keys.length, 1, "no second Anchorr key");

  // A newer Anchorr key (for example a leftover) must not replace the one in config
  keys.push({ AppName: "Anchorr", AccessToken: "jf-key-newer", IsActive: false, DateCreated: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await post("/api/setup/jellyfin", { url: jellyfin.url, username: "admin", password: "admin-pw" })).status, 200);
  assert.equal((await get("/api/config")).json.JELLYFIN_API_KEY, "••••••••ey-1", "config keeps its key");
  keys.pop();
});

test("Seerr step: the Jellyfin admin account reads Seerr's key, then the guest account is created", async () => {
  const bad = await post("/api/setup/seerr", { url: seerr.url, username: "admin", password: "nope" });
  assert.equal(bad.status, 401);

  const res = await post("/api/setup/seerr", { url: `${seerr.url}/api/v1`, username: "admin", password: "admin-pw" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { success: true, version: "3.5.2", guestAccount: true });
  assert.equal(posts(seerr, "/api/v1/auth/logout"), 1, "the Seerr session is closed again");

  const config = (await get("/api/config")).json;
  assert.equal(config.SEERR_URL, seerr.url);
  assert.equal(config.SEERR_API_KEY, "••••••••-key");
  assert.equal(config.SEERR_GUEST_USER_ID, "900");
});

test("Seerr step: a Seerr that has not finished its own setup is named as such", async (t) => {
  const fresh = await startFakeServer({
    "GET /api/v1/settings/public": () => ({ initialized: false }),
    "GET /api/v1/settings/about": () => ({ status: 500, json: { message: "Server not initialized" } }),
  });
  t.after(() => fresh.close());
  const res = await post("/api/setup/seerr", { url: fresh.url, apiKey: "any-key" });
  assert.equal(res.status, 409);
  assert.equal(res.json.message, "Seerr is not set up yet. Finish its own setup first, then try again");
});

test("dashboard sign-in with Jellyfin: admins only", async () => {
  assert.equal((await post("/api/auth/jellyfin", { username: "admin", password: "nope" }, { auth: false })).status, 401);
  assert.equal((await post("/api/auth/jellyfin", { username: "viewer", password: "viewer-pw" }, { auth: false })).status, 403);
  const ok = await post("/api/auth/jellyfin", { username: "admin", password: "admin-pw" }, { auth: false });
  assert.equal(ok.status, 200);
  assert.ok(ok.token);
  assert.equal((await get("/api/auth/check", { auth: false, headers: { cookie: ok.token } })).json.isAuthenticated, true);
});

test("a local account can be added from a signed-in session, once", async () => {
  assert.equal((await post("/api/auth/register", { username: "owner", password: "local-pw" })).status, 200);
  assert.equal((await post("/api/auth/register", { username: "second", password: "x" })).status, 403);
  const local = await post("/api/auth/login", { username: "owner", password: "local-pw" }, { auth: false });
  assert.equal(local.status, 200);
  assert.equal((await get("/api/setup/state")).json.localAccount, true);
});

test("a pasted Jellyfin key is accepted only if it is an administrator key", async () => {
  assert.equal(await isAdminApiKey(jellyfin.url, "jf-key-1"), true);
  assert.equal(await isAdminApiKey(jellyfin.url, "random-key"), false);
});

test("Discord step: the token is checked with Discord, the bot id and invite link come from it", async () => {
  assert.equal((await post("/api/setup/discord", { token: "bad-token" })).status, 401);

  const res = await post("/api/setup/discord", { token: " good-token " });
  assert.equal(res.status, 200);
  assert.equal(res.json.botName, "Anchorr");
  assert.equal(res.json.membersIntent, true);
  assert.deepEqual(res.json.guilds, [{ id: "g1", name: "Home" }]);
  assert.equal(
    res.json.inviteUrl,
    "https://discord.com/oauth2/authorize?client_id=bot-1&scope=bot%20applications.commands&permissions=274877926400"
  );

  const config = (await get("/api/config")).json;
  assert.equal(config.BOT_ID, "bot-1");
  assert.equal(config.DISCORD_TOKEN, "••••••••oken");
  assert.equal((await post("/api/setup/discord", { token: config.DISCORD_TOKEN })).status, 200, "the masked token means: keep the saved one");
});

test("Discord step: only a server the bot has joined can be picked", async () => {
  assert.equal((await post("/api/setup/discord/server", { guildId: "other" })).status, 400);
  const res = await post("/api/setup/discord/server", { guildId: "g1" });
  // the bot cannot really connect in tests; the choice is saved either way
  assert.ok([200, 502].includes(res.status));
  assert.equal((await get("/api/config")).json.GUILD_ID, "g1");
  assert.equal((await get("/api/setup/state")).json.discordServer, true);
});
