import logger from "../utils/logger.js";
import { sendWeeklyRoundup } from "./weeklyRoundup.js";
import {
  getInstalledAt,
  getLastPostedAt,
  setLastPostedAt,
  getFailureCount,
  recordFailure,
} from "./roundupState.js";

const HOUR_MS = 60 * 60 * 1000;
const ALREADY_POSTED_MIN_AGE_MS = 6 * 24 * 60 * 60 * 1000;
const MAX_FAILURES_PER_WEEK = 3;
const TICK_OFFSET_SECONDS = 5;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let started = false;

function parseIntInRange(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < min || n > max) return fallback;
  return n;
}

function msUntilNextHour(now = new Date()) {
  const next = new Date(now);
  next.setHours(now.getHours() + 1, 0, TICK_OFFSET_SECONDS, 0);
  return next.getTime() - now.getTime();
}

export function evaluateTick(now = new Date()) {
  if (process.env.WEEKLY_ROUNDUP_ENABLED !== "true") {
    return { action: "skip", reason: "not-enabled" };
  }
  if (!process.env.WEEKLY_ROUNDUP_CHANNEL_ID) {
    return { action: "skip", reason: "no-channel" };
  }
  const targetWeekday = parseIntInRange(
    process.env.WEEKLY_ROUNDUP_WEEKDAY,
    0,
    0,
    6
  );
  const targetHour = parseIntInRange(
    process.env.WEEKLY_ROUNDUP_HOUR,
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
  if (decision.action !== "post") return;

  const channelId = process.env.WEEKLY_ROUNDUP_CHANNEL_ID;
  try {
    await sendWeeklyRoundup(client, channelId, now);
    setLastPostedAt(now.getTime());
  } catch (err) {
    recordFailure(now.getTime());
    logger.error(
      `Weekly Roundup: post failed (${err?.message || err}); failure count=${getFailureCount(now.getTime())}`
    );
  }
}

export function start(client) {
  if (started) {
    logger.warn("Roundup scheduler start() called twice; ignoring second call");
    return;
  }
  started = true;

  const installedAt = getInstalledAt();
  const now = new Date();
  const targetWeekday = parseIntInRange(
    process.env.WEEKLY_ROUNDUP_WEEKDAY,
    0,
    0,
    6
  );
  const targetHour = parseIntInRange(
    process.env.WEEKLY_ROUNDUP_HOUR,
    18,
    0,
    23
  );
  logger.info(
    `Roundup scheduler started: local now=${WEEKDAY_SHORT[now.getDay()]} ${now.toISOString()} hour=${now.getHours()}, target=${WEEKDAY_SHORT[targetWeekday]} ${targetHour}:00, installedAt=${new Date(installedAt).toISOString()}`
  );

  const delay = msUntilNextHour(now);
  setTimeout(() => {
    runTick(client).catch((err) =>
      logger.error(`Weekly Roundup tick crash: ${err?.message || err}`)
    );
    setInterval(() => {
      runTick(client).catch((err) =>
        logger.error(`Weekly Roundup tick crash: ${err?.message || err}`)
      );
    }, HOUR_MS);
  }, delay);
}
