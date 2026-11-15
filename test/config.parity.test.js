// Parity net for config storage: on-disk format, v1 key migrations, masking for the dashboard.
// These are the inputs the v2 automatic migration must accept.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { CONFIG_PATH, loadConfigToEnv, readConfig, writeConfig } from "../utils/configFile.js";
import { MASKED_PREFIX, isMaskedValue, sanitizeConfigForClient } from "../utils/configSanitize.js";
import { normalizeSeerrUrl } from "../utils/seerrUrl.js";
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

  assert.equal(loadConfigToEnv(), true);
  const migrated = readConfig();

  // v1 renames the key after normalizing, so the suffix survives on disk; every caller
  // normalizes again, which is what matters. v2 migration should store it clean.
  assert.equal(normalizeSeerrUrl(migrated.SEERR_URL), "http://seerr.example.com");
  assert.equal(migrated.SEERR_API_KEY, "old-key");
  assert.equal(migrated.SEERR_AUTO_APPROVE, "true");
  assert.equal(migrated.JELLYSEERR_URL, undefined);
  assert.deepEqual(migrated.JELLYFIN_NOTIFICATION_LIBRARIES, { "lib-a": "chan-default", "lib-b": "chan-default" });
  assert.deepEqual(migrated.USER_MAPPINGS, [{ discordUserId: "d1", seerrUserId: 5, seerrDisplayName: "Bob" }]);
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
