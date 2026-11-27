// Media requests sent to Seerr and the guest account for unmapped Discord users.
// Every request runs as a Seerr user (x-api-user), never as the API key owner (audit S1-S3).
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { NoSeerrUserError, ensureGuestUser, sendRequest, setGuestAutoApprove } from "../api/seerr.js";
import { getGuestUserId } from "../bot/guestUser.js";
import { readConfig, writeConfig } from "../utils/configFile.js";
import { applyConfig } from "./helpers/config.js";
import { startFakeServer } from "./helpers/http.js";

let seerr;
before(async () => {
  seerr = await startFakeServer({ "POST /api/v1/request": () => ({ status: 201, json: { id: 1 } }) });
});
after(() => seerr.close());

const MAPPINGS = [{ discordUserId: "d-mapped", seerrUserId: 42, seerrDisplayName: "Alice" }];

async function request(options) {
  const before = seerr.requests.length;
  await sendRequest({ seerrUrl: seerr.url, apiKey: "seerr-key", userMappings: MAPPINGS, guestUserId: 77, ...options });
  assert.equal(seerr.requests.length, before + 1);
  return seerr.requests.at(-1);
}

test("mapped user: the request runs as that Seerr user", async () => {
  const req = await request({ tmdbId: "603", mediaType: "movie", discordUserId: "d-mapped" });
  assert.equal(req.headers["x-api-key"], "seerr-key");
  assert.equal(req.headers["x-api-user"], "42");
  assert.deepEqual(req.body, { mediaType: "movie", mediaId: 603 });
});

test("unmapped user: the request runs as the guest account", async () => {
  const req = await request({ tmdbId: "603", mediaType: "movie", discordUserId: "d-stranger" });
  assert.equal(req.headers["x-api-user"], "77");
});

test("the guest resolver is only called for unmapped users", async () => {
  let calls = 0;
  const resolver = async () => (calls++, 77);
  await request({ tmdbId: "1", mediaType: "movie", discordUserId: "d-mapped", guestUserId: resolver });
  assert.equal(calls, 0);
  const req = await request({ tmdbId: "1", mediaType: "movie", discordUserId: "d-stranger", guestUserId: resolver });
  assert.equal(calls, 1);
  assert.equal(req.headers["x-api-user"], "77");
});

test("unmapped user without a guest account: nothing is sent", async () => {
  const before = seerr.requests.length;
  for (const guestUserId of [null, async () => null]) {
    await assert.rejects(
      sendRequest({ seerrUrl: seerr.url, apiKey: "k", tmdbId: "1", mediaType: "movie", discordUserId: "d-stranger", userMappings: MAPPINGS, guestUserId }),
      NoSeerrUserError
    );
  }
  assert.equal(seerr.requests.length, before);
});

test("a link without a valid Seerr user id never runs as Seerr's admin", async () => {
  for (const seerrUserId of ["", "abc", 0, "1; drop"]) {
    const mappings = [{ discordUserId: "d-broken", seerrUserId }];
    const req = await request({ tmdbId: "603", mediaType: "movie", discordUserId: "d-broken", userMappings: mappings });
    assert.equal(req.headers["x-api-user"], "77", `seerrUserId ${JSON.stringify(seerrUserId)} falls back to the guest`);
  }
  await assert.rejects(
    sendRequest({ seerrUrl: seerr.url, apiKey: "k", tmdbId: "1", mediaType: "movie", discordUserId: "d-broken", userMappings: [{ discordUserId: "d-broken", seerrUserId: "" }], guestUserId: "" }),
    NoSeerrUserError
  );
});

test("server and profile are passed through; Seerr decides if the user may pick them", async () => {
  const req = await request({ tmdbId: "603", mediaType: "movie", discordUserId: "d-stranger", serverId: "1", profileId: "7" });
  assert.deepEqual(req.body, { mediaType: "movie", mediaId: 603, serverId: 1, profileId: 7 });
});

test("TV: 'all' requests every season with an empty list", async () => {
  const req = await request({ tmdbId: "1399", mediaType: "tv", seasons: ["all"], discordUserId: "d-mapped" });
  assert.deepEqual(req.body.seasons, []);
});

test("TV: specific seasons, tags and anime flag are sent as numbers", async () => {
  const req = await request({ tmdbId: "1399", mediaType: "tv", seasons: ["1", "3"], tags: ["5"], isAnime: true, discordUserId: "d-mapped" });
  assert.deepEqual(req.body.seasons, [1, 3]);
  assert.deepEqual(req.body.tags, [5]);
  assert.equal(req.body.isAnime, true);
});

test("a Seerr URL that already ends in /api/v1 is not doubled", async () => {
  const before = seerr.requests.length;
  await sendRequest({ seerrUrl: `${seerr.url}/api/v1/`, apiKey: "k", tmdbId: "1", mediaType: "movie", discordUserId: "d-mapped", userMappings: MAPPINGS });
  assert.equal(seerr.requests[before].path, "/api/v1/request");
});

test("a Seerr error is passed to the caller", async () => {
  const failing = await startFakeServer({ "POST /api/v1/request": () => ({ status: 403, json: { message: "quota" } }) });
  await assert.rejects(
    sendRequest({ seerrUrl: failing.url, apiKey: "k", tmdbId: "1", mediaType: "movie", discordUserId: "d-mapped", userMappings: MAPPINGS }),
    (err) => err.response?.status === 403
  );
  await failing.close();
});

