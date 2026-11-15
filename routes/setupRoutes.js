// First-run and connection setup: Jellyfin and Seerr are linked by signing in with a
// Jellyfin administrator account (or by pasting API keys). Passwords are never stored.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getOrCreateApiKey, getPublicServerInfo, isAdminApiKey, signIn, signOut } from "../api/jellyfinAdmin.js";
import { getApiKeyWithJellyfinLogin, getSeerrVersion } from "../api/seerr.js";
import { prepareGuestUser } from "../bot/guestUser.js";
import { restartBot, startJellyfinFeed } from "../bot/botManager.js";
import { botState } from "../bot/botState.js";
import { inviteUrl, listBotGuilds, verifyBotToken } from "../api/discord.js";
import { isMaskedValue } from "../utils/configSanitize.js";
import { authenticateToken, issueSession } from "../utils/auth.js";
import { updateConfig } from "../utils/configFile.js";
import logger from "../utils/logger.js";
import { normalizeSeerrUrl } from "../utils/seerrUrl.js";
import { settings } from "../utils/settings.js";
import { getUsers } from "../utils/userStore.js";

const router = Router();

const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true, // only failed attempts count
  message: { success: false, message: "Too many attempts, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const isFirstRun = () => !settings.JELLYFIN_API_KEY && getUsers().length === 0;

// Until Jellyfin is linked, anyone who reaches the dashboard may try the Jellyfin step:
// proving Jellyfin administrator access is what claims this Anchorr (audit S4).
// Everything after that needs a signed-in session.
function firstRunOrSignedIn(req, res, next) {
  return isFirstRun() ? next() : authenticateToken(req, res, next);
}

function httpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const statusOf = (err) => err?.response?.status;

router.get("/setup/state", (req, res) => {
  res.json({
    needsSetup: isFirstRun(),
    jellyfin: Boolean(settings.JELLYFIN_BASE_URL && settings.JELLYFIN_API_KEY),
    seerr: Boolean(settings.SEERR_URL && settings.SEERR_API_KEY),
    discord: Boolean(settings.DISCORD_TOKEN && settings.BOT_ID),
    discordServer: Boolean(settings.GUILD_ID),
    localAccount: getUsers().length > 0,
  });
});

router.post("/setup/jellyfin", setupLimiter, firstRunOrSignedIn, async (req, res) => {
  const { username, password, apiKey } = req.body || {};
  const baseUrl = httpUrl(req.body?.url);
  if (!baseUrl) return res.status(400).json({ success: false, message: "Enter the Jellyfin address, starting with http:// or https://" });

  let info;
  try {
    info = await getPublicServerInfo(baseUrl);
  } catch (err) {
    logger.warn(`Setup: Jellyfin not reachable at ${new URL(baseUrl).host}: ${err.message}`);
    return res.status(400).json({ success: false, message: "Could not reach Jellyfin at this address" });
  }

  let key;
  let admin;
  if (apiKey) {
    try {
      if (!(await isAdminApiKey(baseUrl, apiKey))) {
        return res.status(403).json({ success: false, message: "This API key is not accepted by Jellyfin, or is not an administrator key" });
      }
    } catch (err) {
      return res.status(502).json({ success: false, message: "Could not check the API key with Jellyfin" });
    }
    key = apiKey;
    admin = { id: "jellyfin:api-key", username: "Jellyfin administrator" };
  } else {
    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Enter your Jellyfin administrator username and password" });
    }
    let session;
    try {
      session = await signIn(baseUrl, username, password);
    } catch (err) {
      if (statusOf(err) === 401) return res.status(401).json({ success: false, message: "Jellyfin rejected this username or password" });
      return res.status(502).json({ success: false, message: "Could not sign in to Jellyfin" });
    }
    try {
      if (!session.isAdmin) {
        return res.status(403).json({ success: false, message: "Sign in with a Jellyfin administrator account" });
      }
      key = (await getOrCreateApiKey(baseUrl, session.token)).apiKey;
      admin = { id: `jellyfin:${session.userId}`, username: session.username };
    } catch (err) {
      logger.error(`Setup: could not create the Jellyfin API key: ${err.message}`);
      return res.status(502).json({ success: false, message: "Could not create an API key in Jellyfin" });
    } finally {
      await signOut(baseUrl, session.token);
    }
  }

  const claiming = isFirstRun();
  const changed = settings.JELLYFIN_API_KEY !== key || settings.JELLYFIN_BASE_URL !== baseUrl;
  if (!updateConfig({ JELLYFIN_BASE_URL: baseUrl, JELLYFIN_API_KEY: key, JELLYFIN_SERVER_ID: info.serverId })) {
    return res.status(500).json({ success: false, message: "Could not save the configuration. Check the config volume permissions." });
  }
  if (claiming) issueSession(req, res, { id: admin.id, username: admin.username, method: "jellyfin" });
  if (changed) startJellyfinFeed();
  logger.info(`Setup: linked Jellyfin "${info.serverName}" (${info.version})`);
  res.json({ success: true, serverName: info.serverName, version: info.version, signedIn: claiming });
});

