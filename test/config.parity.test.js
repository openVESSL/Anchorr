// Parity net for config storage: on-disk format, v1 key migrations, masking for the dashboard.
// These are the inputs the v2 automatic migration must accept.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CONFIG_PATH, MigrationBackupError, loadSettings, readConfig, writeConfig } from "../utils/configFile.js";
import { MASKED_PREFIX, isMaskedValue, sanitizeConfigForClient } from "../utils/configSanitize.js";
import { normalizeSeerrUrl } from "../utils/seerrUrl.js";
import logger from "../utils/logger.js";
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

test("the Detailed logs switch in config.json sets the log level", () => {
  writeConfig({ DEBUG: "true" });
  assert.equal(logger.level, "debug");
  writeConfig({ DEBUG: "false" });
  assert.equal(logger.level, "info");
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

const CONFIG_DIR = path.dirname(CONFIG_PATH);
const BACKUP_DIR = path.join(CONFIG_DIR, "backup-1.x");

// A 1.x config folder: config.json in the old format plus state files next to it
function writeV1Folder(extra = {}) {
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  writeConfig({
    JELLYSEERR_URL: "http://seerr.local/api/v1",
    JELLYSEERR_AUTO_APPROVE: "true",
    TMDB_API_KEY: "tmdb-secret",
    OMDB_API_KEY: "",
    HEADER_VISIBLE: "true",
    startBot: true,
    LIBRARY_SEEDED: "true",
    USER_MAPPINGS: [{ discordUserId: "1", jellyseerrUserId: 2 }, { discordUserId: "3", jellyseerrUserId: 4 }],
    ...extra,
  });
  fs.writeFileSync(path.join(CONFIG_DIR, "dedup-seen-items.json"), '{"seen":["a"]}');
  fs.writeFileSync(path.join(CONFIG_DIR, "pending-requests.json"), '{"603-movie":["1"]}');
  return Object.fromEntries(
    ["config.json", "dedup-seen-items.json", "pending-requests.json"].map((f) => [f, fs.readFileSync(path.join(CONFIG_DIR, f))])
  );
}

test("v1 config upgrades to format v2 after the whole folder is backed up untouched", () => {
  const before = writeV1Folder();

  assert.equal(loadSettings(), true);
  for (const [file, bytes] of Object.entries(before)) {
    assert.deepEqual(fs.readFileSync(path.join(BACKUP_DIR, file)), bytes, `${file} backed up as it was in 1.x`);
  }
  assert.equal(fs.existsSync(path.join(CONFIG_DIR, "config.v1.json")), false, "one backup place only");

  const upgraded = readConfig();
  assert.equal(upgraded.CONFIG_VERSION, 2);
  for (const key of ["TMDB_API_KEY", "OMDB_API_KEY", "HEADER_VISIBLE", "startBot", "LIBRARY_SEEDED"]) {
    assert.equal(key in upgraded, false, `${key} removed`);
  }
  assert.equal(upgraded.SEERR_URL, "http://seerr.local");
  assert.equal(fs.existsSync(path.join(CONFIG_DIR, "dedup-seen-items.json")), false);
  assert.deepEqual(
    { autoApprove: upgraded.UPGRADE_FROM_V1.autoApprove, mappings: upgraded.UPGRADE_FROM_V1.mappings },
    { autoApprove: true, mappings: 2 },
    "what 1.x had, read before the key renames"
  );
  assert.ok(Date.parse(upgraded.UPGRADE_FROM_V1.at));
});

test("an existing backup and upgrade record are never overwritten", () => {
  writeV1Folder();
  assert.equal(loadSettings(), true);
  const record = readConfig().UPGRADE_FROM_V1;
  const backedUp = fs.readFileSync(path.join(BACKUP_DIR, "config.json"));

  // a later start, and a v1 backup restored later on
  assert.equal(loadSettings(), true);
  writeConfig({ ...readConfig(), CONFIG_VERSION: undefined, TMDB_API_KEY: "other", SEERR_AUTO_APPROVE: "false" });
  assert.equal(loadSettings(), true);
  assert.deepEqual(fs.readFileSync(path.join(BACKUP_DIR, "config.json")), backedUp);
  assert.deepEqual(readConfig().UPGRADE_FROM_V1, record);
});

test("a fresh v2 config gets its version without a backup or upgrade record", () => {
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  writeConfig({ SEERR_URL: "http://seerr.local" });
  assert.equal(loadSettings(), true);
  assert.equal(readConfig().CONFIG_VERSION, 2);
  assert.equal("UPGRADE_FROM_V1" in readConfig(), false);
  assert.equal(fs.existsSync(BACKUP_DIR), false);
});

test("if the 1.x folder cannot be backed up, nothing is changed and loading stops", (t) => {
  const before = writeV1Folder();
  t.mock.method(logger, "error", () => {});
  fs.chmodSync(CONFIG_DIR, 0o500); // readable, not writable
  t.after(() => fs.chmodSync(CONFIG_DIR, 0o700));

  assert.throws(() => loadSettings(), MigrationBackupError);
  fs.chmodSync(CONFIG_DIR, 0o700);
  assert.deepEqual(fs.readFileSync(CONFIG_PATH), before["config.json"], "config.json untouched");
  assert.equal(fs.existsSync(BACKUP_DIR), false, "no half-written backup left behind");
});

test("Anchorr does not start when the 1.x folder cannot be backed up", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anchorr-v1-"));
  const v1 = { TMDB_API_KEY: "", SEERR_URL: "http://seerr.local", JWT_SECRET: "j".repeat(64), WEBHOOK_SECRET: "w".repeat(64) };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(v1));
  const unreadable = path.join(dir, "pending-requests.json");
  fs.writeFileSync(unreadable, "{}");
  fs.chmodSync(unreadable, 0o000); // the copy fails halfway through the folder
  try {
    const run = spawnSync(process.execPath, ["app.js"], {
      env: { ...process.env, ANCHORR_CONFIG_DIR: dir, NODE_ENV: "production", AUTO_START_BOT: "false", WEBHOOK_PORT: "0" },
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(run.status, 1, "exits instead of serving the setup wizard");
    assert.match(run.stdout + run.stderr, /Could not back up the 1\.x configuration/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")), v1, "config.json untouched");
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("backup-1.x")), [], "no half-written backup");
  } finally {
    fs.chmodSync(unreadable, 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
