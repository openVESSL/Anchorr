/**
 * Normalises a Seerr base URL by stripping any trailing /api/v1 suffix and slash.
 * @param {string} url
 * @returns {string}
 */
export function normalizeSeerrUrl(url) {
  if (!url) return "";
  return url.replace(/\/api\/v1\/?$/, "").replace(/\/$/, "");
}

/**
 * Returns the full Seerr API URL (base + /api/v1).
 * @param {string} url
 * @returns {string}
 */
export function getSeerrApiUrl(url) {
  const base = normalizeSeerrUrl(url);
  return base ? `${base}/api/v1` : "";
}
