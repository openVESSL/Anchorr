import { recordActivity } from "../utils/activity.js";
import { EmbedBuilder } from "discord.js";
import * as jellyfinApi from "../api/jellyfin.js";
import { getLibraryChannels } from "../jellyfin/libraryResolver.js";
import { buildJellyfinUrl } from "../utils/jellyfinUrl.js";
import { t } from "../utils/i18n.js";
import logger from "../utils/logger.js";
import { recordOrGet } from "./roundupFirstSeen.js";
import { getInstalledAt } from "./roundupState.js";
import { settings } from "../utils/settings.js";

// Rolling window of new items to include in the digest.
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Hard cap on entries rendered in the embed.
const MAX_ENTRIES = 25;

// Fetch cap before grouping.
const FETCH_LIMIT = 200;

async function fetchWindowItems() {
  const apiKey = settings.JELLYFIN_API_KEY;
  const baseUrl = settings.JELLYFIN_BASE_URL;
  if (!apiKey || !baseUrl) {
    throw new Error("JELLYFIN_API_KEY or JELLYFIN_BASE_URL not set");
  }

  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const libraryChannels = getLibraryChannels();
  if (!libraryChannels || typeof libraryChannels !== "object") {
    throw new Error("getLibraryChannels() returned an unexpected value; cannot proceed");
  }

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
  let anyTruncated = false;
  for (const libId of configuredIds) {
    let items;
    let complete;
    let truncated;
    try {
      ({ items, complete, truncated } = await jellyfinApi.fetchRecentlyAdded(
        apiKey,
        baseUrl,
        FETCH_LIMIT,
        cutoff,
        libId
      ));
    } catch (err) {
      throw new Error(
        `Failed to fetch recent items for library ${libId}: ${err?.message}`
      );
    }
    // A failed fetch is retryable, so bail and let the scheduler try again.
    if (!complete) {
      throw new Error(
        `Incomplete item fetch for library ${libId} — Jellyfin returned a partial result, skipping this run to avoid posting a truncated roundup`
      );
    }
    // Hitting the item cap is NOT retryable — a retry truncates identically.
    // Post what we have and disclose the truncation in the embed footer.
    if (truncated) {
      anyTruncated = true;
      logger.error(
        `Weekly Roundup: library ${libId} exceeded the per-library item cap; the oldest items in this window are missing from the digest and will not appear next week either`
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

  return {
    items: filtered,
    rawCount: totalRaw,
    allowedLibraryCount: configuredIds.length,
    truncated: anyTruncated,
  };
}

/**
 * Group raw items into per-library buckets of renderable entries.
 * - Movies / Series / Season items produce one entry each.
 * - Episodes are collapsed per series into a single "Series X — Season N (M episodes)" entry.
 *
 * Returns { perLibrary: Map<libraryId, { movies: string[], series: string[] }>, totalCount, overflow }.
 */
function groupItems(items) {
  // Items have already been tagged with _configLibraryId by fetchWindowItems,
  // which translates between Jellyfin's two library-ID forms.
  const getLibraryIdFor = (item) => item._configLibraryId || null;

  const episodesBySeries = new Map(); // key: libraryId|seriesId
  const entriesOut = []; // { libraryId, createdAt, showKey, seasonNumber, render }

  for (const item of items) {
    const libraryId = getLibraryIdFor(item);
    if (!libraryId) continue;

    const createdAt = item.DateCreated ? new Date(item.DateCreated) : new Date(0);

    switch (item.Type) {
      case "Movie":
        entriesOut.push({
          libraryId,
          createdAt,
          showKey: `movie|${item.Id}`,
          seasonNumber: 0,
          kind: "movie",
          render: renderMovie(item),
        });
        break;
      case "Series":
        entriesOut.push({
          libraryId,
          createdAt,
          showKey: `series|${item.Id || item.Name || ""}`,
          seasonNumber: -1,
          kind: "series-bare",
          render: renderSeries(item),
        });
        break;
      case "Season":
        entriesOut.push({
          libraryId,
          createdAt,
          showKey: `series|${item.SeriesId || item.SeriesName || ""}`,
          seasonNumber: item.IndexNumber ?? 0,
          kind: "season",
          render: renderSeason(item),
        });
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
    const lowestSeason = Math.min(...group.seasons.keys());
    entriesOut.push({
      libraryId: group.libraryId,
      createdAt: group.latestCreated,
      showKey: `series|${group.seriesId || group.seriesName || ""}`,
      seasonNumber: Number.isFinite(lowestSeason) ? lowestSeason : 0,
      kind: "episode-group",
      render: renderEpisodeGroup(group),
    });
  }

  // De-dupe per show: an episode-group already aggregates "Seasons 1–8 (177
  // episodes)", so individual Season rows and the bare Series row would just
  // repeat the same show. Without an episode-group, season rows are the real
  // content — keep them and drop the bare Series row. Movies are unaffected.
  const kindsByShow = new Map();
  for (const e of entriesOut) {
    if (!kindsByShow.has(e.showKey)) kindsByShow.set(e.showKey, new Set());
    kindsByShow.get(e.showKey).add(e.kind);
  }
  const deduped = entriesOut.filter((e) => {
    const kinds = kindsByShow.get(e.showKey);
    if (kinds.has("episode-group")) return e.kind === "episode-group";
    if (kinds.has("season")) return e.kind === "season";
    return true;
  });
  entriesOut.length = 0;
  entriesOut.push(...deduped);

  // Two-stage sort: place each show by its newest entry's createdAt (desc),
  // then within a show order rows by seasonNumber asc so Season 1, 2, 3 read
  // naturally and the bare-title row (-1) sorts first.
  const showOrder = new Map();
  for (const e of entriesOut) {
    const ts = e.createdAt.getTime();
    if (!showOrder.has(e.showKey) || ts > showOrder.get(e.showKey)) {
      showOrder.set(e.showKey, ts);
    }
  }
  entriesOut.sort((a, b) => {
    const sa = showOrder.get(a.showKey) ?? 0;
    const sb = showOrder.get(b.showKey) ?? 0;
    if (sb !== sa) return sb - sa;
    if (a.showKey !== b.showKey) return a.showKey < b.showKey ? -1 : 1;
    return a.seasonNumber - b.seasonNumber;
  });
  const capped = entriesOut.slice(0, MAX_ENTRIES);
  const overflow = Math.max(0, entriesOut.length - MAX_ENTRIES);

  const perLibrary = new Map();
  for (const entry of capped) {
    if (!perLibrary.has(entry.libraryId)) {
      perLibrary.set(entry.libraryId, { movies: [], series: [] });
    }
    const bucket = perLibrary.get(entry.libraryId);
    if (entry.kind === "movie") {
      bucket.movies.push(entry.render);
    } else {
      bucket.series.push(entry.render);
    }
  }

  return { perLibrary, totalCount: entriesOut.length, overflow };
}

function renderMovie(item) {
  const title = item.Name || t("roundup.unknown_title");
  const year = item.ProductionYear ? ` (${item.ProductionYear})` : "";
  const url = itemDeeplink(item.Id);
  if (url) return `🎬 [**${escapeMd(title)}**${escapeMd(year)}](${url})`;
  return `🎬 **${escapeMd(title)}**${escapeMd(year)}`;
}

function renderSeries(item) {
  const title = item.Name || t("roundup.unknown_title");
  const url = itemDeeplink(item.Id);
  if (url) return `📺 [**${escapeMd(title)}**](${url})`;
  return `📺 **${escapeMd(title)}**`;
}

function renderSeason(item) {
  const seriesName = item.SeriesName || t("roundup.unknown_series");
  const seasonLabel =
    item.Name || t("roundup.season_fallback", { n: item.IndexNumber ?? "?" });
  const url = itemDeeplink(item.Id);
  if (url) return `📺 [**${escapeMd(seriesName)}** — ${escapeMd(seasonLabel)}](${url})`;
  return `📺 **${escapeMd(seriesName)}** — ${escapeMd(seasonLabel)}`;
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
  // Parens are not markdown control chars inside [label] — escaping them
  // produces literal "\(2026\)" in the rendered link. Only escape the
  // chars that Discord actually treats as markdown inside link labels.
  return String(s).replace(/[\r\n]/g, " ").replace(/([\[\]\\*_~`|])/g, "\\$1");
}

export async function sendWeeklyRoundup(client, channelId, now, options = {}) {
  const isTest = options.test === true;
  const logPrefix = isTest ? "Weekly Roundup (test)" : "Weekly Roundup";

  // Errors always propagate: the test route surfaces them to the dashboard,
  // the scheduler records them as failures.

  // Preflight: a malformed JELLYFIN_BASE_URL causes buildJellyfinUrl to emit
  // an http://invalid.local/... sentinel. Catching that here means the user
  // never sees a digest full of unclickable links — they get an ops log and
  // the scheduler records the failure normally. Reaching this with no value
  // at all (empty/undefined) is also misconfig: bail the same way.
  const baseUrl = settings.JELLYFIN_BASE_URL;
  let baseUrlOk = false;
  try {
    if (baseUrl) {
      const parsed = new URL(baseUrl);
      // Mirror the SSRF guard used by the config-test routes: only http(s)
      // schemes are allowed, never file:/gopher:/etc.
      baseUrlOk = parsed.protocol === "http:" || parsed.protocol === "https:";
    }
  } catch (err) {
    logger.debug(`${logPrefix}: JELLYFIN_BASE_URL failed to parse as URL: ${err?.message}`);
  }
  if (!baseUrlOk) {
    const msg = `JELLYFIN_BASE_URL is missing or not a valid http(s) URL ("${baseUrl ?? ""}")`;
    logger.error(`${logPrefix}: ${msg}`);
    throw new Error(msg);
  }

  let fetched;
  try {
    fetched = await fetchWindowItems();
  } catch (err) {
    logger.error(`${logPrefix}: failed to fetch items: ${err?.message}`);
    throw err;
  }

  // Filter stages: installedAt floor → DateCreated cutoff → first-seen map.
  // The server-side filter is MinDateLastSaved (refresh-bumped), so we
  // enforce DateCreated here. The first-seen map catches Sonarr/Radarr
  // quality upgrades where ItemId + DateCreated reset but the stable
  // identity (TMDB / SeriesId+S/E) matches a prior record.
  const cutoffMs = now.getTime() - WINDOW_MS;
  const installedAt = getInstalledAt(now.getTime());
  const beforeFilter = fetched.items.length;
  let droppedPreInstall = 0;
  let droppedOldDateCreated = 0;
  let droppedNoDateCreated = 0;
  let droppedAlreadySeen = 0;
  const items = fetched.items.filter((item) => {
    const created = item.DateCreated ? new Date(item.DateCreated).getTime() : NaN;
    if (!Number.isFinite(created)) {
      // Safer default for a "what's new this week" digest: an item without
      // a usable DateCreated could just as easily be 5 years old as 5
      // minutes old. Drop and count rather than letting it through.
      droppedNoDateCreated++;
      return false;
    }
    if (created < installedAt) {
      droppedPreInstall++;
      return false;
    }
    if (created < cutoffMs) {
      droppedOldDateCreated++;
      return false;
    }
    const firstSeenAt = recordOrGet(item, now.getTime());
    if (firstSeenAt < cutoffMs) {
      droppedAlreadySeen++;
      return false;
    }
    return true;
  });
  logger.debug(
    `${logPrefix}: filtered ${beforeFilter} → ${items.length} items (no DateCreated: ${droppedNoDateCreated}, pre-install: ${droppedPreInstall}, old DateCreated: ${droppedOldDateCreated}, already-seen: ${droppedAlreadySeen})`
  );
  if (droppedAlreadySeen > 0) {
    logger.info(
      `${logPrefix}: filtered ${droppedAlreadySeen} of ${beforeFilter} items as already-seen (Sonarr/Radarr upgrade or older import)`
    );
  }

  if (items.length === 0) {
    const rawCount = fetched.rawCount;
    const allowedCount = fetched.allowedLibraryCount;
    // Report the reason that actually dominated, not the total drop count —
    // on the first run after install everything is dropped by the installedAt
    // floor, which is expected and has nothing to do with the dedup store.
    let diag;
    if (allowedCount === 0) {
      diag = t("roundup.diag_no_libraries");
    } else if (droppedPreInstall >= droppedAlreadySeen && droppedPreInstall > 0) {
      diag = t("roundup.diag_all_pre_install", { count: droppedPreInstall });
    } else if (droppedAlreadySeen > 0) {
      diag = t(
        droppedAlreadySeen === 1
          ? "roundup.diag_all_seen_one"
          : "roundup.diag_all_seen_many",
        { count: droppedAlreadySeen }
      );
    } else if (droppedNoDateCreated > 0) {
      diag = t("roundup.diag_no_date_created", { count: droppedNoDateCreated });
    } else if (rawCount > 0) {
      diag = t("roundup.diag_none_in_libraries", {
        count: rawCount,
        libraries: allowedCount,
      });
    } else {
      diag = t("roundup.diag_empty_week");
    }
    if (isTest) throw new Error(diag);
    // Misconfig is a silent-fail symptom users mistake for a broken feature →
    // warn. A genuinely empty week is normal → info.
    if (allowedCount === 0 || (rawCount > 0 && droppedAlreadySeen === 0 && droppedPreInstall === 0)) {
      logger.warn(`${logPrefix}: skipping post — ${diag}`);
    } else {
      logger.info(`${logPrefix}: no new items this week — skipping post`);
    }
    return false;
  }

  const grouped = groupItems(items);

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    logger.warn(
      `${logPrefix}: failed to fetch channel ${channelId}: ${err?.message}`
    );
    throw err;
  }
  if (!channel) {
    const msg = `Channel ${channelId} not found or bot lacks access`;
    logger.warn(`${logPrefix}: ${msg}`);
    throw new Error(msg);
  }

  let embed;
  try {
    embed = await buildRoundupEmbed(grouped, items, fetched.truncated);
  } catch (err) {
    logger.error(`${logPrefix}: failed to build embed: ${err?.message}`);
    throw err;
  }

  try {
    const roleId = settings.WEEKLY_ROUNDUP_ROLE_ID;
    const validRoleId = typeof roleId === "string" && /^\d{17,20}$/.test(roleId);
    const sendOptions = { embeds: [embed] };
    if (validRoleId && !isTest) {
      sendOptions.content = `<@&${roleId}>`;
      sendOptions.allowedMentions = { parse: ["roles"] };
    }
    await channel.send(sendOptions);
    if (!isTest) recordActivity("roundup", { detail: String(grouped.totalCount) });
    logger.info(
      `${logPrefix} posted: ${grouped.totalCount} items across ${grouped.perLibrary.size} libraries`
    );
  } catch (err) {
    logger.error(`${logPrefix}: failed to send embed: ${err?.message}`);
    throw err;
  }
  return true;
}

export async function sendWeeklyRoundupTest(client, channelId) {
  await sendWeeklyRoundup(client, channelId, new Date(), { test: true });
}

async function buildRoundupEmbed(grouped, rawItems, truncated = false) {
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

  const allFields = [];
  for (const [libraryId, bucket] of grouped.perLibrary.entries()) {
    const libraryName = libraryNames[libraryId] || t("roundup.library_fallback");
    // Separator field — library name as section header
    allFields.push({ name: libraryName, value: "​" });
    if (bucket.movies.length > 0) {
      allFields.push(...renderFieldGroup(t("roundup.section_movies"), bucket.movies));
    }
    if (bucket.series.length > 0) {
      allFields.push(...renderFieldGroup(t("roundup.section_series"), bucket.series));
    }
  }
  // Discord hard limit: 25 fields per embed
  let fieldsTrimmed = false;
  if (allFields.length > 25) {
    logger.warn(`[weeklyRoundup] embed field count (${allFields.length}) exceeds Discord limit of 25; trimming`);
    allFields.length = 25;
    fieldsTrimmed = true;
  }
  embed.addFields(allFields);

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
  if (libraryNamesFailed) {
    footerText += " · " + t("roundup.library_names_unavailable");
  }
  if (fieldsTrimmed) {
    footerText += " · " + t("roundup.sections_trimmed");
  }
  if (truncated) {
    footerText += " · " + t("roundup.items_truncated");
  }
  embed.setFooter({ text: footerText });

  return embed;
}

// Discord embed field values are capped at 1024 chars. Build entry-by-entry;
// when entries overflow spill into continuation fields instead of dropping them.
// Returns an array of { name, value } objects ready for embed.addFields().
const FIELD_VALUE_BUDGET = 1024;
function renderFieldGroup(name, entries) {
  const fields = [];
  let currentName = name;
  let value = "";

  for (const rawEntry of entries) {
    // Discord rejects fields with an empty value, so never let an oversized
    // entry flush an empty one.
    const entry =
      rawEntry.length > FIELD_VALUE_BUDGET
        ? rawEntry.slice(0, FIELD_VALUE_BUDGET - 1) + "…"
        : rawEntry;
    const next = (value ? "\n" : "") + entry;
    if (value.length + next.length > FIELD_VALUE_BUDGET) {
      if (value) {
        fields.push({ name: currentName, value });
        currentName = name + " " + t("roundup.field_continued");
      }
      value = entry;
    } else {
      value += next;
    }
  }
  if (value) fields.push({ name: currentName, value });

  return fields;
}

async function resolveLibraryNames(libraryIds) {
  const apiKey = settings.JELLYFIN_API_KEY;
  const baseUrl = settings.JELLYFIN_BASE_URL;
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
  // The lookup can succeed and still match nothing — e.g. the configured ids
  // are the CollectionId form while fetchLibraries returns ItemId. Without
  // this, every header silently reads the generic fallback with no log.
  const unresolved = libraryIds.filter((id) => !(id in map));
  if (unresolved.length > 0) {
    logger.warn(
      `Weekly Roundup: could not resolve names for library id(s) [${unresolved.join(", ")}] — using generic label`
    );
  }
  return {
    map,
    failed: libraryIds.length > 0 && unresolved.length === libraryIds.length,
  };
}

function formatDate(d) {
  // LANGUAGE uses locale-file keys (en/de/sv) — these happen to be valid
  // BCP-47 primary tags today. Normalize anything else (e.g. "pt_BR") to
  // its primary subtag so Intl does not throw on an unknown locale.
  const raw = settings.LANGUAGE || "en";
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
  const configured = settings.WEEKLY_ROUNDUP_EMBED_COLOR;
  if (configured && /^#?[0-9a-fA-F]{6}$/.test(configured)) {
    return configured.startsWith("#") ? configured : `#${configured}`;
  }
  return settings.EMBED_COLOR_SERIES || "#cba6f7";
}
