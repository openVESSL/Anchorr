// Parity net for role allowlist/blocklist checks applied to every bot interaction.
import assert from "node:assert/strict";
import test from "node:test";

import { checkRolePermission } from "../bot/botUtils.js";
import { applyConfig } from "./helpers/config.js";

const GUILD = "guild-1";
const member = (...roleIds) => ({ roles: { cache: roleIds.map((id) => ({ id })) } });

function configure(t, values) {
  t.after(applyConfig({ GUILD_ID: GUILD, ROLE_ALLOWLIST: undefined, ROLE_BLOCKLIST: undefined, ...values }));
}

test("no role lists: everyone is allowed, including DMs", (t) => {
  configure(t, {});
  assert.equal(checkRolePermission(member("any"), GUILD), true);
  assert.equal(checkRolePermission(null, null), true);
});

test("allowlist: only members with a listed role pass", (t) => {
  configure(t, { ROLE_ALLOWLIST: ["vip"] });
  assert.equal(checkRolePermission(member("vip", "x"), GUILD), true);
  assert.equal(checkRolePermission(member("x"), GUILD), false);
});

test("blocklist: members with a listed role are denied", (t) => {
  configure(t, { ROLE_BLOCKLIST: ["muted"] });
  assert.equal(checkRolePermission(member("x"), GUILD), true);
  assert.equal(checkRolePermission(member("x", "muted"), GUILD), false);
});

test("allowlist and blocklist combine: blocklist wins", (t) => {
  configure(t, { ROLE_ALLOWLIST: ["vip"], ROLE_BLOCKLIST: ["muted"] });
  assert.equal(checkRolePermission(member("vip", "muted"), GUILD), false);
});

test("with role lists, DMs and other guilds are denied", (t) => {
  configure(t, { ROLE_ALLOWLIST: ["vip"] });
  assert.equal(checkRolePermission(null, null), false);
  assert.equal(checkRolePermission(member("vip"), "other-guild"), false);
});

test("with role lists but no GUILD_ID, everything is denied", (t) => {
  configure(t, { ROLE_ALLOWLIST: ["vip"], GUILD_ID: "" });
  assert.equal(checkRolePermission(member("vip"), GUILD), false);
});

test("a malformed role list fails closed", (t) => {
  t.after(applyConfig({ GUILD_ID: GUILD, ROLE_BLOCKLIST: undefined }));
  process.env.ROLE_ALLOWLIST = "{not json";
  t.after(() => delete process.env.ROLE_ALLOWLIST);
  assert.equal(checkRolePermission(member("vip"), GUILD), false);
});
