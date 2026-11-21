/**
 * Movie/TV metadata from Seerr (search, trending, details, ratings, discover).
 * Seerr proxies TMDB, so no separate TMDB or OMDb key is needed. Results are returned
 * in the snake_case TMDB shape the embeds already use; `getExtras` returns the
 * OMDb-style fields (imdbRating, Director, Writer) the embeds read.
 */
import http from "../utils/http.js";
import cache from "../utils/cache.js";
import logger from "../utils/logger.js";
import { TIMEOUTS } from "../lib/constants.js";
import { getSeerrApiUrl } from "../utils/seerrUrl.js";
import { settings } from "../utils/settings.js";
import * as mokaApi from "./moka.js";

// Titles, overviews and genres follow the bot language; TMDB falls back to English per field.
const language = () => settings.LANGUAGE || "en";

export function isMetadataConfigured() {
  if (mokaApi.isMokaMode()) return true;
  return Boolean(settings.SEERR_URL && settings.SEERR_API_KEY);
}

// Seerr rejects "+" for spaces (400 on /search), so encode with %20.
const encodeQuery = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

async function seerrGet(path, params = {}) {
  const query = encodeQuery({ language: language(), ...params });
  const res = await http.get(`${getSeerrApiUrl(settings.SEERR_URL)}${path}?${query}`, {
    headers: { "X-Api-Key": settings.SEERR_API_KEY },
    timeout: TIMEOUTS.SEERR_API,
  });
  return res.data;
}

// Seerr list item (camelCase) -> TMDB list item (snake_case)
function toTmdbItem(item, mediaType = item.mediaType) {
  return {
    id: item.id,
    media_type: mediaType,
    title: item.title,
    name: item.name,
    release_date: item.releaseDate,
    first_air_date: item.firstAirDate,
    overview: item.overview,
    poster_path: item.posterPath,
    backdrop_path: item.backdropPath,
    vote_average: item.voteAverage,
    original_language: item.originalLanguage,
  };
}

// Seerr movie/tv details -> TMDB details fields used by the embeds
function toTmdbDetails(d, mediaType) {
  return {
    ...toTmdbItem(d, mediaType),
    runtime: d.runtime,
    // Often empty: TMDB stopped filling it and Seerr exposes no per-episode runtime.
    episode_run_time: mediaType === "tv" ? d.episodeRunTime || [] : undefined,
    genres: d.genres || [],
    seasons: (d.seasons || []).map((s) => ({
      season_number: s.seasonNumber,
      episode_count: s.episodeCount,
      name: s.name,
    })),
    external_ids: { imdb_id: d.externalIds?.imdbId || d.imdbId || null },
    credits: { crew: d.credits?.crew || [] },
    created_by: d.createdBy || [],
  };
}

export async function searchTitles(query) {
  const cached = cache.search(query);
  if (cached) return cached;
  try {
    const results = mokaApi.isMokaMode()
      ? await mokaApi.searchTitles(query)
      : ((await seerrGet("/search", { query, page: 1 })).results || []).map((r) => toTmdbItem(r));
    cache.search(query, results);
    return results;
  } catch (err) {
    logger.error(`Seerr search failed for query "${query}": ${err.message}`);
    throw err;
  }
}

export async function getTrending() {
  const cached = cache.trending();
  if (cached) return cached;
  try {
    const results = mokaApi.isMokaMode()
      ? await mokaApi.getTrending()
      : ((await seerrGet("/discover/trending", { page: 1 })).results || []).map((r) => toTmdbItem(r));
    cache.trending(results);
    return results;
  } catch (err) {
    logger.error(`Seerr trending fetch failed: ${err.message}`);
    throw err;
  }
}

export async function getDetails(id, mediaType) {
  const cached = cache.details(id, mediaType);
  if (cached) return cached;
  try {
    const details = mokaApi.isMokaMode()
      ? await mokaApi.getDetails(id, mediaType)
      : toTmdbDetails(await seerrGet(`/${mediaType === "movie" ? "movie" : "tv"}/${id}`), mediaType === "movie" ? "movie" : "tv");
    cache.details(id, mediaType, details);
    return details;
  } catch (err) {
    logger.error(`Seerr details fetch failed for ${mediaType} ${id}: ${err.message}`);
    throw err;
  }
}

// Seerr request status: 1 pending, 2 approved, 3 declined, 4 failed, 5 completed
const OPEN_REQUEST_STATUSES = new Set([1, 2]);
// Seerr can notice the item first and complete the request before Anchorr announces it
const RECENTLY_COMPLETED_MS = 24 * 60 * 60 * 1000;

/**
 * The title's Seerr requests whose requester should hear it is available: open ones and
 * ones completed in the last day. Not cached, since a cached list can predate the request.
 * Empty when Seerr does not know the title, null when Seerr could not be asked.
 */
export async function getTitleRequests(id, mediaType, now = Date.now()) {
  if (!isMetadataConfigured()) return null;
  try {
    const data = await seerrGet(`/${mediaType === "movie" ? "movie" : "tv"}/${id}`);
    return (data?.mediaInfo?.requests || [])
      .filter((r) => r?.id != null && r.requestedBy?.id != null)
      .filter((r) => OPEN_REQUEST_STATUSES.has(r.status) || (r.status === 5 && now - Date.parse(r.updatedAt) < RECENTLY_COMPLETED_MS))
      .map((r) => ({ id: String(r.id), seerrUserId: String(r.requestedBy.id) }));
  } catch (err) {
    if (err.response?.status === 404) return [];
    logger.warn(`Could not read the Seerr requests for ${mediaType} ${id}: ${err.message}`);
    return null;
  }
}

