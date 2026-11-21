// Upgrade checklist items for installs migrated from 1.x.
import assert from "node:assert/strict";
import test from "node:test";

import { upgradeChecklist } from "../routes/upgradeRoutes.js";

const base = { record: { autoApprove: false, mappings: 0 }, values: {}, legacyWebhookSeen: false, timeZone: "Europe/Berlin", backupDir: "/config/backup-1.x", backupExists: true };
const item = (id, overrides) => upgradeChecklist({ ...base, ...overrides }).find((i) => i.id === id);

test("Jellyfin without an API key is the critical open item", () => {
  assert.deepEqual(item("jellyfin_linked", { values: { JELLYFIN_BASE_URL: "http://jf" } }), { id: "jellyfin_linked", severity: "critical", state: "todo" });
  assert.equal(item("jellyfin_linked", { values: { JELLYFIN_BASE_URL: "http://jf", JELLYFIN_API_KEY: "k" } }).state, "done");
});

test("auto-approve is only mentioned when 1.x auto-approved linked members", () => {
  assert.equal(item("auto_approve", { record: { autoApprove: true, mappings: 0 } }), undefined);
  assert.equal(item("auto_approve", { record: { autoApprove: false, mappings: 3 } }), undefined);
  assert.equal(item("auto_approve", { record: { autoApprove: true, mappings: 3 } }).state, "manual");
  assert.equal(item("auto_approve", { record: { autoApprove: true, mappings: null } }).state, "manual", "unreadable mappings");
});

test("the guest account links to its Seerr settings, or is open until it exists", () => {
  const seerr = { SEERR_URL: "http://seerr.lan/", SEERR_API_KEY: "k" };
  assert.equal(item("guest_limits", {}), undefined, "no Seerr, no item");
  assert.equal(item("guest_limits", { values: seerr }).state, "todo");
  assert.deepEqual(item("guest_limits", { values: { ...seerr, SEERR_GUEST_USER_ID: "12" } }), {
    id: "guest_limits",
    severity: "important",
    state: "manual",
    link: "http://seerr.lan/users/12/settings",
  });
  const unsafe = item("guest_limits", { values: { SEERR_URL: "javascript:alert(1)//", SEERR_API_KEY: "k", SEERR_GUEST_USER_ID: "12" } });
  assert.equal("link" in unsafe, false, "only http(s) Seerr addresses become links");
});

test("the time zone only matters with the weekly roundup on, and UTC is flagged", () => {
  const roundup = { WEEKLY_ROUNDUP_ENABLED: "true" };
  assert.equal(item("time_zone", { timeZone: "UTC" }), undefined);
  assert.equal(item("time_zone", { values: roundup, timeZone: "Etc/UTC" }).state, "todo");
  assert.equal(item("time_zone", { values: roundup, timeZone: "Europe/Berlin" }).state, "done");
});

test("the Webhook plugin item follows the last call, backup and removed keys are always listed", () => {
  assert.equal(item("webhook_plugin", {}).state, "done");
  assert.equal(item("webhook_plugin", { legacyWebhookSeen: true }).state, "todo");
  assert.equal(item("backup", {}).path, "/config/backup-1.x");
  assert.equal(item("backup", { backupExists: false }).exists, false);
  assert.equal(item("removed_keys", {}).state, "info");
});