router.post("/setup/seerr", setupLimiter, authenticateToken, async (req, res) => {
  const { username, password } = req.body || {};
  const url = httpUrl(req.body?.url);
  if (!url) return res.status(400).json({ success: false, message: "Enter the Seerr address, starting with http:// or https://" });
  const seerrUrl = normalizeSeerrUrl(url);

  let key = req.body?.apiKey;
  let version;
  try {
    if (!key) {
      if (!username || !password) {
        return res.status(400).json({ success: false, message: "Enter the Jellyfin account you use to sign in to Seerr, or Seerr's API key" });
      }
      key = await getApiKeyWithJellyfinLogin(seerrUrl, username, password);
    }
    version = await getSeerrVersion(seerrUrl, key);
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      return res.status(401).json({ success: false, message: "Seerr did not accept these credentials, or the account is not a Seerr admin" });
    }
    logger.warn(`Setup: Seerr check failed: ${err.message}`);
    return res.status(502).json({ success: false, message: "Could not reach Seerr at this address" });
  }

  const sameServer = normalizeSeerrUrl(settings.SEERR_URL || "") === seerrUrl;
  const update = { SEERR_URL: seerrUrl, SEERR_API_KEY: key };
  if (!sameServer) update.SEERR_GUEST_USER_ID = ""; // a guest id belongs to one Seerr
  if (!updateConfig(update)) {
    return res.status(500).json({ success: false, message: "Could not save the configuration. Check the config volume permissions." });
  }
  const guestUserId = await prepareGuestUser();
  logger.info(`Setup: linked Seerr ${version ?? ""}`.trim());
  res.json({ success: true, version, guestAccount: guestUserId !== null });
});

// ----- Discord -----

// Discord rate-limits these lookups; the dashboard asks often (page loads, refocus)
const DISCORD_CACHE_MS = 30_000;
let discordCache = null;

async function discordStatus(token, { fresh = false } = {}) {
  if (!fresh && discordCache?.token === token && Date.now() - discordCache.at < DISCORD_CACHE_MS) return discordCache.status;
  const bot = await verifyBotToken(token);
  const status = { bot, guilds: await listBotGuilds(token) };
  discordCache = { token, at: Date.now(), status };
  return status;
}

/** Logs the real reason and answers with something the user can act on. */
function discordFailure(res, err, action) {
  const status = statusOf(err);
  logger.warn(`Setup: Discord ${action} failed: ${status ? `HTTP ${status}` : err.code || err.message}`);
  if (status === 401) return res.status(401).json({ success: false, message: "Discord did not accept this bot token" });
  if (status === 429) return res.status(429).json({ success: false, message: "Discord is rate limiting requests. Wait a few seconds and try again." });
  return res.status(502).json({ success: false, message: "Could not reach Discord" });
}

router.post("/setup/discord", setupLimiter, authenticateToken, async (req, res) => {
  const submitted = String(req.body?.token || "").trim();
  const token = isMaskedValue(submitted) ? settings.DISCORD_TOKEN : submitted;
  if (!token) return res.status(400).json({ success: false, message: "Paste the bot token from the Discord Developer Portal" });

  let status;
  try {
    status = await discordStatus(token, { fresh: true });
  } catch (err) {
    return discordFailure(res, err, "token check");
  }
  if (!updateConfig({ DISCORD_TOKEN: token, BOT_ID: status.bot.id })) {
    return res.status(500).json({ success: false, message: "Could not save the configuration. Check the config volume permissions." });
  }
  res.json({
    success: true,
    botName: status.bot.username,
    membersIntent: status.bot.membersIntent,
    inviteUrl: inviteUrl(status.bot.id),
    guilds: status.guilds,
  });
});

router.get("/setup/discord", authenticateToken, async (req, res) => {
  if (!settings.DISCORD_TOKEN) return res.json({ success: true, configured: false });
  try {
    const status = await discordStatus(settings.DISCORD_TOKEN, { fresh: req.query.refresh === "1" });
    res.json({
      success: true,
      configured: true,
      botName: status.bot.username,
      membersIntent: status.bot.membersIntent,
      inviteUrl: inviteUrl(status.bot.id),
      guilds: status.guilds,
      guildId: settings.GUILD_ID || null,
      botRunning: botState.isBotRunning,
    });
  } catch (err) {
    discordFailure(res, err, "status");
  }
});

// Picks the server and (re)starts the bot so commands register there. Picking the server
// the running bot already uses changes nothing.
router.post("/setup/discord/server", setupLimiter, authenticateToken, async (req, res) => {
  const guildId = String(req.body?.guildId || "");
  if (!settings.DISCORD_TOKEN) return res.status(400).json({ success: false, message: "Add the bot token first" });
  let guilds;
  try {
    guilds = (await discordStatus(settings.DISCORD_TOKEN)).guilds;
  } catch (err) {
    return discordFailure(res, err, "server list");
  }
  const guild = guilds.find((g) => g.id === guildId);
  if (!guild) return res.status(400).json({ success: false, message: "The bot is not in that server yet. Invite it first." });
  if (guildId === settings.GUILD_ID && botState.isBotRunning) {
    return res.json({ success: true, guild, botRunning: true, unchanged: true });
  }
  if (!updateConfig({ GUILD_ID: guildId })) {
    return res.status(500).json({ success: false, message: "Could not save the configuration. Check the config volume permissions." });
  }
  try {
    await restartBot();
    res.json({ success: true, guild, botRunning: botState.isBotRunning });
  } catch (err) {
    logger.error(`Setup: the bot did not start: ${err.message}`);
    res.status(502).json({ success: false, message: "Server saved, but the bot did not start. Check the token and intents." });
  }
});

export default router;
