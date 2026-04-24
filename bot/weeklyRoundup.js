import { EmbedBuilder } from "discord.js";
import * as jellyfinApi from "../api/jellyfin.js";
import { getLibraryChannels } from "../jellyfin/libraryResolver.js";
import { buildJellyfinUrl } from "../utils/jellyfinUrl.js";
import { updateConfig } from "../utils/configFile.js";
import logger from "../utils/logger.js";

// Hourly tick interval — do not change without updating the idempotency guard.
const TICK_INTERVAL_MS = 60 * 60 * 1000;

// Cutoff for "this week already posted" — must be < 7 days to avoid edge cases
// at the weekday/hour boundary (e.g., if the scheduler drifts by a few minutes).
const ALREADY_POSTED_MIN_AGE_MS = 6 * 24 * 60 * 60 * 1000;

// Rolling window of new items to include in the digest.
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Hard cap on entries rendered in the embed.
const MAX_ENTRIES = 25;

// Fetch cap before grouping.
const FETCH_LIMIT = 200;

let roundupTimer = null;
let consecutiveFailures = 0;

export function scheduleWeeklyRoundup(client) {
  if (roundupTimer) {
    clearInterval(roundupTimer);
  }

  logger.info("📦 Weekly Roundup scheduler started (hourly tick)");

  // Initial tick after startup so startup logs settle first.
  setTimeout(() => runTick(client), 10_000);

  roundupTimer = setInterval(() => runTick(client), TICK_INTERVAL_MS);
}

async function runTick(client) {
  try {
    const enabled = process.env.WEEKLY_ROUNDUP_ENABLED === "true";
    if (!enabled) return;

    const channelId = process.env.WEEKLY_ROUNDUP_CHANNEL_ID;
    if (!channelId) {
      logger.warn(
        "Weekly Roundup enabled but no channel configured. Skipping tick."
      );
      return;
    }

    const targetWeekday = parseInt(process.env.WEEKLY_ROUNDUP_WEEKDAY || "0", 10);
    const targetHour = parseInt(process.env.WEEKLY_ROUNDUP_HOUR || "18", 10);
    const now = new Date();

    if (now.getDay() !== targetWeekday) return;
    if (now.getHours() < targetHour) return;

    const lastPostedAtStr = process.env.WEEKLY_ROUNDUP_LAST_POSTED_AT || "";
    if (lastPostedAtStr) {
      const lastPostedAt = new Date(lastPostedAtStr);
      if (!isNaN(lastPostedAt.getTime())) {
        const age = now.getTime() - lastPostedAt.getTime();
        if (age < ALREADY_POSTED_MIN_AGE_MS) return; // already posted this week
      }
    }

    if (consecutiveFailures >= 3) {
      logger.warn(
        "Weekly Roundup skipped: 3 consecutive failures this week. Will retry next window."
      );
      return;
    }

    await sendWeeklyRoundup(client, channelId);
  } catch (err) {
    logger.error(`Weekly Roundup tick error: ${err?.message || err}`);
  }
}

async function fetchWindowItems() {
  const apiKey = process.env.JELLYFIN_API_KEY;
  const baseUrl = process.env.JELLYFIN_BASE_URL;
  if (!apiKey || !baseUrl) {
    throw new Error("JELLYFIN_API_KEY or JELLYFIN_BASE_URL not set");
  }

  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const rawItems = await jellyfinApi.fetchRecentlyAdded(
    apiKey,
    baseUrl,
    FETCH_LIMIT,
    cutoff
  );

  const libraryMap = getLibraryChannels() || {};
  const allowedLibraryIds = new Set(Object.keys(libraryMap));

  return rawItems.filter((item) => {
    const ancestorIds = Array.isArray(item.AncestorIds) ? item.AncestorIds : [];
    const candidateIds = [item.ParentId, ...ancestorIds].filter(Boolean);
    return candidateIds.some((id) => allowedLibraryIds.has(id));
  });
}

/**
 * Group raw items into per-library buckets of renderable entries.
 * - Movies / Series / Season items produce one entry each.
 * - Episodes are collapsed per series into a single "Series X — Season N (M episodes)" entry.
 *
 * Returns { perLibrary: Map<libraryId, { entries: string[] }>, totalCount, overflow }.
 */
