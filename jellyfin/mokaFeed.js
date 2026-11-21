/**
 * New films and episodes from Moka, when Jellyfin is not linked. Anchorr asks Moka every
 * minute for what arrived since the last check (and Moka may also post each event right
 * away when it set Anchorr up itself). Each one becomes the same payload the Jellyfin feed
 * produces and goes through the same handler, so dedup, batching and routing are shared.
 */
import { moka } from "../api/moka.js";
import { botState, pendingRequests, savePendingRequests } from "../bot/botState.js";
import logger from "../utils/logger.js";
import { PersistentMap } from "../utils/persistentMap.js";
import { ticksToHhMmSs } from "./feed.js";
import { handleJellyfinItem } from "./itemHandler.js";

const NEVER_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const CURSOR_KEY = "since";

const POLL_INTERVAL_MS = Number(process.env.JELLYFIN_POLLING_INTERVAL) || 60_000;

const state = new PersistentMap("moka-feed", NEVER_TTL_MS);

const runtime = (minutes) => (minutes ? ticksToHhMmSs(minutes * 60 * 10_000_000) : undefined);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

/** A Moka event -> the Jellyfin-style items it stands for (a film, or a show's episodes). */
export function toPayloads(event) {
  const t = event?.title;
  if (!t?.id) return [];
  const common = {
    FromMoka: true,
    MokaTitleId: t.id,
    MokaLink: t.link,
    MokaRequesterIds: event.requester_user_ids || [],
    Year: t.year,
  };
  if (t.kind === "movie") {
    return [
      clean({
        ...common,
        ItemType: "Movie",
        ItemId: `moka-${t.id}`,
        Name: t.title,
        Overview: t.overview,
        RunTime: runtime(t.runtime_minutes),
        Provider_tmdb: t.tmdb_id ? String(t.tmdb_id) : undefined,
        Provider_imdb: t.imdb_id,
      }),
    ];
  }
  if (t.kind !== "show") return [];
  return (t.episodes || []).map((e) =>
    clean({
      ...common,
      ItemType: "Episode",
      ItemId: `moka-${e.id}`,
      SeriesId: `moka-${t.id}`,
      SeriesName: t.title,
      Name: e.name,
      Overview: e.overview,
      RunTime: runtime(e.runtime_minutes ?? t.runtime_minutes),
      SeasonNumber: e.season,
      EpisodeNumber: e.episode,
      IndexNumber: e.episode,
      SeriesProvider_tmdb: t.tmdb_id ? String(t.tmdb_id) : undefined,
      SeriesProvider_imdb: t.imdb_id,
    })
  );
}

/** Announces one event. Never throws. */
export async function dispatchMokaEvent(event) {
  if (event?.event !== "available") return;
  const client = botState.discordClient;
  if (!client || !botState.isBotRunning) {
    logger.debug("Moka event while the bot is offline; it is read back on the next start");
    return;
  }
  for (const payload of toPayloads(event)) {
    await handleJellyfinItem(payload, client, pendingRequests, savePendingRequests);
  }
  if (event.occurred_at > (state.get(CURSOR_KEY) || 0)) {
    state.set(CURSOR_KEY, event.occurred_at);
  }
}

/** Reads back what arrived while the bot was offline and announces it (dedup drops repeats). */
export async function catchUpFromMoka() {
  const since = state.get(CURSOR_KEY);
  if (!since) {
    // first start: announce only what arrives from now on
    state.set(CURSOR_KEY, Math.floor(Date.now() / 1000));
    state.flush();
    return;
  }
  try {
    const events = await moka("GET", "/anchorr/available", { params: { since } });
    if (events.length) logger.info(`Moka: announcing ${events.length} title(s) that arrived while the bot was offline`);
    for (const e of events) await dispatchMokaEvent(e);
    state.flush();
  } catch (err) {
    logger.warn(`Moka: could not read what arrived while the bot was offline: ${err.message}`);
  }
}

let polling = false;

/** Checks Moka now and every minute; `stop()` ends it. */
export function startMokaFeed() {
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      await catchUpFromMoka();
    } finally {
      polling = false;
    }
  };
  poll();
  const timer = setInterval(poll, POLL_INTERVAL_MS);
  timer.unref?.();
  logger.info(`📡 Watching Moka for new titles (checked every ${Math.round(POLL_INTERVAL_MS / 1000)} s)`);
  return { stop: () => clearInterval(timer), ws: null };
}
