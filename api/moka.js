/**
 * Moka as a connection, next to Jellyfin, Seerr and Discord. Once connected (from the
 * Moka page of the dashboard, or by Moka itself when MOKA_URL is in the environment), the
 * catalog and requests go through Moka instead of Seerr. New titles are announced from
 * Jellyfin when it is linked (people watch there), otherwise from Moka.
 *
 * Catalog results come back in the snake_case TMDB shape the embeds already read, so the
 * bot code does not care which server answered.
 */
import http from "../utils/http.js";
import logger from "../utils/logger.js";
import { TIMEOUTS } from "../lib/constants.js";
import { settings } from "../utils/settings.js";

const trimUrl = (url) => String(url || "").replace(/\/+$/, "");
/** Moka's address as Anchorr reaches it (saved when connecting; MOKA_URL in the environment otherwise). */
export const mokaUrl = () => trimUrl(settings.MOKA_URL);
/** Moka is connected: the catalog and requests go through it. */
export const isMokaMode = () => Boolean(mokaUrl() && settings.MOKA_API_KEY);
export const jellyfinLinked = () => Boolean(settings.JELLYFIN_BASE_URL && settings.JELLYFIN_API_KEY);
/** New titles come from Moka only without Jellyfin: with it, Jellyfin's watch links win. */
export const announcesFromMoka = () => isMokaMode() && !jellyfinLinked();
/** The Moka allowed to set Anchorr up from its side: only one named in the environment. */
export const envMokaUrl = () => trimUrl(process.env.MOKA_URL);

/** Moka's `act as user` permission bit. */
export const ACT_AS_USER = 64;

/** One call to Moka's API with the bot's key, optionally acting for a Moka user. */
export async function moka(method, path, { key = settings.MOKA_API_KEY, asUser = null, params, data, base = mokaUrl() } = {}) {
  const headers = { Authorization: `Bearer ${key}` };
  if (asUser !== null && asUser !== undefined) headers["X-Moka-User"] = String(asUser);
  const res = await http.request({
    method,
    url: `${base}/api/v1${path}`,
    params,
    data,
    headers,
    timeout: method === "POST" ? TIMEOUTS.SEERR_POST : TIMEOUTS.SEERR_API,
  });
  return res.data;
}

// ----- catalog -----

const dateOf = (date, year) => date || (year ? `${year}-01-01` : undefined);

/** Moka catalog item -> TMDB list item. */
export function toItem(c, mediaType) {
  return {
    id: c.tmdb_id,
    media_type: mediaType,
    ...(mediaType === "movie" ? { title: c.title, release_date: dateOf(c.release_date, c.year) } : { name: c.title, first_air_date: dateOf(c.first_air_date, c.year) }),
    overview: c.overview,
    poster_path: c.poster_path,
    backdrop_path: c.backdrop_path,
    vote_average: c.vote_average,
  };
}

/** Moka catalog film/show -> TMDB details, plus `local` (Moka's own state for the title). */
export function toDetails(c, mediaType) {
  return {
    ...toItem(c, mediaType),
    runtime: c.runtime_minutes,
    episode_run_time: mediaType === "tv" && c.runtime_minutes ? [c.runtime_minutes] : [],
    genres: (c.genres || []).map((name) => ({ name })),
    seasons: (c.seasons || []).map((s) => ({ season_number: s.season_number, episode_count: s.episode_count, name: s.name })),
    external_ids: { imdb_id: c.imdb_id || null },
    credits: { crew: (c.directors || []).map((name) => ({ job: "Director", department: "Directing", name })) },
    created_by: [],
    local: c.local || null,
  };
}

// Search and lists answer films and shows apart; mixed like Seerr does
function interleave(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}

const results = (page, mediaType) => (page?.results || []).map((c) => toItem(c, mediaType));

export async function searchTitles(query) {
  const [movies, shows] = await Promise.all([
    moka("GET", "/catalog/search", { params: { q: query } }),
    moka("GET", "/catalog/shows/search", { params: { q: query } }),
  ]);
  return interleave(results(movies, "movie"), results(shows, "tv"));
}

/** A discover list (`trending`, `popular`, `upcoming`, `top_rated`, ...) of one kind. */
export async function discover(mediaType, list, page = 1) {
  const path = mediaType === "movie" ? `/catalog/discover/${list}` : `/catalog/shows/discover/${list}`;
  return results(await moka("GET", path, { params: { page } }), mediaType);
}

