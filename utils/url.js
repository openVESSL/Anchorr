export function isValidUrl(string) {
  if (!string || typeof string !== "string") return false;
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}
