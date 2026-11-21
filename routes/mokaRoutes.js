// Moka as a connection. From the dashboard: connect by signing in as a Moka admin, or
// disconnect. From Moka itself (only the one named in MOKA_URL): hand over its key, guest
// account and the bot token, ask how the bot is doing, turn it off, say when titles arrive.
import crypto from "crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { discordStatus, inviteUrl } from "../api/discord.js";
import {
  ACT_AS_USER,
  announcesFromMoka,
  envMokaUrl,
  getDiscordLinks,
  isMokaMode,
  jellyfinLinked,
  moka,
  mokaEnabled,
  MOKA_ADMIN,
  mokaSignIn,
  mokaSignOut,
  mokaUrl,
} from "../api/moka.js";
import { restartBot, startJellyfinFeed, stopBot } from "../bot/botManager.js";
import { botState } from "../bot/botState.js";
import { dispatchMokaEvent } from "../jellyfin/mokaFeed.js";
import { authenticateToken } from "../utils/auth.js";
import { updateConfig } from "../utils/configFile.js";
import http from "../utils/http.js";
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";

const router = Router();

const pairLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true,
  message: { success: false, message: "Too many attempts, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const bearer = (req) => (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();

function sameKey(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Moka may set Anchorr up from its side only when MOKA_URL names it
function onlyFromEnvMoka(req, res, next) {
  if (!envMokaUrl()) return res.status(404).json({ success: false, message: "Connect Moka from Anchorr's dashboard, or set MOKA_URL." });
  next();
}

/** Calls from Moka carry the key it handed over. */
function fromMoka(req, res, next) {
  if (!sameKey(bearer(req), settings.MOKA_API_KEY)) return res.status(401).json({ success: false, message: "Unauthorized" });
  next();
}

function httpUrlOrEmpty(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.href.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/** The bot as Moka shows it. */
async function botView({ fresh = false } = {}) {
  const view = {
    bot_online: botState.isBotRunning,
    bot_name: null,
    invite_url: null,
    guilds: [],
    guild_id: settings.GUILD_ID || null,
    announce_channel_set: Boolean(settings.JELLYFIN_CHANNEL_ID),
    dashboard_url: process.env.ANCHORR_PUBLIC_URL || null,
  };
  if (!settings.DISCORD_TOKEN) return view;
  const status = await discordStatus(settings.DISCORD_TOKEN, { fresh });
  return { ...view, bot_name: status.bot.username, invite_url: inviteUrl(status.bot.id), guilds: status.guilds };
}

function discordError(res, err) {
  const status = err?.response?.status;
  logger.warn(`Moka pairing: Discord check failed: ${status ? `HTTP ${status}` : err.code || err.message}`);
  if (status === 401) return res.status(400).json({ success: false, message: "Discord did not accept this bot token" });
  if (status === 429) return res.status(429).json({ success: false, message: "Discord is rate limiting requests. Wait a few seconds and try again." });
  return res.status(502).json({ success: false, message: "Anchorr could not reach Discord" });
}

router.post("/moka/pair", onlyFromEnvMoka, pairLimiter, async (req, res) => {
  const { api_key, guest_user_id, public_url, discord_token, guild_id } = req.body || {};
  const key = String(api_key || "").trim();
  if (!key) return res.status(400).json({ success: false, message: "The Moka API key is missing." });

  // The key must work at MOKA_URL and belong to an account that acts for others: only
  // Moka's admin can make one, so a stranger cannot pair this Anchorr with their own server.
  let me;
  try {
    me = await moka("GET", "/me", { key, base: envMokaUrl() });
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) return res.status(401).json({ success: false, message: "Moka did not accept this key." });
    logger.warn(`Moka pairing: could not reach Moka at ${process.env.MOKA_URL}: ${err.message}`);
    return res.status(502).json({ success: false, message: "Anchorr could not reach Moka at its MOKA_URL." });
  }
  if (!(Number(me?.permissions) & ACT_AS_USER)) {
    return res.status(403).json({ success: false, message: "This key's account cannot act for other users." });
  }

  const publicUrl = httpUrlOrEmpty(public_url);
  if (publicUrl === null) return res.status(400).json({ success: false, message: "The public address must start with http:// or https://" });
  const token = String(discord_token || "").trim() || settings.DISCORD_TOKEN;
  if (!token) return res.status(400).json({ success: false, message: "Enter the Discord bot token." });

  let status;
  try {
    status = await discordStatus(token, { fresh: true });
  } catch (err) {
    return discordError(res, err);
  }
  // The server: the one asked for, else the one already used, else the only one the bot is in
  const inGuild = (id) => status.guilds.some((g) => g.id === id);
  const guild = [guild_id, settings.GUILD_ID].find((id) => id && inGuild(String(id))) || (status.guilds.length === 1 ? status.guilds[0].id : "");

  const saved = updateConfig({
    // Moka named in the environment setting Anchorr up is a deliberate choice: turn it on
    EXPERIMENTAL_MOKA: "true",
    MOKA_URL: envMokaUrl(),
    MOKA_API_KEY: key,
    MOKA_GUEST_USER_ID: guest_user_id ? String(guest_user_id) : "",
    MOKA_PUBLIC_URL: publicUrl,
    DISCORD_TOKEN: token,
    BOT_ID: status.bot.id,
    GUILD_ID: String(guild),
  });
  if (!saved) return res.status(500).json({ success: false, message: "Anchorr could not save its configuration. Check its config volume." });
  logger.info(`Moka: paired with ${process.env.MOKA_URL} as "${me.username}"${guild ? `, Discord server ${guild}` : ", no Discord server yet"}`);
  await getDiscordLinks({ fresh: true });

  try {
    await restartBot();
  } catch (err) {
    logger.error(`Moka pairing: the bot did not start: ${err.message}`);
  }
  res.json(await botView());
});

router.get("/moka/status", fromMoka, async (req, res) => {
  try {
    res.json(await botView());
  } catch (err) {
    discordError(res, err);
  }
});

router.delete("/moka/pair", fromMoka, async (req, res) => {
  await stopBot().catch((err) => logger.warn(`Moka: stopping the bot failed: ${err.message}`));
  updateConfig({ MOKA_API_KEY: "", DISCORD_TOKEN: "" });
  logger.info("Moka: the Discord bot was turned off in Moka");
  res.json({ success: true });
});

router.post("/moka/events", fromMoka, (req, res) => {
  res.json({ success: true });
  // With Jellyfin linked, Jellyfin announces (its watch links); Moka's event is not needed
  if (!announcesFromMoka()) return;
  // announced after answering, so Moka is never held up by Discord
  dispatchMokaEvent(req.body).catch((err) => logger.error(`Moka event failed: ${err.message}`));
});

// ----- from the dashboard -----

// Moka is offered only once it is turned on under Experimental
function onlyWhenEnabled(req, res, next) {
  if (!mokaEnabled()) return res.status(404).json({ success: false, message: "Turn on Moka under Experimental first" });
  next();
}

router.get("/moka", authenticateToken, (req, res) => {
  res.json({
    enabled: mokaEnabled(),
    connected: isMokaMode(),
    url: mokaUrl() || null,
    publicUrl: settings.MOKA_PUBLIC_URL || null,
    announcesFrom: announcesFromMoka() ? "moka" : jellyfinLinked() ? "jellyfin" : null,
  });
});

router.post("/moka/connect", pairLimiter, authenticateToken, onlyWhenEnabled, async (req, res) => {
  const { username, password } = req.body || {};
  const base = httpUrlOrEmpty(req.body?.url);
  if (!base) return res.status(400).json({ success: false, message: "Enter the Moka address, starting with http:// or https://" });
  const publicUrl = httpUrlOrEmpty(req.body?.publicUrl);
  if (publicUrl === null) return res.status(400).json({ success: false, message: "The public address must start with http:// or https://" });
  if (!username || !password) return res.status(400).json({ success: false, message: "Enter your Moka administrator username and password" });

  let session;
  try {
    session = await mokaSignIn(base, username, password);
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401) return res.status(401).json({ success: false, message: "Moka rejected this username or password" });
    if (status === 429) return res.status(429).json({ success: false, message: "Moka asks to wait before trying again" });
    logger.warn(`Moka: not reachable at ${base}: ${err.message}`);
    return res.status(502).json({ success: false, message: "Could not reach Moka at this address" });
  }
  let keys;
  try {
    if (!(Number(session.me?.permissions) & MOKA_ADMIN)) {
      return res.status(403).json({ success: false, message: "Sign in with a Moka administrator account" });
    }
    keys = (
      await http.post(`${base}/api/v1/anchorr/connect`, { public_url: publicUrl || "" }, { headers: { Cookie: session.cookie }, timeout: 20_000 })
    ).data;
  } catch (err) {
    logger.error(`Moka: could not set up the bot's account: ${err.message}`);
    return res.status(502).json({ success: false, message: "Moka did not set up the bot's account. Is it up to date?" });
  } finally {
    await mokaSignOut(base, session.cookie);
  }

  const saved = updateConfig({
    MOKA_URL: base,
    MOKA_API_KEY: keys.api_key,
    MOKA_GUEST_USER_ID: String(keys.guest_user_id),
    MOKA_PUBLIC_URL: keys.public_url || publicUrl || "",
  });
  if (!saved) return res.status(500).json({ success: false, message: "Could not save the configuration. Check the config volume permissions." });
  logger.info(`Moka: connected to ${base}; requests now go to Moka`);
  await getDiscordLinks({ fresh: true });
  await applyMokaChange();
  res.json({ success: true, announcesFrom: announcesFromMoka() ? "moka" : "jellyfin" });
});

router.delete("/moka/connect", authenticateToken, async (req, res) => {
  // empty values, not removed keys: MOKA_URL in the environment must not reconnect it
  if (!updateConfig({ MOKA_URL: "", MOKA_API_KEY: "", MOKA_GUEST_USER_ID: "", MOKA_PUBLIC_URL: "" })) {
    return res.status(500).json({ success: false, message: "Could not save the configuration. Check the config volume permissions." });
  }
  logger.info("Moka: disconnected; requests go to Seerr again");
  await applyMokaChange();
  res.json({ success: true });
});

/** The /request options and where new titles come from change with Moka: restart the bot. */
async function applyMokaChange() {
  if (!botState.isBotRunning) return;
  try {
    await restartBot();
  } catch (err) {
    logger.error(`Moka: the bot did not restart: ${err.message}`);
    startJellyfinFeed();
  }
}

export default router;