export async function getTrending() {
  const [movies, shows] = await Promise.all([discover("movie", "trending"), discover("tv", "trending")]);
  return interleave(movies, shows);
}

export async function getDetails(id, mediaType) {
  const kind = mediaType === "movie" ? "movie" : "show";
  return toDetails(await moka("GET", `/catalog/${kind}/${parseInt(id, 10)}`), mediaType === "movie" ? "movie" : "tv");
}

// ----- people -----

const LINKS_TTL_MS = 60_000;
let links = { at: 0, list: [] };

/**
 * Moka users with a linked Discord account, as Anchorr's user mappings
 * (`discordUserId`, `seerrUserId` = the Moka user id). Kept for a minute.
 */
export async function getDiscordLinks({ fresh = false } = {}) {
  if (!fresh && Date.now() - links.at < LINKS_TTL_MS) return links.list;
  try {
    const rows = await moka("GET", "/anchorr/links");
    links = {
      at: Date.now(),
      list: rows.map((r) => ({ discordUserId: String(r.discord_id), seerrUserId: r.user_id, seerrDisplayName: r.username })),
    };
  } catch (err) {
    logger.warn(`Could not read the Discord links from Moka: ${err.message}`);
  }
  return links.list;
}

/**
 * Requests a film or show in Moka as the Moka user linked to this Discord member, or as
 * the guest account. Moka applies that user's quota and approval rules.
 */
export async function requestAs({ tmdbId, mediaType, seasons = [], discordUserId }) {
  const linked = (await getDiscordLinks()).find((l) => l.discordUserId === String(discordUserId));
  const asUser = linked?.seerrUserId ?? (settings.MOKA_GUEST_USER_ID ? Number(settings.MOKA_GUEST_USER_ID) : null);
  if (asUser === null) {
    const err = new Error(`No Moka user to request with for Discord user ${discordUserId}`);
    err.name = "NoSeerrUserError";
    throw err;
  }
  const data = { tmdb_id: parseInt(tmdbId, 10), kind: mediaType === "tv" ? "show" : "movie" };
  if (mediaType === "tv" && Array.isArray(seasons) && seasons.length > 0 && !seasons.includes("all")) {
    data.seasons = seasons.map((s) => parseInt(s, 10));
  }
  logger.info(`[MOKA] Requesting ${mediaType} ${tmdbId} for Discord user ${discordUserId} as Moka user ${asUser}${linked ? "" : " (guest)"}`);
  return moka("POST", "/requests", { asUser, data });
}

/** `available` when Moka already has the title (for a show: every followed episode). */
export async function mediaStatus(tmdbId, mediaType) {
  const details = await getDetails(tmdbId, mediaType);
  return { exists: true, available: details.local?.state === "available" };
}

// ----- signing in to Moka (connecting, dashboard sign-in) -----

/**
 * Signs in to Moka and returns the account and the session cookie. The caller ends the
 * session with `mokaSignOut`; the password is never kept.
 */
export async function mokaSignIn(base, username, password) {
  const res = await http.post(`${base}/api/v1/auth/login`, { username, password }, { timeout: TIMEOUTS.SEERR_API });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { me: res.data, cookie };
}

export async function mokaSignOut(base, cookie) {
  if (!cookie) return;
  await http.post(`${base}/api/v1/auth/logout`, undefined, { headers: { Cookie: cookie }, timeout: TIMEOUTS.SEERR_API }).catch(() => {});
}

export const MOKA_ADMIN = 1;

// ----- requesters, when Jellyfin announces and Moka took the requests -----

/** Linked members with an open Moka request for this film or show (by TMDB id). */
export async function requestersFor(tmdbId, mediaType) {
  const kind = mediaType === "movie" ? "movie" : "show";
  const [requests, people] = await Promise.all([moka("GET", "/requests"), getDiscordLinks()]);
  const discordByName = new Map(people.map((p) => [String(p.seerrDisplayName).toLowerCase(), p.discordUserId]));
  return requests
    .filter((r) => r.kind === kind && String(r.tmdb_id) === String(tmdbId) && (r.status === "pending" || r.status === "approved"))
    .map((r) => ({ key: `moka:${kind}:${tmdbId}:${String(r.requested_by).toLowerCase()}`, discordUserId: discordByName.get(String(r.requested_by).toLowerCase()) }));
}
