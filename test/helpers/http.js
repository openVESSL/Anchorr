// Local fake for Jellyfin / Seerr: routes are "METHOD /path" -> handler(req, body) returning
// { status, json } or a plain object (sent as 200 JSON). Every request is recorded.
import http from "node:http";

export async function startFakeServer(routes) {
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: `no fake route for ${req.method} ${url.pathname}` }));
    }
    const result = await handler({ url, headers: req.headers, body });
    const status = result?.status ?? 200;
    const json = result && "json" in result ? result.json : result;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json ?? {}));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    server,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
