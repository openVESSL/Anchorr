export function isValidUrl(string) {
  if (!string || typeof string !== "string") return false;
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

// Discord's embed validator rejects dotless hosts like "seerr". Heuristic, not exhaustive.
export function isDiscordLinkableUrl(string) {
  if (!isValidUrl(string)) return false;
  const url = new URL(string);
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.hostname === "localhost") return false;
  return url.hostname.includes(".");
}
