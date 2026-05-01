import { PersistentMap } from "../utils/persistentMap.js";
import logger from "../utils/logger.js";

const NEVER_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

const map = new PersistentMap("roundup-state", NEVER_TTL_MS, {
  validateValue: (v) => typeof v === "number" && Number.isFinite(v),
});

const INSTALLED_AT_KEY = "installedAt";

export function getInstalledAt(now = Date.now()) {
  const existing = map.get(INSTALLED_AT_KEY);
  if (typeof existing === "number" && Number.isFinite(existing)) {
    return existing;
  }
  // First time we've stamped this — or the persisted value was rejected
  // by validateValue on load (PersistentMap logs the drop). Either way,
  // surface it: an unexpected restamp resets the back-catalogue floor.
  logger.info(
    `roundup-state: stamping installedAt=${new Date(now).toISOString()} (no prior value found)`
  );
  map.set(INSTALLED_AT_KEY, now);
  return now;
}
