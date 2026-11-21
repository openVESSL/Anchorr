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

test("redirects are followed on the same host, never to another one with the API key", async () => {
  const other = await startFakeServer({ "GET /steal": ({ headers }) => ({ key: headers["x-api-key"] }) });
  const hop = await startFakeServer({
    "GET /moved": () => ({ status: 301, headers: { location: "/ok" }, json: {} }),
    "GET /ok": ({ headers }) => ({ key: headers["x-api-key"] }),
    // same port on another host name: a different server as far as the key is concerned
    "GET /away": () => ({ status: 302, headers: { location: other.url.replace("127.0.0.1", "localhost") + "/steal" }, json: {} }),
    // same host, another port: another service
    "GET /port": () => ({ status: 302, headers: { location: other.url + "/steal" }, json: {} }),
  });
  try {
    const followed = await http.get(`${hop.url}/moved`, { headers: { "X-Api-Key": "SECRET" } });
    assert.equal(followed.data.key, "SECRET");

    const refused = await http.get(`${hop.url}/away`, { headers: { "X-Api-Key": "SECRET" } }).catch((e) => e);
    assert.equal(refused.code, "EREDIRECT");
    const otherPort = await http.get(`${hop.url}/port`, { headers: { "X-Api-Key": "SECRET" } }).catch((e) => e);
    assert.equal(otherPort.code, "EREDIRECT");
    assert.equal(other.requests.length, 0, "the other host and port never saw the key");
  } finally {
    await hop.close();
    await other.close();
  }
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
