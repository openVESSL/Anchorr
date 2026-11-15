import logger from "../utils/logger.js";
import { sendWeeklyRoundup } from "./weeklyRoundup.js";
import {
  getInstalledAt,
  getLastPostedAt,
  setLastPostedAt,
  getFailureCount,
  recordFailure,
} from "./roundupState.js";
import { settings } from "../utils/settings.js";

const ALREADY_POSTED_MIN_AGE_MS = 6 * 24 * 60 * 60 * 1000;
const MAX_FAILURES_PER_WEEK = 3;
const TICK_OFFSET_SECONDS = 5;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let pendingTimer = null;
let generation = 0;
let circuitOpenWarned = false;

function parseIntInRange(raw, fallback, min, max, settingName) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < min || n > max) {
    // Only complain about a value the user actually set — an unset key
    // legitimately falls back to the default.
    if (settingName && raw !== undefined && raw !== "") {
      logger.warn(
        `Weekly Roundup: ${settingName}="${raw}" is not a whole number between ${min} and ${max}; using ${fallback} instead`
      );
    }
    return fallback;
  }
  return n;
}

function msUntilNextHour(now = new Date()) {
  const next = new Date(now);
  next.setHours(now.getHours() + 1, 0, TICK_OFFSET_SECONDS, 0);
  // Floor guards against a clock step landing this at <= 0, which would turn
  // the chained setTimeout into a tight loop.
  return Math.max(1000, next.getTime() - now.getTime());
}

export function evaluateTick(now = new Date()) {
  if (settings.WEEKLY_ROUNDUP_ENABLED !== "true") {
    return { action: "skip", reason: "not-enabled" };
  }
  if (!settings.WEEKLY_ROUNDUP_CHANNEL_ID) {
    return { action: "skip", reason: "no-channel" };
  }
  const targetWeekday = parseIntInRange(
    settings.WEEKLY_ROUNDUP_WEEKDAY,
    0,
    0,
    6
  );
  const targetHour = parseIntInRange(
    settings.WEEKLY_ROUNDUP_HOUR,
    18,
    0,
    23
  );
  const weekday = now.getDay();
  const hour = now.getHours();
  if (weekday !== targetWeekday) {
    return { action: "skip", reason: "wrong-weekday", targetWeekday, targetHour, weekday, hour };
  }
  if (hour < targetHour) {
    return { action: "skip", reason: "before-target-hour", targetWeekday, targetHour, weekday, hour };
  }
  const last = getLastPostedAt();
  if (last && now.getTime() - last < ALREADY_POSTED_MIN_AGE_MS) {
    return { action: "skip", reason: "already-posted-this-week", targetWeekday, targetHour, weekday, hour };
  }
  if (getFailureCount(now.getTime()) >= MAX_FAILURES_PER_WEEK) {
    return { action: "skip", reason: "circuit-open", targetWeekday, targetHour, weekday, hour };
  }
  return { action: "post", targetWeekday, targetHour, weekday, hour };
}

function formatTickLog(now, decision) {
  const weekday = now.getDay();
  const hour = now.getHours();
  const wd = WEEKDAY_SHORT[weekday];
  const targetWd =
    decision.targetWeekday != null ? WEEKDAY_SHORT[decision.targetWeekday] : "?";
  const targetH = decision.targetHour != null ? decision.targetHour : "?";
  const action =
    decision.action === "post" ? "post" : `skip:${decision.reason}`;
  return `Roundup tick: ${now.toISOString()} weekday=${weekday}(${wd}) hour=${hour} target=${targetWd}/${targetH} → ${action}`;
}

