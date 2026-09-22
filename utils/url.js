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
 * Checks whether a URL is acceptable as a clickable link in a Discord embed.
 * Discord's embed validator is stricter than `new URL()` and rejects hosts
 * without a dot (e.g. Docker service names) and localhost.
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
