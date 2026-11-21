import assert from "node:assert/strict";
import test from "node:test";

import { buildJellyfinUrl } from "../utils/jellyfinUrl.js";
import { replaceSettings } from "../utils/settings.js";
import { configSchema } from "../utils/validation.js";

test("links in Discord use the public Jellyfin address when one is set", () => {
  replaceSettings({ JELLYFIN_BASE_URL: "http://192.168.1.10:8096" });
  assert.equal(buildJellyfinUrl("web/index.html"), "http://192.168.1.10:8096/web/index.html");

  replaceSettings({ JELLYFIN_BASE_URL: "http://192.168.1.10:8096", JELLYFIN_PUBLIC_URL: "https://media.example.com/jellyfin" });
  assert.equal(
    buildJellyfinUrl("web/index.html", "!/details?id=abc"),
    "https://media.example.com/jellyfin/web/index.html#!/details?id=abc"
  );
  replaceSettings({});
});

test("the public Jellyfin address must be empty or http(s)", () => {
  for (const ok of ["", "https://media.example.com", "http://jf.example.com:8096/jellyfin"]) {
    assert.equal(configSchema.validate({ JELLYFIN_PUBLIC_URL: ok }).error, undefined, ok);
  }
  for (const bad of ["javascript:alert(1)", "ftp://media.example.com", "media.example.com"]) {
    assert.ok(configSchema.validate({ JELLYFIN_PUBLIC_URL: bad }).error, bad);
  }
});