async function runTick(client, now = new Date()) {
  const decision = evaluateTick(now);
  logger.info(formatTickLog(now, decision));
  if (decision.reason === "circuit-open") {
    if (!circuitOpenWarned) {
      circuitOpenWarned = true;
      logger.warn(
        `Weekly Roundup: ${MAX_FAILURES_PER_WEEK} posts failed in the last 7 days — no further attempts will be made until one of those failures ages out. Check the earlier "post failed" entries for the cause.`
      );
    }
  } else {
    circuitOpenWarned = false;
  }
  if (decision.action !== "post") return;

  const channelId = settings.WEEKLY_ROUNDUP_CHANNEL_ID;
  try {
    // Only stamp the week as done when something was actually posted —
    // otherwise a misconfig that skips the post would block retries for six
    // days even after the user fixes it.
    const posted = await sendWeeklyRoundup(client, channelId, now);
    if (posted) setLastPostedAt(now.getTime());
  } catch (err) {
    recordFailure(now.getTime());
    logger.error(
      `Weekly Roundup: post failed (${err?.message || err}); failure count=${getFailureCount(now.getTime())}`
    );
  }
}

export function start(client) {
  // Restarting the bot from the dashboard destroys the old Discord client
  // and constructs a new one (see bot/botManager.js), so this must rebind
  // to the fresh client rather than ignore the second call — otherwise the
  // scheduler keeps ticking against a destroyed client until every tick
  // fails and the failure circuit permanently opens for the week.
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  // clearTimeout only helps if the previous tick hasn't fired yet. If a
  // restart lands while an old tick is mid-flight (sendWeeklyRoundup does
  // Jellyfin + Discord I/O and can take a while), the old chain's finally()
  // would otherwise re-arm itself with the stale client after we've already
  // set up the new one. The generation token makes any such stale chain a
  // no-op instead of silently ticking against a destroyed client.
  const myGeneration = ++generation;

  const installedAt = getInstalledAt();
  const now = new Date();
  // Named only here, not in evaluateTick — this runs once per start, so a
  // rejected value is reported without flooding the hourly tick log.
  const targetWeekday = parseIntInRange(
    settings.WEEKLY_ROUNDUP_WEEKDAY,
    0,
    0,
    6,
    "WEEKLY_ROUNDUP_WEEKDAY"
  );
  const targetHour = parseIntInRange(
    settings.WEEKLY_ROUNDUP_HOUR,
    18,
    0,
    23,
    "WEEKLY_ROUNDUP_HOUR"
  );
  logger.info(
    `Roundup scheduler started: local now=${WEEKDAY_SHORT[now.getDay()]} ${now.toISOString()} hour=${now.getHours()}, target=${WEEKDAY_SHORT[targetWeekday]} ${targetHour}:00, installedAt=${new Date(installedAt).toISOString()}`
  );

  // One-shot misconfig warnings so users don't have to wait an hour to find
  // out their setup is wrong from the per-tick skip log.
  if (
    settings.WEEKLY_ROUNDUP_ENABLED === "true" &&
    !settings.WEEKLY_ROUNDUP_CHANNEL_ID
  ) {
    logger.warn(
      "Weekly Roundup is enabled but WEEKLY_ROUNDUP_CHANNEL_ID is empty; ticks will skip until a channel is configured"
    );
  }
  const roleId = settings.WEEKLY_ROUNDUP_ROLE_ID;
  if (roleId && !/^\d{17,20}$/.test(roleId)) {
    logger.warn(
      `Weekly Roundup: WEEKLY_ROUNDUP_ROLE_ID="${roleId}" is not a valid Discord role ID (17–20 digits); posting without role mention`
    );
  }

  // Chained setTimeout (not setInterval) so each tick re-aligns to the top of
  // the next hour. setInterval(HOUR_MS) drifts off the boundary across DST
  // transitions and could push a post a full hour late.
  const scheduleNext = () => {
    if (myGeneration !== generation) return; // superseded by a newer start()
    pendingTimer = setTimeout(() => {
      if (myGeneration !== generation) return;
      runTick(client)
        .catch((err) =>
          logger.error(`Weekly Roundup tick crash: ${err?.message || err}`)
        )
        .finally(scheduleNext);
    }, msUntilNextHour(new Date()));
  };
  scheduleNext();
}

// Called when the bot is stopped (not restarted) so the scheduler doesn't
// keep ticking against a destroyed Discord client — that would fail every
// tick, burn the failure counter, and open the circuit for the rest of the
// week even though nothing about the roundup content actually failed.
export function stop() {
  generation++;
  circuitOpenWarned = false;
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}
