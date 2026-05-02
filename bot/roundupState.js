import { PersistentMap } from "../utils/persistentMap.js";
import logger from "../utils/logger.js";

const NEVER_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

const map = new PersistentMap("roundup-state", NEVER_TTL_MS, {
  validateValue: (v) =>
    (typeof v === "number" && Number.isFinite(v)) || Array.isArray(v),
});

const INSTALLED_AT_KEY = "installedAt";
const LAST_POSTED_AT_KEY = "lastPostedAt";
const FAILURES_KEY = "failures";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function getInstalledAt(now = Date.now()) {
  const existing = map.get(INSTALLED_AT_KEY);
  if (typeof existing === "number" && Number.isFinite(existing)) {
    return existing;
  }
  logger.info(
    `roundup-state: stamping installedAt=${new Date(now).toISOString()} (no prior value found)`
  );
  map.set(INSTALLED_AT_KEY, now);
  return now;
}

export function getLastPostedAt() {
  const v = map.get(LAST_POSTED_AT_KEY);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function setLastPostedAt(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return;
  map.set(LAST_POSTED_AT_KEY, ms);
}

export function getFailureCount(now = Date.now()) {
  const list = map.get(FAILURES_KEY);
  if (!Array.isArray(list)) return 0;
  const cutoff = now - WEEK_MS;
  return list.filter((t) => typeof t === "number" && t >= cutoff).length;
}

export function recordFailure(ms = Date.now()) {
  const list = Array.isArray(map.get(FAILURES_KEY)) ? map.get(FAILURES_KEY) : [];
  const cutoff = ms - WEEK_MS;
  const pruned = list.filter((t) => typeof t === "number" && t >= cutoff);
  pruned.push(ms);
  map.set(FAILURES_KEY, pruned);
}

(function migrateLegacyLastPostedAt() {
  if (map.get(LAST_POSTED_AT_KEY) != null) return;
  const legacy = process.env.WEEKLY_ROUNDUP_LAST_POSTED_AT;
  if (!legacy) return;
  const parsed = Date.parse(legacy);
  if (!Number.isFinite(parsed)) return;
  map.set(LAST_POSTED_AT_KEY, parsed);
  logger.info(
    `roundup-state: migrated legacy lastPostedAt=${new Date(parsed).toISOString()} from config`
  );
})();
