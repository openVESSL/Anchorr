import { EmbedBuilder } from "discord.js";
import * as jellyfinApi from "../api/jellyfin.js";
import { getLibraryChannels } from "../jellyfin/libraryResolver.js";
import { buildJellyfinUrl } from "../utils/jellyfinUrl.js";
import { updateConfig } from "../utils/configFile.js";
import { t } from "../utils/i18n.js";
import logger from "../utils/logger.js";
import { recordOrGet } from "./roundupFirstSeen.js";

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
let failureState = { weekKey: null, count: 0 };

function weekKeyFor(date) {
  // ISO-like week marker: YYYY-MM-DD of the Sunday that started this week.
  // Used to scope consecutive-failure counting to the current week only.
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

function bumpFailure(now) {
  const key = weekKeyFor(now);
  if (failureState.weekKey !== key) {
    failureState = { weekKey: key, count: 0 };
  }
  failureState.count += 1;
  return failureState.count;
}

function resetFailures(now) {
  failureState = { weekKey: weekKeyFor(now), count: 0 };
}

function currentFailures(now) {
  if (failureState.weekKey !== weekKeyFor(now)) return 0;
  return failureState.count;
}

export function scheduleWeeklyRoundup(client) {
  if (roundupTimer) {
    clearInterval(roundupTimer);
  }

  logger.info("📦 Weekly Roundup scheduler started (hourly tick)");

  // Initial tick after startup so startup logs settle first.
  setTimeout(() => {
    runTick(client).catch((err) =>
      logger.error(`Weekly Roundup initial tick error: ${err?.message || err}`)
    );
  }, 10_000);

  roundupTimer = setInterval(() => {
    runTick(client).catch((err) =>
      logger.error(`Weekly Roundup tick error: ${err?.message || err}`)
    );
  }, TICK_INTERVAL_MS);
}

function parseIntInRange(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < min || n > max) return fallback;
  return n;
}

