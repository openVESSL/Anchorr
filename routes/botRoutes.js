import { Router } from "express";
import { authenticateToken } from "../utils/auth.js";
import { botState } from "../bot/botState.js";
import cache from "../utils/cache.js";
import logger from "../utils/logger.js";

const { version: APP_VERSION } = await import("../package.json", { with: { type: "json" } });

const router = Router();

router.get("/health", (req, res) => {
  const uptime = process.uptime();
  const cacheStats = cache.getStats();

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
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      keys: cacheStats.keys,
      hitRate:
        cacheStats.hits + cacheStats.misses > 0
          ? (
              (cacheStats.hits / (cacheStats.hits + cacheStats.misses)) *
              100
            ).toFixed(2) + "%"
          : "0%",
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
  router.post("/start-bot", authenticateToken, async (req, res) => {
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

  router.post("/stop-bot", authenticateToken, async (req, res) => {
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
