/**
 * TMDB (The Movie Database) API Client
 * Handles all TMDB API interactions with caching
 */

import axios from "axios";
import cache from "../utils/cache.js";
import logger from "../utils/logger.js";
import { TIMEOUTS } from "../lib/constants.js";

/**
 * Search for movies and TV shows
 * @param {string} query - Search query
 * @param {string} apiKey - TMDB API key
 * @returns {Promise<Array>} Search results
 */
export async function tmdbSearch(query, apiKey) {
  // Check cache first
  const cached = cache.tmdbSearch(query);
  if (cached) {
    return cached;
  }

  // Fetch from API
  const url = "https://api.themoviedb.org/3/search/multi";
  try {
    const res = await axios.get(url, {
      params: { api_key: apiKey, query, include_adult: false, page: 1 },
      timeout: TIMEOUTS.TMDB_API,
    });
    const results = res.data.results || [];
    cache.tmdbSearch(query, results);
    return results;
  } catch (err) {
    logger.error(`TMDB search failed for query "${query}": ${err.message}`);
    throw err;
  }
}

/**
 * Get trending movies and TV shows
 * @param {string} apiKey - TMDB API key
 * @returns {Promise<Array>} Trending results
 */
export async function tmdbGetTrending(apiKey) {
  // Check cache first
  const cached = cache.tmdbTrending();
  if (cached) {
    return cached;
  }

  // Fetch from API
  const url = "https://api.themoviedb.org/3/trending/all/week";
  try {
    const res = await axios.get(url, {
      params: { api_key: apiKey },
      timeout: TIMEOUTS.TMDB_API,
    });
    const results = res.data.results || [];
    cache.tmdbTrending(results);
    return results;
  } catch (err) {
    logger.error(`TMDB trending fetch failed: ${err.message}`);
    throw err;
  }
}

/**
 * Get detailed information about a movie or TV show
 * @param {number} id - TMDB ID
 * @param {string} mediaType - 'movie' or 'tv'
 * @param {string} apiKey - TMDB API key
 * @returns {Promise<Object>} Media details
 */
export async function tmdbGetDetails(id, mediaType, apiKey) {
  // Check cache first
  const cached = cache.tmdbDetails(id, mediaType);
  if (cached) {
    return cached;
  }

  // Fetch from API
  const url =
    mediaType === "movie"
      ? `https://api.themoviedb.org/3/movie/${id}`
      : `https://api.themoviedb.org/3/tv/${id}`;
  try {
    const res = await axios.get(url, {
      params: {
        api_key: apiKey,
        language: "en-US",
        append_to_response: "images,credits,external_ids",
      },
      timeout: TIMEOUTS.TMDB_API,
    });
    const details = res.data;
    cache.tmdbDetails(id, mediaType, details);
    return details;
  } catch (err) {
    logger.error(`TMDB details fetch failed for ${mediaType} ${id}: ${err.message}`);
    throw err;
  }
}

/**
 * Get external IDs (IMDb) for a movie or TV show
 * @param {number} id - TMDB ID
 * @param {string} mediaType - 'movie' or 'tv'
 * @param {string} apiKey - TMDB API key
 * @returns {Promise<string|null>} IMDb ID
 */
export async function tmdbGetExternalImdb(id, mediaType, apiKey) {
  // Check cache first
  const cached = cache.tmdbExternalIds(id, mediaType);
  if (cached) {
    return cached;
  }

  // Fetch from API
  const url =
    mediaType === "movie"
      ? `https://api.themoviedb.org/3/movie/${id}/external_ids`
      : `https://api.themoviedb.org/3/tv/${id}/external_ids`;
  try {
    const res = await axios.get(url, {
      params: { api_key: apiKey },
      timeout: TIMEOUTS.TMDB_API,
    });
    const imdbId = res.data.imdb_id || null;
    cache.tmdbExternalIds(id, mediaType, imdbId);
    return imdbId;
  } catch (err) {
    logger.error(`TMDB external IDs fetch failed for ${mediaType} ${id}: ${err.message}`);
    throw err;
  }
}

/**
 * Find the best backdrop image for a media item
 * @param {Object} details - Media details object
 * @returns {string|null} Backdrop path
 */
export function findBestBackdrop(details) {
  if (details.images?.backdrops?.length > 0) {
    const englishBackdrop = details.images.backdrops.find(
      (b) => b.iso_639_1 === "en"
    );
    if (englishBackdrop) return englishBackdrop.file_path;
  }
  return details.backdrop_path;
}

// Cache for recently picked media to avoid duplicates
const recentlyPickedMedia = new Set();
const MAX_RECENT = 20; // Remember last 20 picks

/**
 * Get a smart random media recommendation
 * Uses multiple strategies to ensure variety and avoid duplicates
 * @param {string} apiKey - TMDB API key
 * @returns {Promise<Object>} Random media item with details
 */
