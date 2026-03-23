import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateToken } from "../utils/auth.js";
import { botState } from "../bot/botState.js";
import cache from "../utils/cache.js";
import logger from "../utils/logger.js";

const { version: APP_VERSION } = await import("../package.json", { with: { type: "json" } });

const router = Router();

const botControlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/health", (req, res) => {
  const uptime = process.uptime();
  const cacheStats = cache.getStats();
  const totalHits = cacheStats.tmdb.hits + cacheStats.seerr.hits;
  const totalMisses = cacheStats.tmdb.misses + cacheStats.seerr.misses;
  const totalKeys = cacheStats.tmdb.keys + cacheStats.seerr.keys;

  res.json({
    status: "healthy",
    version: APP_VERSION,
    uptime: Math.floor(uptime),
    uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor(
      (uptime % 3600) / 60
    )}m ${Math.floor(uptime % 60)}s`,
    bot: {
      running: botState.isBotRunning,
      username:
        botState.isBotRunning && botState.discordClient?.user
          ? botState.discordClient.user.tag
          : null,
      connected: botState.discordClient?.ws?.status === 0,
    },
    cache: {
      hits: totalHits,
      misses: totalMisses,
      keys: totalKeys,
      hitRate:
        totalHits + totalMisses > 0
          ? ((totalHits / (totalHits + totalMisses)) * 100).toFixed(2) + "%"
          : "0%",
      tmdb: cacheStats.tmdb,
      seerr: cacheStats.seerr,
    },
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + " MB",
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + " MB",
    },
    timestamp: new Date().toISOString(),
  });
});

router.get("/status", authenticateToken, (req, res) => {
  res.json({
    isBotRunning: botState.isBotRunning,
    botUsername:
      botState.isBotRunning && botState.discordClient?.user
        ? botState.discordClient.user.tag
        : null,
  });
});

// Factory so routes can call startBot() and jellyfinPoller.stop() from app.js
export function createBotRoutes({ startBot, jellyfinPoller }) {
  router.post("/start-bot", botControlLimiter, authenticateToken, async (req, res) => {
    if (botState.isBotRunning) {
      return res.status(400).json({ message: "Bot is already running." });
    }
    try {
      const result = await startBot();
      res.status(200).json({ message: `Bot started successfully! ${result.message}` });
    } catch (error) {
      res.status(500).json({ message: `Failed to start bot: ${error.message}` });
    }
  });

  router.post("/stop-bot", botControlLimiter, authenticateToken, async (req, res) => {
    if (!botState.isBotRunning || !botState.discordClient) {
      return res.status(400).json({ message: "Bot is not running." });
    }

    try {
      if (botState.jellyfinWebSocketClient) {
        botState.jellyfinWebSocketClient.stop();
        botState.jellyfinWebSocketClient = null;
        logger.info("Jellyfin WebSocket client stopped");
      }
    } catch (error) {
      logger.error("Error stopping Jellyfin WebSocket client:", error);
    }

    try {
      jellyfinPoller.stop();
      logger.info("Jellyfin poller stopped");
    } catch (error) {
      logger.error("Error stopping Jellyfin poller:", error);
    }

    await botState.discordClient.destroy();
    botState.isBotRunning = false;
    botState.discordClient = null;
    logger.info("Bot has been stopped.");
    res.status(200).json({ message: "Bot stopped successfully." });
  });

  return router;
}

export default router;
