/**
 * Dashboard Overview: what is connected (server names, versions), Seerr request counts,
 * the latest requests with approve/decline, and recent bot activity.
 */
import { Router } from "express";
import { authenticateToken } from "../utils/auth.js";
import http from "../utils/http.js";
import { settings } from "../utils/settings.js";
import { getSeerrApiUrl, normalizeSeerrUrl } from "../utils/seerrUrl.js";
import { TIMEOUTS } from "../lib/constants.js";
import { getPublicServerInfo } from "../api/jellyfinAdmin.js";
import * as metadata from "../api/metadata.js";
import { botState } from "../bot/botState.js";
import { getActivity } from "../utils/activity.js";
import logger from "../utils/logger.js";

const router = Router();

const seerrConfigured = () => Boolean(settings.SEERR_URL && settings.SEERR_API_KEY);

function seerr(method, path, params) {
  return http.request({
    method,
    url: `${getSeerrApiUrl(settings.SEERR_URL)}${path}`,
    params,
    headers: { "X-Api-Key": settings.SEERR_API_KEY },
    timeout: TIMEOUTS.SEERR_API,
  });
}

// Server names and versions rarely change; one lookup per minute is plenty.
let infoCache = { at: 0, key: "", value: null };
async function serverInfo() {
  const key = `${settings.JELLYFIN_BASE_URL}|${settings.SEERR_URL}`;
  if (infoCache.value && infoCache.key === key && Date.now() - infoCache.at < 60_000) return infoCache.value;
  const [jellyfin, seerrAbout] = await Promise.allSettled([
    settings.JELLYFIN_BASE_URL ? getPublicServerInfo(settings.JELLYFIN_BASE_URL) : Promise.resolve(null),
    seerrConfigured() ? seerr("GET", "/settings/about") : Promise.resolve(null),
  ]);
  const value = {
    jellyfin: jellyfin.status === "fulfilled" && jellyfin.value ? { serverName: jellyfin.value.serverName, version: jellyfin.value.version } : null,
    seerr: seerrAbout.status === "fulfilled" && seerrAbout.value ? { version: seerrAbout.value.data?.version ?? null } : null,
  };
  infoCache = { at: Date.now(), key, value };
  return value;
}

function discordInfo() {
  const client = botState.discordClient;
  if (!botState.isBotRunning || !client?.user) return null;
  const guild = settings.GUILD_ID ? client.guilds.cache.get(settings.GUILD_ID) : null;
  return {
    botTag: client.user.tag,
    botAvatar: client.user.displayAvatarURL({ size: 64 }),
    serverName: guild?.name ?? null,
    serverIcon: guild?.iconURL({ size: 64 }) ?? null,
    memberCount: guild?.memberCount ?? null,
    ping: Number.isFinite(client.ws?.ping) && client.ws.ping >= 0 ? client.ws.ping : null,
  };
}

router.get("/overview", authenticateToken, async (_req, res) => {
  const info = await serverInfo();
  let requestCounts = null;
  if (seerrConfigured()) {
    try {
      requestCounts = (await seerr("GET", "/request/count")).data;
    } catch (err) {
      logger.debug(`Seerr request count failed: ${err.message}`);
    }
  }
  res.json({
    jellyfin: info.jellyfin && { ...info.jellyfin, watching: Boolean(botState.jellyfinFeed?.ws?.readyState === 1) },
    seerr: info.seerr && { ...info.seerr, url: normalizeSeerrUrl(settings.SEERR_URL) },
    discord: discordInfo(),
    requestCounts,
    activity: getActivity(15),
  });
});

// Seerr avatars are often a path on the Seerr server ("/avatarproxy/...").
function absoluteAvatar(avatar) {
  if (!avatar) return null;
  if (/^https?:\/\//.test(avatar)) return avatar;
  return `${normalizeSeerrUrl(settings.SEERR_URL)}${avatar.startsWith("/") ? "" : "/"}${avatar}`;
}

router.get("/requests/recent", authenticateToken, async (req, res) => {
  if (!seerrConfigured()) return res.status(400).json({ error: "Seerr is not set up." });
  const take = Math.min(Math.max(parseInt(req.query.take, 10) || 10, 1), 25);
  try {
    const { data } = await seerr("GET", "/request", { take, skip: 0, sort: "added", filter: "all" });
    const results = await Promise.all(
      (data?.results ?? []).map(async (r) => {
        const tmdbId = r.media?.tmdbId;
        let details = null;
        if (tmdbId) details = await metadata.getDetails(tmdbId, r.type).catch(() => null);
        const date = details?.release_date || details?.first_air_date;
        return {
          id: r.id,
          type: r.type,
          status: r.status, // 1 pending, 2 approved, 3 declined, 4 failed, 5 completed
          mediaStatus: r.media?.status ?? null, // 4 partly available, 5 available
          is4k: Boolean(r.is4k),
          createdAt: r.createdAt,
          tmdbId: tmdbId ?? null,
          title: details?.title || details?.name || null,
          year: date ? String(date).slice(0, 4) : null,
          poster: details?.poster_path ? `https://image.tmdb.org/t/p/w154${details.poster_path}` : null,
          seasons: (r.seasons ?? []).map((s) => s.seasonNumber),
          requestedBy: {
            name: r.requestedBy?.displayName || r.requestedBy?.username || r.requestedBy?.email || null,
            avatar: absoluteAvatar(r.requestedBy?.avatar),
          },
        };
      })
    );
    res.json({ results, total: data?.pageInfo?.results ?? results.length });
  } catch (err) {
    logger.warn(`Could not load recent Seerr requests: ${err.message}`);
    res.status(502).json({ error: "Could not reach Seerr." });
  }
});

router.post("/requests/:id/:action", authenticateToken, async (req, res) => {
  const { id, action } = req.params;
  if (!/^\d{1,10}$/.test(id) || !["approve", "decline"].includes(action)) {
    return res.status(400).json({ error: "Unknown request or action." });
  }
  if (!seerrConfigured()) return res.status(400).json({ error: "Seerr is not set up." });
  try {
    const { data } = await seerr("POST", `/request/${id}/${action}`);
    logger.info(`Dashboard ${action === "approve" ? "approved" : "declined"} Seerr request ${id}`);
    res.json({ success: true, status: data?.status ?? null });
  } catch (err) {
    const status = err.response?.status;
    logger.warn(`Seerr ${action} for request ${id} failed: ${err.message}`);
    res.status(status === 404 ? 404 : 502).json({ error: status === 404 ? "Seerr does not know this request." : "Could not reach Seerr." });
  }
});

export default router;
