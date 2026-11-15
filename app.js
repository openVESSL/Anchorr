import fs from "fs";
import path from "path";
import net from "net";
import { fileURLToPath } from "url";
import express from "express";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- MODULE IMPORTS ---
import logger from "./utils/logger.js";
import { authenticateToken } from "./utils/auth.js";
import logRouter from "./routes/logRoutes.js";
import authRouter from "./routes/authRoutes.js";
import userMappingRouter from "./routes/userMappingRoutes.js";
import configRouter from "./routes/configRoutes.js";
import seerrRouter from "./routes/seerrRoutes.js";
import jellyfinRouter from "./routes/jellyfinRoutes.js";
import { botState } from "./bot/botState.js";
import { createBotRoutes } from "./routes/botRoutes.js";
import discordRouter from "./routes/discordRoutes.js";
import saveConfigRouter from "./routes/saveConfigRoutes.js";
import testRouter from "./routes/testRoutes.js";
import setupRouter from "./routes/setupRoutes.js";
import { startBot } from "./bot/botManager.js";
import { CONFIG_PATH, loadSettings } from "./utils/configFile.js";
import { settings } from "./utils/settings.js";

// --- Helper Functions ---
// --- CONFIGURATION ---

function loadConfig() {
  logger.debug("[LOADCONFIG] Checking CONFIG_PATH:", CONFIG_PATH);
  logger.debug("[LOADCONFIG] File exists:", fs.existsSync(CONFIG_PATH));

  // Centralized loader (includes all migrations)
  const success = loadSettings();

  if (success) {
    logger.debug(
      "[LOADCONFIG] DISCORD_TOKEN:",
      settings.DISCORD_TOKEN ? "SET" : "UNDEFINED"
    );
  } else {
    logger.warn("[LOADCONFIG] No config.json found — the bot cannot start correctly.");
    if (fs.existsSync(path.join(__dirname, ".env"))) {
      logger.warn("[LOADCONFIG] A .env file was detected. Anchorr no longer reads .env — configure the bot via the web dashboard at http://localhost:8282");
    }
  }

  return success;
}

/**
 * Verify volume persistence configuration for Docker deployments
 * Detects if config directory is mounted as a proper volume and warns if misconfigured
 */
function verifyVolumeConfiguration() {
  const configDir = path.dirname(CONFIG_PATH);

  // Ensure config directory exists
  if (!fs.existsSync(configDir)) {
    try {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      logger.info(`✅ Created config directory at ${configDir}`);
    } catch (error) {
      logger.error(
        `❌ Failed to create config directory at ${configDir}:`,
        error
      );
      return;
    }
  }

  // Verify config directory is writable
  try {
    const testFile = path.join(configDir, ".volume-test");
    fs.writeFileSync(testFile, "test", { mode: 0o666 });
    fs.unlinkSync(testFile);
    logger.info(
      `✅ Config directory ${configDir} is properly configured and writable`
    );
  } catch (error) {
    if (error.code === "EACCES") {
      logger.error(`❌ CRITICAL: Cannot write to ${configDir} — volume permissions are incorrect.`);
      logger.error(`   Fix: run "chmod 777 ./anchorr-data" on the Docker host, then restart.`);
      logger.error(`   On Unraid: set the host path permissions to 777 in the share settings.`);
      process.exit(1);
    } else {
      logger.error(`❌ CRITICAL: Cannot write to ${configDir} — filesystem error (${error.code || "unknown"}).`);
      logger.error(`   Check volume mount and filesystem health.`);
      process.exit(1);
    }
  }
}

const app = express();
let port = settings.WEBHOOK_PORT || 8282;

if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