function groupItems(items) {
  const libraryMap = getLibraryChannels() || {};

  const getLibraryIdFor = (item) => {
    const ancestorIds = Array.isArray(item.AncestorIds) ? item.AncestorIds : [];
    const candidateIds = [item.ParentId, ...ancestorIds].filter(Boolean);
    return candidateIds.find((id) => libraryMap[id] !== undefined) || null;
  };

  const episodesBySeries = new Map(); // key: libraryId|seriesId
  const entriesOut = []; // { libraryId, createdAt, render }

  for (const item of items) {
    const libraryId = getLibraryIdFor(item);
    if (!libraryId) continue;

    const createdAt = item.DateCreated ? new Date(item.DateCreated) : new Date(0);

    switch (item.Type) {
      case "Movie":
        entriesOut.push({ libraryId, createdAt, render: renderMovie(item) });
        break;
      case "Series":
        entriesOut.push({ libraryId, createdAt, render: renderSeries(item) });
        break;
      case "Season":
        entriesOut.push({ libraryId, createdAt, render: renderSeason(item) });
        break;
      case "Episode": {
        const seriesKey = item.SeriesId || item.SeriesName || "unknown";
        const key = `${libraryId}|${seriesKey}`;
        const existing = episodesBySeries.get(key) || {
          libraryId,
          seriesId: item.SeriesId,
          seriesName: item.SeriesName || "Unknown Series",
          seasons: new Map(),
          latestCreated: new Date(0),
        };
        const seasonNum = item.ParentIndexNumber ?? 0;
        existing.seasons.set(
          seasonNum,
          (existing.seasons.get(seasonNum) || 0) + 1
        );
        if (createdAt > existing.latestCreated) existing.latestCreated = createdAt;
        episodesBySeries.set(key, existing);
        break;
      }
    }
  }

  for (const group of episodesBySeries.values()) {
    entriesOut.push({
      libraryId: group.libraryId,
      createdAt: group.latestCreated,
      render: renderEpisodeGroup(group),
    });
  }

  entriesOut.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const capped = entriesOut.slice(0, MAX_ENTRIES);
  const overflow = Math.max(0, entriesOut.length - MAX_ENTRIES);

  const perLibrary = new Map();
  for (const entry of capped) {
    if (!perLibrary.has(entry.libraryId)) {
      perLibrary.set(entry.libraryId, { entries: [] });
    }
    perLibrary.get(entry.libraryId).entries.push(entry.render);
  }

  return { perLibrary, totalCount: entriesOut.length, overflow };
}

function renderMovie(item) {
  const title = item.Name || "Unknown";
  const year = item.ProductionYear ? ` (${item.ProductionYear})` : "";
  const url = itemDeeplink(item.Id);
  return `🎬 [**${escapeMd(title)}**${escapeMd(year)}](${url})`;
}

function renderSeries(item) {
  const title = item.Name || "Unknown";
  const url = itemDeeplink(item.Id);
  return `📺 [**${escapeMd(title)}**](${url})`;
}

function renderSeason(item) {
  const seriesName = item.SeriesName || "Unknown Series";
  const seasonLabel = item.Name || `Season ${item.IndexNumber ?? "?"}`;
  const url = itemDeeplink(item.Id);
  return `📺 [**${escapeMd(seriesName)}** — ${escapeMd(seasonLabel)}](${url})`;
}

// i18n in Task 6: "Staffel"/"Folge(n)" labels
function renderEpisodeGroup(group) {
  const seasonNumbers = Array.from(group.seasons.keys()).sort((a, b) => a - b);
  const episodeTotal = Array.from(group.seasons.values()).reduce(
    (a, b) => a + b,
    0
  );

  let seasonLabel;
  if (seasonNumbers.length === 1) {
    seasonLabel = `Staffel ${seasonNumbers[0]}`;
  } else if (seasonNumbers.length === 2) {
    seasonLabel = `Staffeln ${seasonNumbers[0]} & ${seasonNumbers[1]}`;
  } else {
    seasonLabel = `Staffeln ${seasonNumbers.join(", ")}`;
  }

  const episodesLabel = episodeTotal === 1 ? "1 Folge" : `${episodeTotal} Folgen`;

  const url = group.seriesId ? itemDeeplink(group.seriesId) : null;
  if (url) {
    return `📺 [**${escapeMd(group.seriesName)}**](${url}) — ${seasonLabel} (${episodesLabel})`;
  }
  return `📺 **${escapeMd(group.seriesName)}** — ${seasonLabel} (${episodesLabel})`;
}

function itemDeeplink(itemId) {
  if (!itemId) return "";
  return buildJellyfinUrl(
    "web/index.html",
    `#!/details?id=${encodeURIComponent(itemId)}`
  );
}