async function runTick(client) {
  const enabled = process.env.WEEKLY_ROUNDUP_ENABLED === "true";
  if (!enabled) return;

  const channelId = process.env.WEEKLY_ROUNDUP_CHANNEL_ID;
  if (!channelId) {
    logger.warn(
      "Weekly Roundup enabled but no channel configured. Skipping tick."
    );
    return;
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
  const now = new Date();

  if (now.getDay() !== targetWeekday) return;
  // `>=` instead of strict equality: if the bot was down or the hourly tick
  // drifted past the boundary, post on the next tick within the same day
  // rather than skipping the entire week. The 6-day idempotency guard below
  // still prevents duplicates on re-tick.
  if (now.getHours() < targetHour) return;

  const lastPostedAtStr = process.env.WEEKLY_ROUNDUP_LAST_POSTED_AT || "";
  if (lastPostedAtStr) {
    const lastPostedAt = new Date(lastPostedAtStr);
    if (isNaN(lastPostedAt.getTime())) {
      // Fail safe: don't re-post if the persisted timestamp is corrupt — a
      // duplicate digest is worse than skipping a week. Manual fix: clear the
      // value via the dashboard.
      logger.warn(
        `Weekly Roundup: WEEKLY_ROUNDUP_LAST_POSTED_AT is not a valid date ("${lastPostedAtStr}"); skipping tick to avoid a duplicate post`
      );
      return;
    }
    const age = now.getTime() - lastPostedAt.getTime();
    if (age < ALREADY_POSTED_MIN_AGE_MS) return; // already posted this week
  }

  if (currentFailures(now) >= 3) {
    logger.warn(
      "Weekly Roundup skipped: 3 consecutive failures this week. Will retry next week."
    );
    return;
  }

  await sendWeeklyRoundup(client, channelId, now);
}

async function fetchWindowItems() {
  const apiKey = process.env.JELLYFIN_API_KEY;
  const baseUrl = process.env.JELLYFIN_BASE_URL;
  if (!apiKey || !baseUrl) {
    throw new Error("JELLYFIN_API_KEY or JELLYFIN_BASE_URL not set");
  }

  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const libraryChannels = getLibraryChannels() || {};

  // Jellyfin item IDs are 32-char hex. Skip anything else (e.g. a stray "on"
  // value that leaked in from a checkbox).
  const validId = (id) => /^[0-9a-f]{32}$/i.test(id);
  const configuredIds = Object.keys(libraryChannels).filter(validId);
  const skipped = Object.keys(libraryChannels).filter((id) => !validId(id));
  if (skipped.length > 0) {
    logger.warn(
      `Weekly Roundup: ignoring invalid library ids in JELLYFIN_NOTIFICATION_LIBRARIES: [${skipped.join(", ")}]`
    );
  }

  // Query Jellyfin once per configured library with ParentId + Recursive — this
  // sidesteps the issue that items reference internal CollectionIds (or even
  // BoxSet ids) that don't appear in /Library/VirtualFolders. The library
  // membership is implicit in the query, so no post-fetch translation needed.
  // Both the VirtualFolderItemId and CollectionId forms are valid ParentId
  // values on Jellyfin's /Items endpoint, so passing the configured ids
  // directly works regardless of which form was stored.
  const all = [];
  let totalRaw = 0;
  for (const libId of configuredIds) {
    let items;
    try {
      items = await jellyfinApi.fetchRecentlyAdded(
        apiKey,
        baseUrl,
        FETCH_LIMIT,
        cutoff,
        libId
      );
    } catch (err) {
      throw new Error(
        `Failed to fetch recent items for library ${libId}: ${err?.message}`
      );
    }
    totalRaw += items.length;
    for (const item of items) {
      item._configLibraryId = libId;
      all.push(item);
    }
  }

  // Dedupe by item.Id — an item could in theory live in multiple configured
  // libraries; keep the first occurrence (libraries iterate in config order).
  const seen = new Set();
  const filtered = all.filter((item) => {
    if (!item.Id || seen.has(item.Id)) return false;
    seen.add(item.Id);
    return true;
  });

  logger.info(
    `Weekly Roundup: queried ${configuredIds.length} configured libraries since ${cutoff}, got ${totalRaw} items (${filtered.length} after dedupe)`
  );

  // Diagnostic: dump the raw identity fields for each episode so we can see
  // why dedup might fail (missing IndexNumber, varying Name, multiple item
  // ids for the same episode, ...). Debug-level — only useful when actively
  // chasing a dedup mismatch; noise during normal operation.
  const episodes = filtered.filter((it) => it.Type === "Episode");
  if (episodes.length > 0) {
    const dump = episodes
      .slice(0, 30)
      .map(
        (e) =>
          `{id:${e.Id}, series:"${e.SeriesName}", S${e.ParentIndexNumber}E${e.IndexNumber}${e.IndexNumberEnd != null ? `-${e.IndexNumberEnd}` : ""}, name:"${e.Name}", created:${e.DateCreated}}`
      )
      .join("\n  ");
    logger.debug(
      `Weekly Roundup: episode raw fields (first 30 of ${episodes.length}):\n  ${dump}`
    );
  }

  filtered.rawCount = totalRaw;
  filtered.allowedLibraryCount = configuredIds.length;
  return filtered;
}

/**
 * Group raw items into per-library buckets of renderable entries.
 * - Movies / Series / Season items produce one entry each.
 * - Episodes are collapsed per series into a single "Series X — Season N (M episodes)" entry.
 *
 * Returns { perLibrary: Map<libraryId, { entries: string[] }>, totalCount, overflow }.
 */
function groupItems(items) {
  // Items have already been tagged with _configLibraryId by fetchWindowItems,
  // which translates between Jellyfin's two library-ID forms.
  const getLibraryIdFor = (item) => item._configLibraryId || null;

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
          seriesName: item.SeriesName || t("roundup.unknown_series"),
          // seasons: Map<seasonNum, Set<episodeKey>> — Set so a Sonarr quality
          // upgrade that re-imports the same episode multiple times in a week
          // counts once instead of inflating the season count.
          seasons: new Map(),
          latestCreated: new Date(0),
        };
        const seasonNum = item.ParentIndexNumber ?? 0;
        const set = existing.seasons.get(seasonNum) || new Set();
        // Build a dedupe key from the strongest stable identity available.
        // Prefer (IndexNumber + IndexNumberEnd) for ranged 2-parters, then
        // IndexNumber alone, then the episode Name (Sonarr re-imports keep
        // the title), then finally the Jellyfin item id as last resort.
        const idxStart = item.IndexNumber;
        const idxEnd = item.IndexNumberEnd;
        let episodeKey;
        if (idxStart != null && idxEnd != null && idxEnd !== idxStart) {
          episodeKey = `e${idxStart}-${idxEnd}`;
        } else if (idxStart != null) {
          episodeKey = `e${idxStart}`;
        } else if (item.Name) {
          episodeKey = `n:${item.Name.toLowerCase().trim()}`;
        } else {
          episodeKey = `id:${item.Id}`;
        }
        set.add(episodeKey);
        existing.seasons.set(seasonNum, set);
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
  const title = item.Name || t("roundup.unknown_title");
  const year = item.ProductionYear ? ` (${item.ProductionYear})` : "";
  const url = itemDeeplink(item.Id);
  return `🎬 [**${escapeMd(title)}**${escapeMd(year)}](${url})`;
}

