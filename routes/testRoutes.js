// Dashboard test buttons: sample notifications, Daily Random Pick and Weekly Roundup.
import { Router } from "express";
import * as metadata from "../api/metadata.js";
import { handleJellyfinItem } from "../jellyfin/itemHandler.js";
import { sendDailyRandomPick } from "../bot/dailyPick.js";
import { botState, pendingRequests, savePendingRequests } from "../bot/botState.js";
import { sendWeeklyRoundupTest } from "../bot/weeklyRoundup.js";
import { authenticateToken } from "../utils/auth.js";
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";

const router = Router();

// Test notification endpoint - sends sample notifications with random data
router.post("/test-notification", authenticateToken, async (req, res) => {
  try {
    const { type } = req.body;

    if (!type || !["movie", "series", "season", "batch-seasons", "episodes", "batch-episodes"].includes(type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification type. Must be: movie, series, season, batch-seasons, episodes, or batch-episodes.",
      });
    }

    // Check if Discord bot is running and configured
    if (!botState.discordClient || !botState.discordClient.isReady()) {
      return res.status(400).json({
        success: false,
        message: "Discord bot is not running. Please start the bot first.",
      });
    }

    const guildId = settings.GUILD_ID;
    const channelId = settings.JELLYFIN_CHANNEL_ID;

    if (!guildId || !channelId) {
      return res.status(400).json({
        success: false,
        message: "Discord server and channel must be configured first.",
      });
    }

    // Real titles from Seerr make the test notifications realistic
    if (!metadata.isMetadataConfigured()) {
      return res.status(400).json({
        success: false,
        message: "Seerr must be configured for test notifications.",
      });
    }

    let notificationData;

    // Build realistic notification data based on type
    if (type === "movie") {
      // Interstellar TMDB ID: 157336
      const movieDetails = await metadata.getDetails(157336, "movie");
      const imdbId = await metadata.getImdbId(157336, "movie");

      notificationData = {
        ItemType: "Movie",
        Name: movieDetails.title,
        Year: movieDetails.release_date ? movieDetails.release_date.split("-")[0] : "",
        Overview: movieDetails.overview,
        Provider_tmdb: "157336",
        Provider_imdb: imdbId,
        ServerUrl: settings.JELLYFIN_BASE_URL || settings.JELLYFIN_URL || "https://jellyfin.example.com",
        ServerId: settings.JELLYFIN_SERVER_ID || "test-server-id",
        ItemId: "test-movie-" + Date.now(),
      };
    } else if (type === "series") {
      // Breaking Bad TMDB ID: 1396
      const seriesDetails = await metadata.getDetails(1396, "tv");
      const imdbId = await metadata.getImdbId(1396, "tv");

      notificationData = {
        ItemType: "Series",
        Name: seriesDetails.name,
        Year: seriesDetails.first_air_date ? seriesDetails.first_air_date.split("-")[0] : "",
        Overview: seriesDetails.overview,
        Provider_tmdb: "1396",
        Provider_imdb: imdbId,
        ServerUrl: settings.JELLYFIN_BASE_URL || settings.JELLYFIN_URL || "https://jellyfin.example.com",
        ServerId: settings.JELLYFIN_SERVER_ID || "test-server-id",
        ItemId: "test-series-" + Date.now(),
      };
    } else if (type === "season") {
      // Breaking Bad Season 1
      const seriesDetails = await metadata.getDetails(1396, "tv");
      const imdbId = await metadata.getImdbId(1396, "tv");

      notificationData = {
        ItemType: "Season",
        SeriesName: seriesDetails.name,
        SeriesId: "test-series-" + Date.now(),
        Name: "Season 1",
        SeasonNumber: 1,
        Year: seriesDetails.first_air_date ? seriesDetails.first_air_date.split("-")[0] : "",
        Overview: "High school chemistry teacher Walter White's life is suddenly transformed by a dire medical diagnosis. Street-savvy former student Jesse Pinkman \"teaches\" Walter a new trade.",
        SeriesProvider_tmdb: "1396",
        SeriesProvider_imdb: imdbId,
        ServerUrl: settings.JELLYFIN_BASE_URL || settings.JELLYFIN_URL || "https://jellyfin.example.com",
        ServerId: settings.JELLYFIN_SERVER_ID || "test-server-id",
        ItemId: "test-season-" + Date.now(),
      };
    } else if (type === "episodes") {
      // Breaking Bad first episodes
      const seriesDetails = await metadata.getDetails(1396, "tv");
      const imdbId = await metadata.getImdbId(1396, "tv");

      notificationData = {
        ItemType: "Episode",
        SeriesName: seriesDetails.name,
        SeriesId: "test-series-" + Date.now(),
        Name: "Pilot, Cat's in the Bag...",
        SeasonNumber: 1,
        EpisodeNumber: 1,
        Year: seriesDetails.first_air_date ? seriesDetails.first_air_date.split("-")[0] : "",
        Overview: "When an unassuming high school chemistry teacher discovers he has a rare form of lung cancer, he decides to team up with a former student and create a top of the line crystal meth in a used RV, to provide for his family once he is gone.",
        SeriesProvider_tmdb: "1396",
        SeriesProvider_imdb: imdbId,
        ServerUrl: settings.JELLYFIN_BASE_URL || settings.JELLYFIN_URL || "https://jellyfin.example.com",
        ServerId: settings.JELLYFIN_SERVER_ID || "test-server-id",
        ItemId: "test-episode-" + Date.now(),
      };
    } else if (type === "batch-seasons") {
      // The Mandalorian - Send 2 separate season notifications to test batching (TMDB ID: 82856)
      const seriesDetails = await metadata.getDetails(82856, "tv");
      const imdbId = await metadata.getImdbId(82856, "tv");
      const baseSeriesId = "batch-test-series-" + Date.now();

      // Send Season 1
      const season1Data = {
        ItemType: "Season",
        SeriesName: seriesDetails.name,
        SeriesId: baseSeriesId,
        Name: "Season 1",
        SeasonNumber: 1,
        Year: seriesDetails.first_air_date ? seriesDetails.first_air_date.split("-")[0] : "",
        Overview: "After the fall of the Galactic Empire, lawlessness has spread throughout the galaxy. A lone gunfighter makes his way through the outer reaches, earning his keep as a bounty hunter.",
        SeriesProvider_tmdb: "82856",
        SeriesProvider_imdb: imdbId,
        ServerUrl: settings.JELLYFIN_BASE_URL || settings.JELLYFIN_URL || "https://jellyfin.example.com",
        ServerId: settings.JELLYFIN_SERVER_ID || "test-server-id",
        ItemId: "batch-season-1-" + Date.now(),
      };

      // Send Season 2
      const season2Data = {
        ItemType: "Season",
        SeriesName: seriesDetails.name,
        SeriesId: baseSeriesId,
        Name: "Season 2",
        SeasonNumber: 2,
        Year: seriesDetails.first_air_date ? seriesDetails.first_air_date.split("-")[0] : "",
        Overview: "The Mandalorian and the Child continue their journey, facing enemies and rallying allies as they make their way through a dangerous galaxy in the tumultuous era after the collapse of the Galactic Empire.",
        SeriesProvider_tmdb: "82856",
        SeriesProvider_imdb: imdbId,
        ServerUrl: settings.JELLYFIN_BASE_URL || settings.JELLYFIN_URL || "https://jellyfin.example.com",
        ServerId: settings.JELLYFIN_SERVER_ID || "test-server-id",
        ItemId: "batch-season-2-" + Date.now(),
      };

      // Send both seasons (they should be batched together by debouncing logic)
      await handleJellyfinItem(season1Data, botState.discordClient, pendingRequests, savePendingRequests);
      await handleJellyfinItem(season2Data, botState.discordClient, pendingRequests, savePendingRequests);

      return res.json({
        success: true,
        message: `Test batch-seasons notification sent! 2 seasons should be batched together. Check your Discord channel.`,
      });
    } else if (type === "batch-episodes") {
      // Stranger Things - Send 6 separate episode notifications to test batching (TMDB ID: 66732)
      const seriesDetails = await metadata.getDetails(66732, "tv");
      const imdbId = await metadata.getImdbId(66732, "tv");
      const baseSeriesId = "batch-test-series-" + Date.now();

      const episodes = [
        { num: "01", name: "Chapter One: The Hellfire Club", overview: "Spring break turns into a nightmare when a new evil emerges in Hawkins." },
        { num: "02", name: "Chapter Two: Vecna's Curse", overview: "A plane brings Mike to California, and to his girlfriend, and to new, high school, problems." },
        { num: "03", name: "Chapter Three: The Monster and the Superhero", overview: "Murray and Joyce fly to Alaska, and El faces serious consequences. Robin and Nancy dig for information." },
        { num: "04", name: "Chapter Four: Dear Billy", overview: "Max is in grave danger, and running out of time. A patient at Pennhurst asylum has visitors. Elsewhere, in Russia, Hopper is hard at work." },
        { num: "05", name: "Chapter Five: The Nina Project", overview: "Owens takes El to Nevada, where she's forced to confront her past, while the Hawkins kids comb a crumbling house for answers." },
        { num: "06", name: "Chapter Six: The Dive", overview: "Behind the Iron Curtain, a risky rescue mission gets underway. The California crew seeks help from a hacker. Steve takes one for the team." },
      ];

      // Send all 6 episodes (they should be batched together by debouncing logic)
      for (const ep of episodes) {
        const episodeData = {
          ItemType: "Episode",
          SeriesName: seriesDetails.name,
          SeriesId: baseSeriesId,
          Name: ep.name,
          SeasonNumber: 4,
          EpisodeNumber: parseInt(ep.num),
          Year: seriesDetails.first_air_date ? seriesDetails.first_air_date.split("-")[0] : "",
          Overview: ep.overview,
          SeriesProvider_tmdb: "66732",
          SeriesProvider_imdb: imdbId,
          ServerUrl: settings.JELLYFIN_BASE_URL || settings.JELLYFIN_URL || "https://jellyfin.example.com",
          ServerId: settings.JELLYFIN_SERVER_ID || "test-server-id",
          ItemId: "batch-episode-" + ep.num + "-" + Date.now(),
        };

        await handleJellyfinItem(episodeData, botState.discordClient, pendingRequests, savePendingRequests);
        // Small delay between episodes to simulate realistic webhook timing
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      return res.json({
        success: true,
        message: `Test batch-episodes notification sent! 6 episodes should be batched together. Check your Discord channel.`,
      });
    }

    await handleJellyfinItem(notificationData, botState.discordClient, pendingRequests, savePendingRequests);

    res.json({
      success: true,
      message: `Test ${type} notification sent successfully! Check your Discord channel.`,
    });
  } catch (error) {
    logger.error("Failed to send test notification:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to send test notification. Check logs for details.",
    });
  }
});

