// Parity net for config storage: on-disk format, v1 key migrations, masking for the dashboard.
// These are the inputs the v2 automatic migration must accept.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CONFIG_PATH, loadSettings, readConfig, writeConfig } from "../utils/configFile.js";
import { MASKED_PREFIX, isMaskedValue, sanitizeConfigForClient } from "../utils/configSanitize.js";
import { normalizeSeerrUrl } from "../utils/seerrUrl.js";
import { settings } from "../utils/settings.js";
import { configSchema } from "../utils/validation.js";

test("config lives in ANCHORR_CONFIG_DIR during tests", () => {
  assert.ok(CONFIG_PATH.startsWith(process.env.ANCHORR_CONFIG_DIR));
});

test("secrets are base64-encoded on disk and decoded on read", () => {
  assert.equal(writeConfig({ DISCORD_TOKEN: "token-123", LANGUAGE: "en" }), true);
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  assert.equal(raw.DISCORD_TOKEN, `b64:${Buffer.from("token-123").toString("base64")}`);
  assert.equal(raw.LANGUAGE, "en");
  assert.equal(readConfig().DISCORD_TOKEN, "token-123");
});

test("loading a v1 config migrates legacy keys and formats", () => {
  writeConfig({
    JELLYSEERR_URL: "http://seerr.example.com/api/v1/",
    JELLYSEERR_API_KEY: "old-key",
    JELLYSEERR_AUTO_APPROVE: "true",
    JELLYFIN_CHANNEL_ID: "chan-default",
    JELLYFIN_NOTIFICATION_LIBRARIES: ["lib-a", "lib-b"],
    USER_MAPPINGS: [{ discordUserId: "d1", jellyseerrUserId: 5, jellyseerrDisplayName: "Bob" }],
  });

  assert.equal(loadSettings(), true);
  const migrated = readConfig();

  assert.equal(migrated.SEERR_URL, "http://seerr.example.com", "legacy URL is stored clean");
  assert.equal(normalizeSeerrUrl(migrated.SEERR_URL), "http://seerr.example.com");
  assert.equal(migrated.SEERR_API_KEY, "old-key");
  assert.equal(migrated.SEERR_AUTO_APPROVE, "true");
  assert.equal(migrated.JELLYSEERR_URL, undefined);
  assert.deepEqual(migrated.JELLYFIN_NOTIFICATION_LIBRARIES, { "lib-a": "chan-default", "lib-b": "chan-default" });
  assert.deepEqual(migrated.USER_MAPPINGS, [{ discordUserId: "d1", seerrUserId: 5, seerrDisplayName: "Bob" }]);
});

test("loaded config is readable through settings but never leaks into process.env (audit S5)", () => {
  writeConfig({ SEERR_URL: "http://seerr.local", NODE_TLS_REJECT_UNAUTHORIZED: "0", TRUST_PROXY: "true" });
  assert.equal(loadSettings(), true);
  assert.equal(settings.SEERR_URL, "http://seerr.local");
  assert.equal(process.env.SEERR_URL, undefined);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(settings.TRUST_PROXY, process.env.TRUST_PROXY, "deployment keys come from the environment only");
});

test("writing config refreshes settings without a reload", () => {
  writeConfig({ LANGUAGE: "sv" });
  assert.equal(settings.LANGUAGE, "sv");
  assert.equal(settings.SEERR_URL, process.env.SEERR_URL, "keys removed from config fall back to the environment");
});

test("dashboard sees masked secrets and never the internal secrets or password hashes", () => {
  const client = sanitizeConfigForClient({
    DISCORD_TOKEN: "abcdefgh1234",
    SEERR_API_KEY: "xyz",
    JWT_SECRET: "jwt",
    WEBHOOK_SECRET: "hook",
    USERS: [{ id: 1, username: "admin", password: "$2a$hash" }],
  });
  assert.equal(client.DISCORD_TOKEN, `${MASKED_PREFIX}1234`);
  assert.equal(client.SEERR_API_KEY, MASKED_PREFIX);
  assert.equal(isMaskedValue(client.DISCORD_TOKEN), true);
  assert.equal("JWT_SECRET" in client, false);
  assert.equal("WEBHOOK_SECRET" in client, false);
  assert.deepEqual(client.USERS, [{ id: 1, username: "admin" }]);
});

test("schema accepts both library formats and rejects a malformed URL", () => {
  const ok = (value) => !configSchema.validate(value, { allowUnknown: true }).error;
  assert.equal(ok({ JELLYFIN_NOTIFICATION_LIBRARIES: { lib: { channel: "c", isAnime: true } } }), true);
  assert.equal(ok({ JELLYFIN_NOTIFICATION_LIBRARIES: { lib: "c" } }), true);
  assert.equal(ok({ SEERR_URL: "not a url" }), false);
});

test("v1 config upgrades to format v2: TMDB/OMDb keys removed, original kept as config.v1.json", () => {
  const backup = path.join(path.dirname(CONFIG_PATH), "config.v1.json");
  fs.rmSync(backup, { force: true });
  writeConfig({ SEERR_URL: "http://seerr.local", TMDB_API_KEY: "tmdb-secret", OMDB_API_KEY: "", HEADER_VISIBLE: "true", startBot: true, LIBRARY_SEEDED: "true" });

  assert.equal(loadSettings(), true);
  const upgraded = readConfig();
  assert.equal(upgraded.CONFIG_VERSION, 2);
  for (const key of ["TMDB_API_KEY", "OMDB_API_KEY", "HEADER_VISIBLE", "startBot", "LIBRARY_SEEDED"]) {
    assert.equal(key in upgraded, false, `${key} removed`);
  }
  assert.equal(upgraded.SEERR_URL, "http://seerr.local");
  assert.equal(JSON.parse(fs.readFileSync(backup, "utf8")).TMDB_API_KEY, "tmdb-secret", "v1 file kept as is");

  // already upgraded: no second backup, nothing removed
  writeConfig({ ...upgraded, LANGUAGE: "de" });
  fs.rmSync(backup);
  assert.equal(loadSettings(), true);
  assert.equal(fs.existsSync(backup), false);
  assert.equal(readConfig().LANGUAGE, "de");
});

test("a fresh v2 config gets its version without a pointless backup", () => {
  const backup = path.join(path.dirname(CONFIG_PATH), "config.v1.json");
  fs.rmSync(backup, { force: true });
  writeConfig({ SEERR_URL: "http://seerr.local" });
  assert.equal(loadSettings(), true);
  assert.equal(readConfig().CONFIG_VERSION, 2);
  assert.equal(fs.existsSync(backup), false);
});
