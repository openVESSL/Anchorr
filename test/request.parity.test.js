// Parity net for media requests sent to Seerr: payload and headers seen by a fake Seerr.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { sendRequest } from "../api/seerr.js";
import { startFakeServer } from "./helpers/http.js";

let seerr;
before(async () => {
  seerr = await startFakeServer({ "POST /api/v1/request": () => ({ status: 201, json: { id: 1 } }) });
});
after(() => seerr.close());

const MAPPINGS = [{ discordUserId: "d-mapped", seerrUserId: 42, seerrDisplayName: "Alice" }];

async function request(options) {
  const before = seerr.requests.length;
  await sendRequest({ seerrUrl: seerr.url, apiKey: "seerr-key", userMappings: MAPPINGS, ...options });
  assert.equal(seerr.requests.length, before + 1);
  return seerr.requests.at(-1);
}

test("mapped user, auto-approve off: request runs as that user and stays pending", async () => {
  const req = await request({ tmdbId: "603", mediaType: "movie", discordUserId: "d-mapped", isAutoApproved: false });
  assert.equal(req.headers["x-api-key"], "seerr-key");
  assert.equal(req.headers["x-api-user"], "42");
  assert.deepEqual(req.body, { mediaType: "movie", mediaId: 603, isAutoApproved: false });
});

test("mapped user, auto-approve on: runs as the API key owner, attributed via userId", async () => {
  const req = await request({
    tmdbId: "603",
    mediaType: "movie",
    discordUserId: "d-mapped",
    isAutoApproved: true,
    serverId: "1",
    profileId: "7",
  });
  assert.equal(req.headers["x-api-user"], undefined);
  assert.deepEqual(req.body, {
    mediaType: "movie",
    mediaId: 603,
    isAutoApproved: true,
    serverId: 1,
    profileId: 7,
    userId: 42,
  });
});

// v1 behavior, replaced in v2 by the "Discord (Anchorr)" guest user (audit S1).
test("v1: unmapped user requests as the API key owner", async () => {
  const req = await request({ tmdbId: "603", mediaType: "movie", discordUserId: "d-stranger", isAutoApproved: false });
  assert.equal(req.headers["x-api-user"], undefined);
  assert.equal(req.body.userId, undefined);
});

test("TV: 'all' requests every season with an empty list", async () => {
  const req = await request({ tmdbId: "1399", mediaType: "tv", seasons: ["all"], discordUserId: "d-mapped", isAutoApproved: false });
  assert.deepEqual(req.body.seasons, []);
});

test("TV: specific seasons, tags and anime flag are sent as numbers", async () => {
  const req = await request({
    tmdbId: "1399",
    mediaType: "tv",
    seasons: ["1", "3"],
    tags: ["5"],
    isAnime: true,
    discordUserId: "d-mapped",
    isAutoApproved: false,
  });
  assert.deepEqual(req.body.seasons, [1, 3]);
  assert.deepEqual(req.body.tags, [5]);
  assert.equal(req.body.isAnime, true);
});

test("a Seerr URL that already ends in /api/v1 is not doubled", async () => {
  const before = seerr.requests.length;
  await sendRequest({ seerrUrl: `${seerr.url}/api/v1/`, apiKey: "k", tmdbId: "1", mediaType: "movie", isAutoApproved: false });
  assert.equal(seerr.requests[before].path, "/api/v1/request");
});

test("a Seerr error is passed to the caller", async () => {
  const failing = await startFakeServer({ "POST /api/v1/request": () => ({ status: 403, json: { message: "quota" } }) });
  await assert.rejects(
    sendRequest({ seerrUrl: failing.url, apiKey: "k", tmdbId: "1", mediaType: "movie", isAutoApproved: false }),
    (err) => err.response?.status === 403
  );
  await failing.close();
});