// ----- guest account -----

async function fakeUsers(users) {
  const server = await startFakeServer({
    "POST /api/v1/user": ({ body }) => {
      if (users.some((u) => u.email === body.email)) return { status: 409, json: { message: "User already exists with submitted email." } };
      const user = { id: 100 + users.length, ...body };
      users.push(user);
      return { status: 201, json: user };
    },
    "GET /api/v1/user": () => ({ results: users }),
    ...Object.fromEntries([1, 2, 3].map((i) => [`GET /api/v1/user/${100 + i - 1}`, () => users[i - 1] ?? { status: 404, json: {} }])),
    "PUT /api/v1/user/100": ({ body }) => Object.assign(users[0], body),
  });
  return server;
}

test("guest: created with request-only permission and a random password", async (t) => {
  const users = [];
  const server = await fakeUsers(users);
  t.after(() => server.close());

  const id = await ensureGuestUser({ seerrUrl: server.url, apiKey: "k" });
  assert.equal(id, 100);
  const created = server.requests.find((r) => r.method === "POST").body;
  assert.equal(created.username, "Discord (Anchorr)");
  assert.equal(created.email, "discord@anchorr.invalid");
  assert.equal(created.permissions, 32);
  assert.ok(created.password.length >= 24);
});

test("guest: created with auto-approve when Anchorr's auto-approve is on", async (t) => {
  const users = [];
  const server = await fakeUsers(users);
  t.after(() => server.close());
  await ensureGuestUser({ seerrUrl: server.url, apiKey: "k", autoApprove: true });
  assert.equal(users[0].permissions, 160);
});

test("guest: an existing id is kept, a deleted one is replaced, a leftover account is reused", async (t) => {
  const users = [{ id: 100, email: "discord@anchorr.invalid", permissions: 32 }];
  const server = await fakeUsers(users);
  t.after(() => server.close());

  assert.equal(await ensureGuestUser({ seerrUrl: server.url, apiKey: "k", guestUserId: "100" }), 100);
  assert.equal(server.requests.filter((r) => r.method === "POST").length, 0, "existing guest is not recreated");

  // id 101 does not exist; creating hits the leftover account's email, which is reused
  assert.equal(await ensureGuestUser({ seerrUrl: server.url, apiKey: "k", guestUserId: "101" }), 100);
});

test("guest: a saved id that now belongs to a real person is never used", async (t) => {
  // Seerr was reinstalled: id 100 is a person, the old guest account is gone
  const users = [{ id: 100, email: "alice@example.com", permissions: 2 }];
  const server = await fakeUsers(users);
  t.after(() => server.close());

  assert.equal(await ensureGuestUser({ seerrUrl: server.url, apiKey: "k", guestUserId: "100" }), 101, "a new guest is created");
  assert.equal(users[1].email, "discord@anchorr.invalid");

  await assert.rejects(setGuestAutoApprove({ seerrUrl: server.url, apiKey: "k", guestUserId: 100, autoApprove: true }), /not the guest account/);
  assert.equal(users[0].permissions, 2, "the person's permissions are left alone");
  assert.equal(server.requests.filter((r) => r.method === "PUT").length, 0);
});

// getGuestUserId saves the id it finds; later tests must not see it
function forgetSavedGuest() {
  const config = readConfig();
  if (config && "SEERR_GUEST_USER_ID" in config) {
    delete config.SEERR_GUEST_USER_ID;
    writeConfig(config);
  }
}

test("guest: a request checks the saved id against Seerr first", async (t) => {
  t.after(forgetSavedGuest);
  const users = [{ id: 100, email: "alice@example.com", permissions: 2 }];
  const server = await fakeUsers(users);
  t.after(() => server.close());
  t.after(applyConfig({ SEERR_URL: server.url, SEERR_API_KEY: "k", SEERR_GUEST_USER_ID: "100" }));

  assert.equal(await getGuestUserId(), 101, "the person's id is not used for the request");
  assert.equal(await getGuestUserId(), 101, "the new guest is kept");
});

test("guest: when Seerr fails the check, the member hears about Seerr, not about linking", async (t) => {
  const server = await startFakeServer({ "GET /api/v1/user/100": () => ({ status: 500, json: {} }) });
  t.after(() => server.close());
  t.after(applyConfig({ SEERR_URL: server.url, SEERR_API_KEY: "k", SEERR_GUEST_USER_ID: "100" }));

  await assert.rejects(
    sendRequest({ seerrUrl: server.url, apiKey: "k", tmdbId: "1", mediaType: "movie", discordUserId: "d-stranger", userMappings: MAPPINGS, guestUserId: getGuestUserId }),
    (err) => !(err instanceof NoSeerrUserError) && err.response?.status === 500
  );
});

test("guest: the auto-approve switch flips only that permission bit", async (t) => {
  const users = [{ id: 100, email: "discord@anchorr.invalid", permissions: 32 | 1024 }]; // REQUEST + REQUEST_4K
  const server = await fakeUsers(users);
  t.after(() => server.close());

  assert.equal(await setGuestAutoApprove({ seerrUrl: server.url, apiKey: "k", guestUserId: 100, autoApprove: true }), 32 | 1024 | 128);
  assert.equal(users[0].permissions, 32 | 1024 | 128);
  assert.equal(await setGuestAutoApprove({ seerrUrl: server.url, apiKey: "k", guestUserId: 100, autoApprove: false }), 32 | 1024);
});
