import logger from "./logger.js";

/**
 * Build a Jellyfin URL that preserves a potential subpath (e.g., /jellyfin)
 * and appends the provided path and optional hash fragment safely.
 *
 * Always uses the configured JELLYFIN_BASE_URL — any webhook-provided ServerUrl
 * must not be passed here, as it can be poisoned via Jellyfin metadata.
 *
 * @param {string} appendPath - Path to append (e.g., "web/index.html")
 * @param {string} [hash] - Optional URL fragment (leading "#" is optional)
 * @returns {string} Fully-qualified Jellyfin URL
 */
export function buildJellyfinUrl(appendPath, hash) {
  const effectiveBaseUrl = process.env.JELLYFIN_BASE_URL;

  try {
    const u = new URL(effectiveBaseUrl);
    let p = u.pathname || "/";
    if (!p.endsWith("/")) p += "/";
    const pathClean = String(appendPath || "").replace(/^\/+/, "");
    u.pathname = p + pathClean;
    if (hash != null) {
      const h = String(hash);
      u.hash = h.startsWith("#") ? h.slice(1) : h;
    }
    return u.toString();
  } catch (_e) {
    logger.warn(
      `buildJellyfinUrl: Invalid JELLYFIN_BASE_URL "${effectiveBaseUrl}": ${_e?.message}. Falling back to string concatenation.`
    );
    const baseNoSlash = String(effectiveBaseUrl || "").replace(/\/+$/, "");
    const pathNoLead = String(appendPath || "").replace(/^\/+/, "");
    const h = hash
      ? String(hash).startsWith("#")
        ? String(hash)
        : `#${hash}`
      : "";
    return `${baseNoSlash}/${pathNoLead}${h}`;
  }
}
