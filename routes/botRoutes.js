import { Router } from "express";
import rateLimit from "express-rate-limit";
import { createRequire } from "module";
import { authenticateToken } from "../utils/auth.js";
import { botState } from "../bot/botState.js";
import { stop as stopRoundupScheduler } from "../bot/roundupScheduler.js";
import cache from "../utils/cache.js";
import logger from "../utils/logger.js";

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require("../package.json");

const router = Router();

const botControlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public liveness probe for Docker/uptime checks: no version or bot details (audit S9)
router.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

router.get("/status", authenticateToken, (req, res) => {
  const uptime = Math.floor(process.uptime());
  const memory = process.memoryUsage();
  res.json({
    version: APP_VERSION,
    uptime,
    uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`,
    isBotRunning: botState.isBotRunning,
    botUsername:
      botState.isBotRunning && botState.discordClient?.user
        ? botState.discordClient.user.tag
        : null,
    botConnected: botState.discordClient?.ws?.status === 0,
    jellyfinConnected: Boolean(botState.jellyfinFeed?.ws && botState.jellyfinFeed.ws.readyState === 1),
    // Set when the old Jellyfin Webhook plugin still calls Anchorr (it can be removed)
    legacyWebhookLastSeen: botState.legacyWebhookLastSeen ?? null,
    // Behind a reverse proxy without TRUST_PROXY, cookies are not marked Secure and
    // rate limits see every visitor as the proxy's address (audit S13)
    proxyWithoutTrust: Boolean(req.headers["x-forwarded-for"]) && process.env.TRUST_PROXY !== "true",
    cache: cache.getStats(),
    memory: {
      used: `${Math.round(memory.heapUsed / 1024 / 1024)} MB`,
      total: `${Math.round(memory.heapTotal / 1024 / 1024)} MB`,
    },
  });
});

// Factory so routes can call startBot() from app.js
export function createBotRoutes({ startBot }) {
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

    botState.jellyfinFeed?.stop();
    botState.jellyfinFeed = null;

    try {
      stopRoundupScheduler();
      logger.info("Weekly Roundup scheduler stopped");
    } catch (error) {
      logger.error("Error stopping Weekly Roundup scheduler:", error);
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
