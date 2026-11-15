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
    res = await fetch(withParams(url, params), init);
  } catch (err) {
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
