export const MASKED_PREFIX = "••••••••";

export const SENSITIVE_FIELDS = [
  "DISCORD_TOKEN",
  "SEERR_API_KEY",
  "JELLYFIN_API_KEY",
];

// MOKA_API_KEY: handed over by Moka, never shown or set from the dashboard
export const STRIPPED_FIELDS = ["JWT_SECRET", "WEBHOOK_SECRET", "MOKA_API_KEY"];

export function maskSecret(value) {
  if (!value || typeof value !== "string") return "";
  return value.length > 4
    ? MASKED_PREFIX + value.slice(-4)
    : MASKED_PREFIX;
}

export function isMaskedValue(value) {
  return typeof value === "string" && value.startsWith(MASKED_PREFIX);
}

export function sanitizeConfigForClient(config) {
  if (!config) return config;
  const sanitized = { ...config };

  for (const field of SENSITIVE_FIELDS) {
    if (sanitized[field]) {
      sanitized[field] = maskSecret(sanitized[field]);
    }
  }
  for (const field of STRIPPED_FIELDS) {
    delete sanitized[field];
  }

  // Strip password hashes from USERS array
  if (Array.isArray(sanitized.USERS)) {
    sanitized.USERS = sanitized.USERS.map(({ password, ...user }) => user);
  }

  return sanitized;
}
