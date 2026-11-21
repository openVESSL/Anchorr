// Preloaded by `npm test` (node --import) before any test file.
// 1. Isolated data dir: tests never touch ./config or ./logs of a real install.
// 2. Network guard: anything that is not loopback fails fast instead of hitting the internet.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
// ANCHORR_TEST_DATA_DIR: a test that starts app.js picks the folder, to look at its files
process.env.ANCHORR_CONFIG_DIR = process.env.ANCHORR_TEST_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "anchorr-test-"));

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostOf(target) {
  if (typeof target === "string" || target instanceof URL) return new URL(target).hostname;
  return target?.hostname || (target?.host || "").split(":")[0];
}

function guard(original) {
  return function guarded(target, ...rest) {
    const host = hostOf(target);
    if (host && !LOOPBACK.has(host)) {
      throw new Error(`Network access blocked in tests: ${host}`);
    }
    return original.call(this, target, ...rest);
  };
}

http.request = guard(http.request);
https.request = guard(https.request);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" || input instanceof URL ? input : input.url;
  const host = new URL(url).hostname;
  if (!LOOPBACK.has(host)) throw new Error(`Network access blocked in tests: ${host}`);
  return originalFetch(input, init);
};