/**
 * Escape Discord markdown special characters that would break link syntax.
 * Only the minimal set relevant to bracketed link titles is covered.
 */
function escapeMd(s) {
  return String(s).replace(/([\[\]\(\)\\])/g, "\\$1");
}

async function sendWeeklyRoundup(client, channelId) {
  let items;
  try {
    items = await fetchWindowItems();
  } catch (err) {
    consecutiveFailures++;
    logger.error(`Weekly Roundup: failed to fetch items: ${err?.message}`);
    return;
  }

  if (items.length === 0) {
    logger.info("Weekly Roundup: no new items this week — skipping post");
    consecutiveFailures = 0;
    await markPosted();
    return;
  }

  const grouped = groupItems(items);

  const channel = await client.channels.fetch(channelId).catch((err) => {
    logger.error(
      `[ROUNDUP] Failed to fetch channel ${channelId}: ${err?.message}`
    );
    return null;
  });
  if (!channel) {
    consecutiveFailures++;
    return;
  }

  const embed = await buildRoundupEmbed(grouped, items);

  try {
    await channel.send({ embeds: [embed] });
    logger.info(
      `Weekly Roundup posted: ${grouped.totalCount} items across ${grouped.perLibrary.size} libraries`
    );
    consecutiveFailures = 0;
    await markPosted();
  } catch (err) {
    consecutiveFailures++;
    logger.error(`Weekly Roundup: failed to send embed: ${err?.message}`);
  }
}

async function markPosted() {
  const nowIso = new Date().toISOString();
  process.env.WEEKLY_ROUNDUP_LAST_POSTED_AT = nowIso;
  try {
    updateConfig({ WEEKLY_ROUNDUP_LAST_POSTED_AT: nowIso });
  } catch (err) {
    logger.error(
      `Weekly Roundup: failed to persist lastPostedAt: ${err?.message}`
    );
  }
}

async function buildRoundupEmbed(grouped, rawItems) {
  const now = new Date();
  const start = new Date(now.getTime() - WINDOW_MS);

  const dateRange = `${formatDate(start)} – ${formatDate(now)}`;
  const color = resolveColor();

  // i18n in Task 6: "Neu diese Woche"
  const embed = new EmbedBuilder()
    .setTitle("📦 Neu diese Woche")
    .setDescription(dateRange)
    .setColor(color);

  const thumbnailItem = rawItems.find((i) => i.Id && i.ImageTags?.Primary);
  if (thumbnailItem) {
    const thumbUrl = buildJellyfinUrl(
      `Items/${encodeURIComponent(thumbnailItem.Id)}/Images/Primary`
    );
    embed.setThumbnail(thumbUrl);
  }

  const libraryNames = await resolveLibraryNames(
    Array.from(grouped.perLibrary.keys())
  );

  for (const [libraryId, bucket] of grouped.perLibrary.entries()) {
    const name = libraryNames[libraryId] || "Library";
    const value = bucket.entries.join("\n").slice(0, 1024);
    embed.addFields({ name, value });
  }

  // i18n in Task 6: footer text
  if (grouped.overflow > 0) {
    embed.setFooter({
      text: `${grouped.totalCount} neue Inhalte · … und ${grouped.overflow} weitere`,
    });
  } else {
    embed.setFooter({ text: `${grouped.totalCount} neue Inhalte` });
  }

  return embed;
}

async function resolveLibraryNames(libraryIds) {
  const apiKey = process.env.JELLYFIN_API_KEY;
  const baseUrl = process.env.JELLYFIN_BASE_URL;
  try {
    const libs = await jellyfinApi.fetchLibraries(apiKey, baseUrl);
    const map = {};
    for (const lib of libs || []) {
      const id = lib.ItemId || lib.Id;
      if (id && libraryIds.includes(id)) {
        map[id] = lib.Name;
      }
    }
    return map;
  } catch (err) {
    logger.warn(
      `Weekly Roundup: failed to resolve library names: ${err?.message}`
    );
    return {};
  }
}

function formatDate(d) {
  try {
    const lang = process.env.LANGUAGE || "en";
    return d.toLocaleDateString(lang, {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function resolveColor() {
  const configured = process.env.WEEKLY_ROUNDUP_EMBED_COLOR;
  if (configured && /^#?[0-9a-fA-F]{6}$/.test(configured)) {
    return configured.startsWith("#") ? configured : `#${configured}`;
  }
  return process.env.EMBED_COLOR_SERIES || "#cba6f7";
}
