/**
 * Converts minutes to human-readable format (e.g., "2h 30m")
 * @param {number} mins - Minutes to convert
 * @returns {string} Formatted time string
 */
/** "HH:MM:SS" (Jellyfin runtime) -> whole minutes, NaN if not in that form. */
export function hhmmssToMinutes(value) {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(String(value ?? "").trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

export function minutesToHhMm(mins) {
  if (typeof mins !== "number" || isNaN(mins) || mins <= 0) return "Unknown";
  const h = Math.floor(mins / 60);
  const m = Math.floor(mins % 60);
  let result = "";
  if (h > 0) result += `${h}h `;
  result += `${m}m`;
  return result;
}
