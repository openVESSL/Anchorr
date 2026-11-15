/**
 * Jellyfin administrator actions used by setup and dashboard login.
 * Passwords are only forwarded to Jellyfin, never stored or logged.
 */
import { jellyfinAuthHeaders, jellyfinClientHeaders } from "./jellyfin.js";
import { TIMEOUTS } from "../lib/constants.js";
import http from "../utils/http.js";

export const API_KEY_APP_NAME = "Anchorr";

const endpoint = (baseUrl, path) => `${String(baseUrl).replace(/\/+$/, "")}${path}`;

/** Server name, version and id; no authentication needed. */
export async function getPublicServerInfo(baseUrl) {
  const { data } = await http.get(endpoint(baseUrl, "/System/Info/Public"), { timeout: TIMEOUTS.JELLYFIN_API });
  return { serverName: data.ServerName, version: data.Version, serverId: data.Id };
}

/**
 * Signs in with a Jellyfin username and password.
 * @returns {{ token, userId, username, isAdmin, serverId }} a short-lived session token
 */
export async function signIn(baseUrl, username, password) {
  const { data } = await http.post(
    endpoint(baseUrl, "/Users/AuthenticateByName"),
    { Username: username, Pw: password },
    { headers: jellyfinClientHeaders(), timeout: TIMEOUTS.JELLYFIN_API }
  );
  return {
    token: data.AccessToken,
    userId: data.User?.Id,
    username: data.User?.Name ?? username,
    isAdmin: Boolean(data.User?.Policy?.IsAdministrator),
    serverId: data.ServerId,
  };
}

/** Ends a session started by signIn (best effort). */
export async function signOut(baseUrl, token) {
  try {
    await http.post(endpoint(baseUrl, "/Sessions/Logout"), undefined, {
      headers: jellyfinClientHeaders(token),
      timeout: TIMEOUTS.JELLYFIN_API,
    });
  } catch {
    // the session expires on its own
  }
}

async function listApiKeys(baseUrl, token) {
  const { data } = await http.get(endpoint(baseUrl, "/Auth/Keys"), {
    headers: jellyfinClientHeaders(token),
    timeout: TIMEOUTS.JELLYFIN_API,
  });
  return data?.Items || [];
}

/** The "Anchorr" API key, created on first setup and reused afterwards. Needs an admin session. */
export async function getOrCreateApiKey(baseUrl, adminToken) {
  const ours = (keys) =>
    keys
      .filter((k) => k.AppName === API_KEY_APP_NAME && k.IsActive !== false && !k.DateRevoked)
      .sort((a, b) => String(b.DateCreated).localeCompare(String(a.DateCreated)))[0];

  const existing = ours(await listApiKeys(baseUrl, adminToken));
  if (existing) return { apiKey: existing.AccessToken, created: false };

  await http.post(endpoint(baseUrl, "/Auth/Keys"), undefined, {
    params: { app: API_KEY_APP_NAME },
    headers: jellyfinClientHeaders(adminToken),
    timeout: TIMEOUTS.JELLYFIN_API,
  });
  const created = ours(await listApiKeys(baseUrl, adminToken));
  if (!created) throw new Error("Jellyfin did not return the new API key");
  return { apiKey: created.AccessToken, created: true };
}

/** True when the key is an administrator API key (listing keys needs elevation). */
export async function isAdminApiKey(baseUrl, apiKey) {
  try {
    await http.get(endpoint(baseUrl, "/Auth/Keys"), { headers: jellyfinAuthHeaders(apiKey), timeout: TIMEOUTS.JELLYFIN_API });
    return true;
  } catch (err) {
    if (err.response && [401, 403].includes(err.response.status)) return false;
    throw err;
  }
}