function configureWebServer() {
  // Security headers. The dashboard (frontend/) loads nothing from other origins and runs no
  // inline script; the old dashboard under /legacy still needs its CDN scripts and fonts.
  const DASHBOARD_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    // Radix and the toast library set inline styles at runtime
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    // Discord, Seerr and TMDB images come from those services
    "img-src 'self' https: http: data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
  app.use((req, res, next) => {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (!req.path.startsWith("/legacy")) {
      res.setHeader("Content-Security-Policy", DASHBOARD_CSP);
      return next();
    }
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' cdn.jsdelivr.net",
        // TODO: Remove 'unsafe-inline' from style-src once the ~200 inline style=""
        // attributes in web/index.html are moved to web/style.css or covered by a nonce.
        // script-src intentionally has no 'unsafe-inline', which is where CSP matters most.
        "style-src 'self' 'unsafe-inline' cdnjs.cloudflare.com cdn.jsdelivr.net",
        "font-src cdnjs.cloudflare.com cdn.jsdelivr.net",
        // img-src is permissive for http/https because Discord and Seerr avatars
        // can come from any user-configured origin; isSafeAvatarUrl() validates these client-side
        "img-src 'self' https: http: data:",
        "connect-src 'self'",
        "object-src 'none'",
        "frame-ancestors 'self'",
      ].join("; ")
    );
    next();
  });

  // Middleware for parsing JSON bodies - MUST be before routes that use req.body
  app.use(express.json());
  app.use(cookieParser());

  // Rate limiting middleware - DoS protection
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    // The dashboard polls status and loads several lists per page, so this is a flood
    // guard, not a tight budget
    max: 1000,
    message: {
      success: false,
      error: "Too many requests, please try again later.",
    },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Auth and setup routes (before general rate limiter so their own limiters apply)
  app.use("/api", authRouter);
  app.use("/api", setupRouter);

  // Apply rate limiting to all API endpoints (except auth and webhooks)
  app.use("/api/", apiLimiter);

  // Log routes
  app.use("/api", logRouter);

  // User mapping routes
  app.use("/api", userMappingRouter);

  // Config/language routes
  app.use("/api", configRouter);

  // Seerr routes
  app.use("/api", seerrRouter);

  // Jellyfin test/library routes
  app.use("/api", jellyfinRouter);

  // Bot management routes (health, status, start-bot, stop-bot)
  app.use("/api", createBotRoutes({ startBot }));

  // Dashboard routes
  app.use("/api", discordRouter);
  app.use("/api", saveConfigRouter);
  app.use("/api", testRouter);

  app.use("/assets", express.static(path.join(__dirname, "assets")));
  app.use("/locales", express.static(path.join(__dirname, "locales")));

  // The v1 dashboard stays reachable while the new one reaches feature parity
  app.use("/legacy", express.static(path.join(__dirname, "web")));

  // The dashboard (frontend/, built into frontend/dist). Without a build, the old one is served.
  const dashboardDir = path.join(__dirname, "frontend", "dist");
  if (fs.existsSync(path.join(dashboardDir, "index.html"))) {
    // Built files carry a content hash: cache them for good. index.html must never be
    // cached, or a browser keeps asking for the previous build's files after an update.
    app.use(
      express.static(dashboardDir, {
        index: false,
        setHeaders: (res, filePath) => {
          res.setHeader("Cache-Control", filePath.includes(`${path.sep}app${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
        },
      })
    );
    // Client-side routes (/notifications, /setup, ...) all load the same page. Paths that
    // look like files are not routes: a missing file is a 404, not the page.
    app.get(/^\/(?!api\/|legacy\/|assets\/|locales\/|app\/)[^.]*$/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(dashboardDir, "index.html"));
    });
  } else {
    logger.warn("frontend/dist not found: serving the old dashboard. Run \"npm run build\" to build the new one.");
    app.use(express.static(path.join(__dirname, "web")));
    app.get("/", (_req, res) => {
      res.sendFile(path.join(__dirname, "web", "index.html"));
    });
  }

  // Rate limiter for the webhook endpoint - prevents notification flooding / DoS
  const webhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // max 60 webhook calls per minute per IP
    message: { success: false, error: "Too many webhook requests." },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // --- LEGACY JELLYFIN WEBHOOK ENDPOINT ---
  // Anchorr now watches Jellyfin directly, so the Webhook plugin is no longer needed.
  // Calls are acknowledged and ignored (handling them too would announce items twice);
  // the dashboard shows a hint to remove the plugin. Removed in v2.1.
  let legacyWebhookWarnedAt = 0;
  app.post("/jellyfin-webhook", webhookLimiter, (req, res) => {
    botState.legacyWebhookLastSeen = Date.now();
    if (Date.now() - legacyWebhookWarnedAt > 60 * 60 * 1000) {
      legacyWebhookWarnedAt = Date.now();
      logger.warn(
        "Received a call from the Jellyfin Webhook plugin. Anchorr no longer needs it and ignores these calls; you can remove the plugin's Anchorr destination."
      );
    }
    res.status(200).json({ success: true, message: "Ignored: Anchorr no longer needs the Jellyfin Webhook plugin." });
  });

  // Global error handler middleware - must be last
  app.use((err, req, res, _next) => {
    logger.error("Express error handler:", {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
    });

    // Don't expose internal errors to client in production
    const statusCode = err.status || err.statusCode || 500;
    const message = statusCode === 500 ? "Internal server error" : err.message;

    res.status(statusCode).json({
      success: false,
      error: message,
    });
  });
}

// --- INITIALIZE AND START SERVER ---
logger.info("Initializing web server...");
configureWebServer();
logger.info("Web server configured successfully");

// --- START THE SERVER ---
// This single `app.listen` call handles both modes.
let server;

function startServer() {
  // Check volume configuration early
  verifyVolumeConfiguration();

  loadConfig();
  port = settings.WEBHOOK_PORT || 8282;
  // Default to localhost-only for bare-metal safety. Docker sets BIND_HOST=0.0.0.0
  // so that container port mapping works. Never expose the dashboard externally
  // without a reverse proxy and authentication. Must be a valid IPv4/IPv6 address.
  const bindHost = settings.BIND_HOST || "127.0.0.1";
  if (net.isIP(bindHost) === 0) {
    logger.error(
      `❌ Invalid BIND_HOST value "${bindHost}". Must be a valid IPv4 or IPv6 address (e.g. 127.0.0.1 or 0.0.0.0).`
    );
    process.exit(1);
  }
  logger.info(`Attempting to start server on port ${port} (${bindHost})...`);
  server = app.listen(port, bindHost);

  server.on("listening", () => {
    const address = server.address();
    if (address) {
      logger.info(`✅ Anchorr web server is running on ${address.address}:${address.port}.`);
      logger.info(`📝 Access it at:`);
      logger.info(`   - Local: http://127.0.0.1:${address.port}`);
      if (address.address !== "127.0.0.1") {
        logger.info(`   - Network: http://<your-server-ip>:${address.port}`);
      }
    }

    // Auto-start bot if a valid config.json is present
    try {
      const autoStartFlag = String(
        typeof settings.AUTO_START_BOT === "undefined"
          ? "true"
          : settings.AUTO_START_BOT
      )
        .trim()
        .toLowerCase();

      const autoStartDisabled = ["false", "0", "no"].includes(autoStartFlag);
      if (autoStartDisabled) {
        logger.info("ℹ️ AUTO_START_BOT is disabled. Bot will not auto-start.");
        return;
      }

      const hasConfigFile = fs.existsSync(CONFIG_PATH);
      const required = ["DISCORD_TOKEN", "BOT_ID"];
      const hasDiscordCreds = required.every(
        (k) => settings[k] && String(settings[k]).trim() !== ""
      );

      if (!botState.isBotRunning && hasConfigFile && hasDiscordCreds) {
        logger.info(
          "🚀 Detected existing config.json with Discord credentials. Auto-starting bot..."
        );
        (async () => {
          try {
            await startBot();
            logger.info("✅ Bot auto-started successfully.");
          } catch (e) {
            logger.error("❌ Bot auto-start failed:", e?.message || e);
          }
        })();
      } else if (!hasDiscordCreds) {
        logger.info(
          "ℹ️ Config found but Discord credentials are incomplete. Bot not auto-started."
        );
      }
    } catch (e) {
      logger.error("Error during auto-start check:", e?.message || e);
    }

  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      logger.error(
        `❌ Port ${port} is already in use. Please free the port or change WEBHOOK_PORT.`
      );
    } else if (err.code === "EADDRNOTAVAIL") {
      logger.error(
        `❌ Cannot bind to address "${bindHost}" (EADDRNOTAVAIL). The address set in BIND_HOST does not exist on this machine. Use 127.0.0.1 (local only) or 0.0.0.0 (all interfaces).`
      );
    } else {
      logger.error("Server error:", err);
    }
    process.exit(1);
  });
}

// Keep the process alive
process.on("SIGTERM", () => {
  logger.info("SIGTERM signal received: closing HTTP server");
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("SIGINT signal received: closing HTTP server");
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

// Catch uncaught exceptions
process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, _promise) => {
  logger.error("Unhandled Rejection:", reason);
});

startServer();
