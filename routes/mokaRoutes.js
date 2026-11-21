// What Moka calls: it hands over its key, guest account and the bot token, asks how the
// bot is doing, turns it off, and says when titles arrive. Only in Moka mode (MOKA_URL).
import crypto from "crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { discordStatus, inviteUrl } from "../api/discord.js";
import { ACT_AS_USER, getDiscordLinks, isMokaMode, moka } from "../api/moka.js";
import { restartBot, stopBot } from "../bot/botManager.js";
import { botState } from "../bot/botState.js";
import { dispatchMokaEvent } from "../jellyfin/mokaFeed.js";
import { updateConfig } from "../utils/configFile.js";
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

function onlyInMokaMode(req, res, next) {
  if (!isMokaMode()) return res.status(404).json({ success: false, message: "Moka mode is off: MOKA_URL is not set." });
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

router.post("/moka/pair", onlyInMokaMode, pairLimiter, async (req, res) => {
  const { api_key, guest_user_id, public_url, discord_token, guild_id } = req.body || {};
  const key = String(api_key || "").trim();
  if (!key) return res.status(400).json({ success: false, message: "The Moka API key is missing." });

  // The key must work at MOKA_URL and belong to an account that acts for others: only
  // Moka's admin can make one, so a stranger cannot pair this Anchorr with their own server.
  let me;
  try {
    me = await moka("GET", "/me", { key });
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

router.get("/moka/status", onlyInMokaMode, fromMoka, async (req, res) => {
  try {
    res.json(await botView());
  } catch (err) {
    discordError(res, err);
  }
});

router.delete("/moka/pair", onlyInMokaMode, fromMoka, async (req, res) => {
  await stopBot().catch((err) => logger.warn(`Moka: stopping the bot failed: ${err.message}`));
  updateConfig({ MOKA_API_KEY: "", DISCORD_TOKEN: "" });
  logger.info("Moka: the Discord bot was turned off in Moka");
  res.json({ success: true });
});

router.post("/moka/events", onlyInMokaMode, fromMoka, (req, res) => {
  res.json({ success: true });
  // announced after answering, so Moka is never held up by Discord
  dispatchMokaEvent(req.body).catch((err) => logger.error(`Moka event failed: ${err.message}`));
});

export default router;