function renderSeries(item) {
  const title = item.Name || t("roundup.unknown_title");
  const url = itemDeeplink(item.Id);
  return `📺 [**${escapeMd(title)}**](${url})`;
}

function renderSeason(item) {
  const seriesName = item.SeriesName || t("roundup.unknown_series");
  const seasonLabel =
    item.Name || t("roundup.season_fallback", { n: item.IndexNumber ?? "?" });
  const url = itemDeeplink(item.Id);
  return `📺 [**${escapeMd(seriesName)}** — ${escapeMd(seasonLabel)}](${url})`;
}

function renderEpisodeGroup(group) {
  const seasonNumbers = Array.from(group.seasons.keys()).sort((a, b) => a - b);
  const episodeTotal = Array.from(group.seasons.values()).reduce(
    (a, set) => a + set.size,
    0
  );

  let seasonLabel;
  if (seasonNumbers.length === 1) {
    seasonLabel = t("roundup.season_label_single", { a: seasonNumbers[0] });
  } else if (seasonNumbers.length === 2) {
    seasonLabel = t("roundup.season_label_pair", {
      a: seasonNumbers[0],
      b: seasonNumbers[1],
    });
  } else {
    seasonLabel = t("roundup.season_label_multi", {
      list: seasonNumbers.join(", "),
    });
  }

  const episodesLabel =
    episodeTotal === 1
      ? t("roundup.episodes_label_one")
      : t("roundup.episodes_label_many", { count: episodeTotal });

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
 * Escape Discord markdown so user-supplied titles cannot break link syntax
 * or trigger unintended formatting (bold/italic/strikethrough/code) inside
 * the bracketed label.
 */
function escapeMd(s) {
  return String(s).replace(/([\[\]\(\)\\*_~`])/g, "\\$1");
}

async function sendWeeklyRoundup(client, channelId, now, options = {}) {
  const isTest = options.test === true;
  const logPrefix = isTest ? "Weekly Roundup (test)" : "Weekly Roundup";

  // In test mode we rethrow errors so the /api/test-weekly-roundup handler
  // can surface them to the dashboard, and we skip all state side effects
  // (failure counter, lastPostedAt) so a test run never masks or replaces a
  // real scheduled post.
  const onError = (err, msg) => {
    if (isTest) throw err instanceof Error ? err : new Error(msg);
    bumpFailure(now);
  };

  // Preflight: a malformed JELLYFIN_BASE_URL causes buildJellyfinUrl to emit
  // an http://invalid.local/... sentinel. Catching that here means the user
  // never sees a digest full of unclickable links — they get an ops log and
  // the failure counter advances normally. Reaching this with no value at
  // all (empty/undefined) is also misconfig: bail the same way.
  const baseUrl = process.env.JELLYFIN_BASE_URL;
  let baseUrlOk = false;
  try {
    if (baseUrl) {
      const parsed = new URL(baseUrl);
      // Mirror the SSRF guard used by the config-test routes: only http(s)
      // schemes are allowed, never file:/gopher:/etc.
      baseUrlOk = parsed.protocol === "http:" || parsed.protocol === "https:";
    }
  } catch {
    /* fall through */
  }
  if (!baseUrlOk) {
    const msg = `JELLYFIN_BASE_URL is missing or not a valid http(s) URL ("${baseUrl ?? ""}")`;
    logger.error(`${logPrefix}: ${msg}`);
    if (isTest) throw new Error(msg);
    bumpFailure(now);
    return;
  }

  let items;
  try {
    items = await fetchWindowItems();
  } catch (err) {
    logger.error(`${logPrefix}: failed to fetch items: ${err?.message}`);
    onError(err, `Failed to fetch items: ${err?.message}`);
    return;
  }

  // Filter out items that we've already seen under their stable identity in
  // a previous run. This is what catches Sonarr/Radarr quality upgrades:
  // Jellyfin assigns the re-imported file a fresh ItemId AND a fresh
  // DateCreated, so /Items?MinDateCreated returns it as if brand-new — but
  // the stable key (TMDB for movies, SeriesId+S/E for episodes) matches a
  // record from when it was originally added.
  const cutoffMs = now.getTime() - WINDOW_MS;
  const beforeFilter = items.length;
  const fresh = items.filter((item) => {
    const firstSeenAt = recordOrGet(item, now.getTime());
    return firstSeenAt >= cutoffMs;
  });
  // Preserve the diagnostic counters from fetchWindowItems on the filtered
  // array (filter() drops these expando properties).
  fresh.rawCount = items.rawCount;
  fresh.allowedLibraryCount = items.allowedLibraryCount;
  fresh.alreadySeenCount = beforeFilter - fresh.length;
  items = fresh;
  if (items.alreadySeenCount > 0) {
    logger.info(
      `${logPrefix}: filtered ${items.alreadySeenCount} of ${beforeFilter} items as already-seen (Sonarr/Radarr upgrade or older import)`
    );
  }

  if (items.length === 0) {
    const rawCount = items.rawCount ?? 0;
    const allowedCount = items.allowedLibraryCount ?? 0;
    const alreadySeen = items.alreadySeenCount ?? 0;
    let diag;
    if (allowedCount === 0) {
      diag = "No notification libraries configured. Add libraries under Jellyfin notifications in the dashboard.";
    } else if (alreadySeen > 0) {
      diag = `Jellyfin returned ${alreadySeen} item${alreadySeen === 1 ? "" : "s"} in the past week, but all of them have been seen before (Sonarr/Radarr upgrade or older import).`;
    } else if (rawCount > 0) {
      diag = `Jellyfin returned ${rawCount} new items in the past week, but none are in your ${allowedCount} configured notification libraries. Check the library list in Jellyfin notifications.`;
    } else {
      diag = "Jellyfin returned no new items (Movie/Series/Season/Episode) in the past 7 days.";
    }
    if (isTest) throw new Error(diag);
    // warn (not info): "no items" with no configured libraries or a 0-of-N
    // mismatch is the most common silent-fail symptom users mistake for a
    // broken feature. Surfacing it loudly in the logs lets ops debug without
    // turning on debug logging.
    // Misconfig (no libraries) or rawCount-but-not-in-config is a silent-fail
    // symptom users mistake for a broken feature → warn. "Genuinely empty
    // week" and "everything was an upgrade" are normal → info.
    if (allowedCount === 0 || (rawCount > 0 && alreadySeen === 0)) {
      logger.warn(`${logPrefix}: skipping post — ${diag}`);
    } else {
      logger.info(`${logPrefix}: no new items this week — skipping post`);
    }
    resetFailures(now);
    await markPosted(now);
    return;
  }

  const grouped = groupItems(items);

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    logger.warn(
      `${logPrefix}: failed to fetch channel ${channelId}: ${err?.message}`
    );
    onError(err, `Failed to fetch channel ${channelId}: ${err?.message}`);
    return;
  }
  if (!channel) {
    const msg = `Channel ${channelId} not found or bot lacks access`;
    logger.warn(`${logPrefix}: ${msg}`);
    if (isTest) throw new Error(msg);
    bumpFailure(now);
    return;
  }

  let embed;
  try {
    embed = await buildRoundupEmbed(grouped, items);
  } catch (err) {
    logger.error(`${logPrefix}: failed to build embed: ${err?.message}`);
    onError(err, `Failed to build embed: ${err?.message}`);
    return;
  }

  try {
    await channel.send({ embeds: [embed] });
    logger.info(
      `${logPrefix} posted: ${grouped.totalCount} items across ${grouped.perLibrary.size} libraries`
    );
    if (!isTest) {
      resetFailures(now);
      await markPosted(now);
    }
  } catch (err) {
    logger.error(`${logPrefix}: failed to send embed: ${err?.message}`);
    onError(err, `Failed to send embed: ${err?.message}`);
  }
}

export async function sendWeeklyRoundupTest(client, channelId) {
  await sendWeeklyRoundup(client, channelId, new Date(), { test: true });
}

async function markPosted(now) {
  const nowIso = now.toISOString();
  // Always set the in-memory env var so this process won't re-post within the
  // same week, even if disk persistence fails. The roundup already went out —
  // don't count persistence failure as a send failure.
  process.env.WEEKLY_ROUNDUP_LAST_POSTED_AT = nowIso;
  try {
    updateConfig({ WEEKLY_ROUNDUP_LAST_POSTED_AT: nowIso });
  } catch (err) {
    logger.error(
      `Weekly Roundup: posted successfully but failed to persist lastPostedAt; a restart this week could trigger a duplicate post: ${err?.message}`
    );
  }
}

async function buildRoundupEmbed(grouped, rawItems) {
  const now = new Date();
  const start = new Date(now.getTime() - WINDOW_MS);

  const dateRange = `${formatDate(start)} – ${formatDate(now)}`;
  const color = resolveColor();

  const embed = new EmbedBuilder()
    .setTitle(t("roundup.embed_title"))
    .setDescription(dateRange)
    .setColor(color);

  const thumbnailItem = rawItems.find((i) => i.Id && i.ImageTags?.Primary);
  if (thumbnailItem) {
    const thumbUrl = buildJellyfinUrl(
      `Items/${encodeURIComponent(thumbnailItem.Id)}/Images/Primary`
    );
    embed.setThumbnail(thumbUrl);
  }

  const { map: libraryNames, failed: libraryNamesFailed } =
    await resolveLibraryNames(Array.from(grouped.perLibrary.keys()));

  for (const [libraryId, bucket] of grouped.perLibrary.entries()) {
    const name = libraryNames[libraryId] || t("roundup.library_fallback");
    embed.addFields({ name, value: renderFieldValue(bucket.entries) });
  }

  let footerText =
    grouped.overflow > 0
      ? t("roundup.footer_overflow", {
          count: grouped.totalCount,
          overflow: grouped.overflow,
        })
      : t("roundup.footer_total", { count: grouped.totalCount });
  // If we couldn't resolve real library names AND there are multiple
  // sections, every section header reads the same generic fallback — note
  // that in the footer so Discord viewers understand why headers look alike.
  if (libraryNamesFailed && grouped.perLibrary.size > 1) {
    footerText += " · " + t("roundup.library_names_unavailable");
  }
  embed.setFooter({ text: footerText });

  return embed;
}

// Discord embed field values are capped at 1024 chars. Joining everything and
// byte-slicing can cut a markdown link in half (e.g. `[**Title**](http://…`),
// producing a broken field. Build entry-by-entry until the next entry would
// overflow, then append a translated overflow hint if anything was dropped.
const FIELD_VALUE_BUDGET = 1024;
function renderFieldValue(entries) {
  let value = "";
  let dropped = 0;
  for (let i = 0; i < entries.length; i++) {
    const next = (value ? "\n" : "") + entries[i];
    if (value.length + next.length > FIELD_VALUE_BUDGET) {
      dropped = entries.length - i;
      break;
    }
    value += next;
  }
  if (dropped > 0) {
    const moreLine = "\n" + t("roundup.field_more", { count: dropped });
    if (value.length + moreLine.length <= FIELD_VALUE_BUDGET) value += moreLine;
  }
  return value;
}

async function resolveLibraryNames(libraryIds) {
  const apiKey = process.env.JELLYFIN_API_KEY;
  const baseUrl = process.env.JELLYFIN_BASE_URL;
  let libs;
  try {
    libs = await jellyfinApi.fetchLibraries(apiKey, baseUrl);
  } catch (err) {
    // Item data already came back fine; don't nuke the whole roundup just
    // because the library-names lookup blipped. Fall back to the generic
    // label and signal the caller so the embed footer can note it.
    logger.warn(
      `Weekly Roundup: failed to resolve library names, using fallback label: ${err?.message}`
    );
    return { map: {}, failed: true };
  }
  const map = {};
  for (const lib of libs || []) {
    const id = lib.ItemId || lib.Id;
    if (id && libraryIds.includes(id)) {
      map[id] = lib.Name;
    }
  }
  return { map, failed: false };
}

function formatDate(d) {
  // LANGUAGE uses locale-file keys (en/de/sv) — these happen to be valid
  // BCP-47 primary tags today. Normalize anything else (e.g. "pt_BR") to
  // its primary subtag so Intl does not throw on an unknown locale.
  const raw = process.env.LANGUAGE || "en";
  const lang = /^[a-zA-Z]{2,3}$/.test(raw) ? raw : "en";
  try {
    return d.toLocaleDateString(lang, {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch (err) {
    logger.warn(
      `Weekly Roundup: formatDate fell back to ISO for lang '${lang}': ${err?.message}`
    );
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