export async function tmdbGetRandomMedia(apiKey) {
  try {
    if (!apiKey) return null;

    const strategies = ["trending", "upcoming", "discover-variety", "discover-niche"];
    const strategy = strategies[Math.floor(Math.random() * strategies.length)];

    let results = [];

    try {
      if (strategy === "trending") {
        results = await getTrendingMedia(apiKey);
      } else if (strategy === "upcoming") {
        results = await getUpcomingMedia(apiKey);
      } else if (strategy === "discover-variety") {
        results = await getDiscoverVarietyMedia(apiKey);
      } else if (strategy === "discover-niche") {
        results = await getDiscoverNicheMedia(apiKey);
      }
    } catch (err) {
      // Strategy failed, fallback below
    }

    if (results.length === 0) {
      results = await tmdbGetTrending(apiKey);
    }

    const validResults = results.filter(
      (r) => r.media_type === "movie" || r.media_type === "tv"
    );

    if (validResults.length === 0) return null;

    const freshResults = validResults.filter((r) => !recentlyPickedMedia.has(`${r.id}-${r.media_type}`));
    let candidateResults = freshResults.length > 0 ? freshResults : validResults;
    candidateResults = candidateResults.sort(() => Math.random() - 0.5);

    const randomItem = candidateResults[0];
    if (!randomItem) return null;

    const mediaKey = `${randomItem.id}-${randomItem.media_type}`;
    recentlyPickedMedia.add(mediaKey);
    if (recentlyPickedMedia.size > MAX_RECENT) {
      const firstKey = recentlyPickedMedia.values().next().value;
      recentlyPickedMedia.delete(firstKey);
    }

    try {
      const details = await tmdbGetDetails(
        randomItem.id,
        randomItem.media_type,
        apiKey
      );
      return {
        ...randomItem,
        details,
      };
    } catch (err) {
      return randomItem;
    }
  } catch (error) {
    logger.debug(`Error getting random media: ${error.message}`);
    return null;
  }
}

async function getTrendingMedia(apiKey) {
  try {
    const trendingResults = await tmdbGetTrending(apiKey);
    if (trendingResults.length > 10) {
      const startIdx = Math.floor(Math.random() * Math.max(1, trendingResults.length - 10));
      return trendingResults.slice(startIdx, startIdx + 15);
    }
    return trendingResults;
  } catch (error) {
    return [];
  }
}

async function getUpcomingMedia(apiKey) {
  try {
    const mediaType = Math.random() < 0.5 ? "movie" : "tv";
    const url = `https://api.themoviedb.org/3/${mediaType}/${mediaType === "movie" ? "upcoming" : "on_the_air"}`;
    
    const res = await axios.get(url, {
      params: {
        api_key: apiKey,
        language: "en-US",
        page: Math.floor(Math.random() * 3) + 1,
      },
      timeout: TIMEOUTS.TMDB_API,
    });

    return (res.data.results || []).map((r) => ({
      ...r,
      media_type: mediaType,
    }));
  } catch (error) {
    logger.debug(`Upcoming fetch failed: ${error.message}`);
    return [];
  }
}

async function getDiscoverVarietyMedia(apiKey) {
  try {
    // Get a good mix of genres and popularity ranges
    const genres = [28, 12, 14, 18, 27, 35, 37, 53, 80, 99, 878, 10402, 9648, 10749, 10751, 10752];
    const randomGenre = genres[Math.floor(Math.random() * genres.length)];
    const mediaType = Math.random() < 0.5 ? "movie" : "tv";
    
    const url = `https://api.themoviedb.org/3/discover/${mediaType}`;
    
    const res = await axios.get(url, {
      params: {
        api_key: apiKey,
        with_genres: randomGenre,
        sort_by: "popularity.desc",
        "vote_count.gte": 100, // HQ filter
        language: "en-US",
        page: Math.floor(Math.random() * 5) + 1,
      },
      timeout: TIMEOUTS.TMDB_API,
    });

    return (res.data.results || []).map((r) => ({
      ...r,
      media_type: mediaType,
    }));
  } catch (error) {
    logger.debug(`Discover variety fetch failed: ${error.message}`);
    return [];
  }
}

async function getDiscoverNicheMedia(apiKey) {
  try {
    // Find hidden gems: less popular but well-rated
    const mediaType = Math.random() < 0.5 ? "movie" : "tv";
    const url = `https://api.themoviedb.org/3/discover/${mediaType}`;
    
    const res = await axios.get(url, {
      params: {
        api_key: apiKey,
        sort_by: "vote_average.desc",
        "vote_count.gte": 200, // Ensure quality
        "vote_count.lte": 5000, // Avoid huge blockbusters
        "vote_average.gte": 7.0, // Only good ratings
        language: "en-US",
        page: Math.floor(Math.random() * 10) + 1, // Pages 1-10 for variety
      },
      timeout: TIMEOUTS.TMDB_API,
    });

    return (res.data.results || []).map((r) => ({
      ...r,
      media_type: mediaType,
    }));
  } catch (error) {
    logger.debug(`Discover niche fetch failed: ${error.message}`);
    return [];
  }
}
