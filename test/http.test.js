import assert from "node:assert/strict";
import net from "node:net";
import test, { after, before } from "node:test";

import http, { HttpError } from "../utils/http.js";
import { startFakeServer } from "./helpers/http.js";

let server;
before(async () => {
  server = await startFakeServer({
    "GET /ok": ({ url }) => ({ query: url.search }),
    "POST /echo": ({ body, headers }) => ({ body, contentType: headers["content-type"] }),
    "GET /missing": () => ({ status: 404, json: { message: "not here" } }),
  });
});
after(() => server.close());

test("GET with params encodes spaces as %20 and returns parsed JSON", async () => {
  const res = await http.get(`${server.url}/ok`, { params: { query: "the matrix", page: 1, skip: undefined } });
  assert.equal(res.status, 200);
  assert.equal(res.data.query, "?query=the%20matrix&page=1");
});

test("POST sends JSON", async () => {
  const res = await http.post(`${server.url}/echo`, { a: 1 });
  assert.deepEqual(res.data, { body: { a: 1 }, contentType: "application/json" });
});

test("HTTP errors expose status and body, never the request headers", async () => {
  const err = await http.get(`${server.url}/missing`, { headers: { "X-Api-Key": "SECRET" } }).catch((e) => e);
  assert.ok(err instanceof HttpError);
  assert.equal(err.message, "Request failed with status code 404");
  assert.deepEqual(err.response, { status: 404, data: { message: "not here" } });
  assert.doesNotMatch(JSON.stringify(err), /SECRET/);
});

test("network failures carry a code", async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  const refused = await http.get(`http://127.0.0.1:${port}/`).catch((e) => e);
  assert.equal(refused.code, "ECONNREFUSED");

  const hanging = net.createServer(() => {}); // accepts, never answers
  await new Promise((resolve) => hanging.listen(0, "127.0.0.1", resolve));
  const timedOut = await http.get(`http://127.0.0.1:${hanging.address().port}/`, { timeout: 200 }).catch((e) => e);
  assert.equal(timedOut.code, "ETIMEDOUT");
  hanging.close();
});