export async function getImdbId(id, mediaType) {
  const details = await getDetails(id, mediaType);
  return details.external_ids.imdb_id;
}

/**
 * OMDb-style extras: imdbRating (IMDb via Seerr for movies, TMDB score otherwise), Genre, Plot,
 * Director (movies) and Writer (first creator for TV). Never throws: returns null.
 */
export async function getExtras(id, mediaType) {
  const cacheType = `${mediaType}-extras`;
  const cached = cache.details(id, cacheType);
  if (cached) return cached;
  try {
    const details = await getDetails(id, mediaType);
    let imdbScore = null;
    // Moka has no IMDb score; the TMDB score below is used instead
    if (mediaType === "movie" && !mokaApi.isMokaMode()) {
      try {
        // this endpoint rejects the language parameter (400)
        imdbScore = (await seerrGet(`/movie/${id}/ratingscombined`, { language: undefined }))?.imdb?.criticsScore ?? null;
      } catch (err) {
        logger.debug(`Seerr ratings unavailable for movie ${id}: ${err.message}`);
      }
    }
    const fallbackScore = details.vote_average > 0 ? details.vote_average.toFixed(1) : null;
    const directors = details.credits.crew.filter((c) => c.job === "Director").map((c) => c.name);
    const writers = mediaType === "tv"
      ? details.created_by.map((c) => c.name)
      : details.credits.crew.filter((c) => c.department === "Writing").map((c) => c.name);
    const extras = {
      imdbRating: imdbScore != null ? String(imdbScore) : fallbackScore,
      Director: directors.length ? [...new Set(directors)].join(", ") : null,
      Writer: writers.length ? [...new Set(writers)].join(", ") : null,
      Genre: details.genres.map((g) => g.name).join(", ") || null,
      Plot: details.overview || null,
    };
    cache.details(id, cacheType, extras);
    return extras;
  } catch (err) {
    logger.warn(`Could not load extra metadata for ${mediaType} ${id}: ${err.message}`);
    return null;
  }
}

// ----- Daily Random Pick -----

const recentlyPicked = new Set();
const MAX_RECENT = 20;
const randomInt = (max) => Math.floor(Math.random() * max);
const randomType = () => (Math.random() < 0.5 ? "movie" : "tv");
const discoverPath = (type) => (type === "movie" ? "/discover/movies" : "/discover/tv");

// Moka's lists stand in for Seerr's discover filters
const MOKA_LISTS = { upcoming: { movie: "upcoming", tv: "popular" }, variety: { movie: "popular", tv: "popular" }, niche: { movie: "top_rated", tv: "top_rated" } };

async function discover(path, mediaType, params, strategy) {
  if (mokaApi.isMokaMode()) {
    return mokaApi.discover(mediaType, MOKA_LISTS[strategy][mediaType], params.page || 1).catch((err) => {
      logger.debug(`Moka ${strategy} list failed: ${err.message}`);
      return [];
    });
  }
  try {
    const data = await seerrGet(path, params);
    return (data.results || []).map((r) => toTmdbItem(r, mediaType));
  } catch (err) {
    logger.debug(`Discover ${path} failed: ${err.message}`);
    return [];
  }
}

const STRATEGIES = {
  async trending() {
    const results = await getTrending().catch(() => []);
    if (results.length <= 10) return results;
    const start = randomInt(Math.max(1, results.length - 10));
    return results.slice(start, start + 15);
  },
  upcoming() {
    const type = randomType();
    return discover(`${discoverPath(type)}/upcoming`, type, { page: randomInt(3) + 1 }, "upcoming");
  },
  variety() {
    const genres = [28, 12, 14, 18, 27, 35, 37, 53, 80, 99, 878, 10402, 9648, 10749, 10751, 10752];
    const type = randomType();
    return discover(discoverPath(type), type, {
      genre: genres[randomInt(genres.length)],
      voteCountGte: 100,
      page: randomInt(5) + 1,
    }, "variety");
  },
  niche() {
    const type = randomType();
    return discover(discoverPath(type), type, {
      sortBy: "vote_average.desc",
      voteAverageGte: 7,
      voteCountGte: 200,
      voteCountLte: 5000,
      page: randomInt(10) + 1,
    }, "niche");
  },
};

/** A random movie or show (trending, upcoming, genre mix or hidden gem), avoiding recent picks. */
export async function getRandomMedia() {
  try {
    if (!isMetadataConfigured()) return null;
    const names = Object.keys(STRATEGIES);
    const strategy = names[randomInt(names.length)];
    let results = await STRATEGIES[strategy]();
    if (results.length === 0) results = await getTrending();

    const valid = results.filter((r) => r.media_type === "movie" || r.media_type === "tv");
    if (valid.length === 0) return null;
    const fresh = valid.filter((r) => !recentlyPicked.has(`${r.id}-${r.media_type}`));
    const pool = fresh.length > 0 ? fresh : valid;
    const pick = pool[randomInt(pool.length)];

    recentlyPicked.add(`${pick.id}-${pick.media_type}`);
    if (recentlyPicked.size > MAX_RECENT) recentlyPicked.delete(recentlyPicked.values().next().value);

    try {
      return { ...pick, details: await getDetails(pick.id, pick.media_type) };
    } catch (err) {
      logger.warn(`Failed to fetch details for random pick ${pick.id}: ${err.message}`);
      return pick;
    }
  } catch (err) {
    logger.debug(`Error getting random media: ${err.message}`);
    return null;
  }
}

/** Backdrop to show for a details object (Seerr exposes one backdrop per title). */
export function findBestBackdrop(details) {
  return details.backdrop_path;
}