// Test random pick endpoint - sends a sample random pick
router.post("/test-random-pick", authenticateToken, async (_req, res) => {
  try {
    // Check if Discord bot is running and configured
    if (!botState.discordClient || !botState.discordClient.isReady()) {
      return res.status(400).json({
        success: false,
        message: "Discord bot is not running. Please start the bot first.",
      });
    }

    const channelId = settings.DAILY_RANDOM_PICK_CHANNEL_ID;
    if (!channelId) {
      return res.status(400).json({
        success: false,
        message: "Daily Random Pick channel must be configured first.",
      });
    }
    if (!metadata.isMetadataConfigured()) {
      return res.status(400).json({
        success: false,
        message: "Seerr must be configured for the Daily Random Pick.",
      });
    }

    // Get random media and send it
    await sendDailyRandomPick(botState.discordClient);

    res.json({
      success: true,
      message: "Random pick sent successfully! Check your Discord channel.",
    });
  } catch (error) {
    logger.error("Failed to send test random pick:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to send random pick. Check logs for details.",
    });
  }
});

router.post("/test-weekly-roundup", authenticateToken, async (_req, res) => {
  try {
    if (!botState.discordClient || !botState.discordClient.isReady()) {
      return res.status(400).json({
        success: false,
        message: "Discord bot is not running. Please start the bot first.",
      });
    }

    const channelId = settings.WEEKLY_ROUNDUP_CHANNEL_ID;
    if (!channelId) {
      return res.status(400).json({
        success: false,
        message: "Weekly Roundup channel must be configured first.",
      });
    }

    await sendWeeklyRoundupTest(botState.discordClient, channelId);

    res.json({
      success: true,
      message: "Weekly roundup sent successfully! Check your Discord channel.",
    });
  } catch (error) {
    logger.error("Failed to send test weekly roundup:", error);
    // Cap message length, coerce to string, and strip any URL-shaped
    // substrings before returning to the dashboard. HTTP errors can
    // embeds the request URL (which may carry tokens or api_key query
    // params) in error.message; we never want that to surface in an HTTP
    // response.
    const raw =
      typeof error?.message === "string" ? error.message : String(error);
    const sanitized = raw.replace(/https?:\/\/\S+/gi, "[url]").slice(0, 500);
    res.status(500).json({
      success: false,
      message:
        sanitized || "Failed to send weekly roundup. Check logs for details.",
    });
  }
});

export default router;
