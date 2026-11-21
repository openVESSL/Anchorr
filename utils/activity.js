/**
 * Recent bot activity for the dashboard Overview: notifications posted, requests made from
 * Discord, the daily pick and the weekly roundup. Kept in activity.json next to config.json.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH } from "./configFile.js";
import logger from "./logger.js";

// shortcut: the last 200 events only, so weekly counts undercount on very busy servers; use a real store if that matters.
const MAX_EVENTS = 200;
const FILE = () => path.join(path.dirname(CONFIG_PATH), "activity.json");

let events = null;

function load() {
  if (events) return events;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    events = Array.isArray(parsed) ? parsed.slice(0, MAX_EVENTS) : [];
  } catch {
    events = [];
  }
  return events;
}

/** Adds an event (newest first). Never throws: activity is informational. */
export function recordActivity(type, { title, detail, user } = {}) {
  try {
    const list = load();
    list.unshift({ at: Date.now(), type, title: title ?? null, detail: detail ?? null, user: user ?? null });
    list.length = Math.min(list.length, MAX_EVENTS);
    fs.writeFileSync(FILE(), JSON.stringify(list), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    logger.debug(`Could not save activity: ${err.message}`);
  }
}

/** The newest events and counts for the last 7 days. */
export function getActivity(limit = 20) {
  const list = load();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const week = {};
  for (const e of list) if (e.at >= weekAgo) week[e.type] = (week[e.type] ?? 0) + 1;
  return { recent: list.slice(0, limit), week };
}

/** For tests: forget the in-memory copy so the file is read again. */
export function resetActivityCache() {
  events = null;
}
