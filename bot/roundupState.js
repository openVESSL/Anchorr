import { PersistentMap } from "../utils/persistentMap.js";

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
  map.set(INSTALLED_AT_KEY, now);
  return now;
}
