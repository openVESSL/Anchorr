import axios from "axios";
import logger from "../utils/logger.js";
import { TIMEOUTS } from "../lib/constants.js";

/**
 * Fetches movie/TV data from OMDb API
 * @param {string} imdbId - IMDb ID (e.g., "tt1234567")
 * @returns {Promise<Object|null>} OMDb data or null if unavailable
 */
export async function fetchOMDbData(imdbId) {
  if (!imdbId || !process.env.OMDB_API_KEY) return null;
  try {
    const res = await axios.get("http://www.omdbapi.com/", {
      params: { i: imdbId, apikey: process.env.OMDB_API_KEY },
      timeout: TIMEOUTS.OMDB_API,
    });
    return res.data;
  } catch (err) {
    logger.warn(`OMDb fetch failed for ${imdbId}: ${err?.message || err}`);
    return null;
  }
}
