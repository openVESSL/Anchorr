// Log files must never contain credentials from failed HTTP requests (audit S16).
import assert from "node:assert/strict";
import test from "node:test";
import winston from "winston";

import { format } from "../utils/logger.js";

function captureLine(...args) {
  const lines = [];
  const logger = winston.createLogger({ format, transports: [new winston.transports.Console()] });
  logger.transports[0].log = (info, done) => {
    lines.push(info[Symbol.for("message")]);
    done();
  };
  logger.error(...args);
  return lines.join("\n");
}

test("a logged HTTP error keeps its message but not its request headers", () => {
  const err = new Error("Request failed with status code 400");
  err.config = { headers: { "X-Api-Key": "SECRET-SENTINEL", Authorization: 'MediaBrowser Token="SECRET-SENTINEL"' } };
  err.request = { _header: "X-Api-Key: SECRET-SENTINEL" };
  err.response = { status: 400, config: { headers: { "X-Api-Key": "SECRET-SENTINEL" } } };

  const line = captureLine("Seerr search failed:", err);
  assert.doesNotMatch(line, /SECRET-SENTINEL/);
  assert.match(line, /Seerr search failed: Request failed with status code 400/);
});
