export function isValidUrl(string) {
  if (!string || typeof string !== "string") return false;
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Heuristic: is this URL likely to pass Discord's embed link validator?
 * Discord is stricter than `new URL()` and rejects dotless hosts like
 * Docker service names. Not exhaustive — a rejection past this should throw.
 * @param {string} string
 * @returns {boolean}
 */
export function isDiscordLinkableUrl(string) {
  if (!isValidUrl(string)) return false;
  const url = new URL(string);
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.hostname === "localhost") return false;
  return url.hostname.includes(".");
}
