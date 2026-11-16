/**
 * Minimal JSON HTTP client on Node's built-in fetch (replaces axios).
 * Same call shapes the code used: get(url, opts), post(url, data, opts), request(config).
 * Errors carry `response: { status, data }` for HTTP failures and `code` (ECONNREFUSED,
 * ENOTFOUND, ETIMEDOUT, ...) for network failures, never the request headers.
 */

export class HttpError extends Error {
  constructor(message, { status, data, code } = {}) {
    super(message);
    this.name = "HttpError";
    if (status !== undefined) this.response = { status, data };
    if (code) this.code = code;
  }
}

// %20 for spaces: some APIs (Seerr) reject "+"
function withParams(url, params) {
  if (!params) return url;
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  if (!query) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

const MAX_REDIRECTS = 5;

/**
 * fetch, following redirects only on the same origin, or from http to https on the same host.
 * Requests carry API keys in their headers, and fetch would send them along to any other
 * host, port or a plain-http address a server redirects to.
 */
async function fetchSameHost(url, init) {
  let target = new URL(url);
  for (let hops = 0; ; hops++) {
    const res = await fetch(target, { ...init, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 && res.headers.get("location");
    if (!location) return res;
    const next = new URL(location, target);
    const upgrade = target.protocol === "http:" && next.protocol === "https:" && next.hostname === target.hostname;
    if (next.origin !== target.origin && !upgrade) {
      throw new HttpError(`Refused a redirect from ${target.origin} to ${next.origin}`, { code: "EREDIRECT" });
    }
    if (hops >= MAX_REDIRECTS) throw new HttpError("Too many redirects", { code: "EREDIRECT" });
    // Like browsers: 301/302/303 turn a POST into a GET without a body
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && init.method === "POST")) {
      init = { ...init, method: "GET", body: undefined };
    }
    target = next;
  }
}

export async function request({ method = "GET", url, params, data, headers = {}, timeout = 8000 }) {
  const init = {
    method: method.toUpperCase(),
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeout),
  };
  if (data !== undefined) {
    init.body = JSON.stringify(data);
    if (!Object.keys(init.headers).some((h) => h.toLowerCase() === "content-type")) {
      init.headers["Content-Type"] = "application/json";
    }
  }

  let res;
  try {
    res = await fetchSameHost(withParams(url, params), init);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const code = err?.name === "TimeoutError" ? "ETIMEDOUT" : err?.cause?.code || err?.code || "ENETWORK";
    throw new HttpError(`Request failed: ${code}`, { code });
  }

  const text = await res.text();
  let body = text || null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: keep the text
  }
  if (!res.ok) throw new HttpError(`Request failed with status code ${res.status}`, { status: res.status, data: body });
  return { status: res.status, data: body, headers: res.headers };
}

const http = {
  request,
  get: (url, options = {}) => request({ ...options, url, method: "GET" }),
  delete: (url, options = {}) => request({ ...options, url, method: "DELETE" }),
  post: (url, data, options = {}) => request({ ...options, url, data, method: "POST" }),
  put: (url, data, options = {}) => request({ ...options, url, data, method: "PUT" }),
};

export default http;
