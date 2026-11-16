// Discord lookups for the dashboard: servers, channels, members and roles.
import { Router } from "express";
import { botState } from "../bot/botState.js";
import { authenticateToken } from "../utils/auth.js";
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";

const router = Router();

// Endpoint for Discord servers list (guilds)
router.get("/discord/guilds", authenticateToken, async (_req, res) => {
  try {
    if (!botState.discordClient || !botState.discordClient.user) {
      logger.debug("[GUILDS API] Bot not running or not logged in.");
      return res.json({ success: false, message: "Bot not running" });
    }
    // Debug: log all guilds
    logger.debug(
      "[GUILDS API] botState.discordClient.guilds.cache:",
      botState.discordClient.guilds.cache.map((g) => ({ id: g.id, name: g.name }))
    );
    // Fetch guilds the bot is in
    const guilds = botState.discordClient.guilds.cache.map((g) => ({
      id: g.id,
      name: g.name,
    }));
    res.json({ success: true, guilds });
  } catch (err) {
    logger.error("[GUILDS API] Error:", err);
    res.json({ success: false, message: "Discord request failed. Check the logs for details." });
  }
});

// Endpoint for Discord channels list from a server
router.get(
  "/discord/channels/:guildId",
  authenticateToken,
  async (req, res) => {
    try {
      const { guildId } = req.params;
      if (!botState.discordClient || !botState.discordClient.user) {
        logger.debug("[CHANNELS API] Bot not running or not logged in.");
        return res.json({ success: false, message: "Bot not running" });
      }

      const guild = botState.discordClient.guilds.cache.get(guildId);
      if (!guild) {
        return res.json({ success: false, message: "Guild not found" });
      }

      const channels = [];

      // Fetch text channels where bot can send messages
      guild.channels.cache
        .filter(
          (channel) =>
            (channel.type === 0 || channel.type === 5) && // GUILD_TEXT, GUILD_ANNOUNCEMENT
            channel.permissionsFor(botState.discordClient.user).has("SendMessages")
        )
        .forEach((channel) => {
          channels.push({
            id: channel.id,
            name: channel.name,
            type: channel.type === 5 ? "announcement" : "text",
          });
        });

      // Fetch forum channels and their active threads
      const forumChannels = guild.channels.cache.filter(
        (channel) => channel.type === 15 // GUILD_FORUM
      );

      for (const [, forumChannel] of forumChannels) {
        try {
          // Fetch active threads in this forum
          const activeThreads = await forumChannel.threads.fetchActive();

          // Add each thread as a selectable channel
          activeThreads.threads.forEach((thread) => {
            if (thread.permissionsFor(botState.discordClient.user)?.has("SendMessages")) {
              channels.push({
                id: thread.id,
                name: `${forumChannel.name} > ${thread.name}`,
                type: "forum-thread",
                parentId: forumChannel.id,
                parentName: forumChannel.name,
              });
            }
          });
        } catch (err) {
          logger.warn(`[CHANNELS API] Failed to fetch threads for forum ${forumChannel.name}:`, err.message);
        }
      }

      // Fetch regular threads (public, private, announcement) from text channels
      try {
        // Fetch all active threads in the guild
        const activeThreads = await guild.channels.fetchActiveThreads();

        activeThreads.threads.forEach((thread) => {
          // Filter for thread types: PUBLIC_THREAD (10), PRIVATE_THREAD (11), ANNOUNCEMENT_THREAD (12)
          if ([10, 11, 12].includes(thread.type)) {
            if (thread.permissionsFor(botState.discordClient.user)?.has("SendMessages")) {
              const parentChannel = guild.channels.cache.get(thread.parentId);
              const threadTypeLabel =
                thread.type === 10 ? "Thread" :
                  thread.type === 11 ? "Private Thread" :
                    "Announcement Thread";

              channels.push({
                id: thread.id,
                name: parentChannel
                  ? `${parentChannel.name} > ${thread.name} (${threadTypeLabel})`
                  : `${thread.name} (${threadTypeLabel})`,
                type: thread.type === 10 ? "public-thread" :
                  thread.type === 11 ? "private-thread" :
                    "announcement-thread",
                parentId: thread.parentId,
                parentName: parentChannel?.name,
              });
            }
          }
        });
      } catch (err) {
        logger.warn(`[CHANNELS API] Failed to fetch regular threads:`, err.message);
      }

      channels.sort((a, b) => a.name.localeCompare(b.name));

      logger.debug(
        `[CHANNELS API] Found ${channels.length} channels (including threads) in guild ${guild.name}`
      );
      res.json({ success: true, channels });
    } catch (err) {
      logger.error("[CHANNELS API] Error:", err);
      res.json({ success: false, message: "Discord request failed. Check the logs for details." });
    }
  }
);

// Endpoint for Discord members from a server
router.get("/discord-members", authenticateToken, async (_req, res) => {
  try {
    logger.debug("[MEMBERS API] Request received");
    if (!botState.discordClient || !botState.discordClient.user) {
      logger.debug("[MEMBERS API] Bot not running");
      return res.json({ success: false, message: "Bot not running" });
    }

    const guildId = settings.GUILD_ID;
    logger.debug("[MEMBERS API] GUILD_ID from env:", guildId);
    if (!guildId) {
      logger.debug("[MEMBERS API] No guild selected");
      return res.json({ success: false, message: "No guild selected" });
    }

    const guild = botState.discordClient.guilds.cache.get(guildId);
    if (!guild) {
      logger.debug("[MEMBERS API] Guild not found in cache");
      return res.json({ success: false, message: "Guild not found" });
    }

    logger.debug(
      "[MEMBERS API] Guild found:",
      guild.name,
      "Member count:",
      guild.memberCount
    );

    // Check if bot has permission to view members
    const botMember = guild.members.cache.get(botState.discordClient.user.id);
    if (!botMember) {
      logger.debug("[MEMBERS API] Bot member not found in guild");
      return res.json({ success: false, message: "Bot not in guild" });
    }

    logger.debug(
      "[MEMBERS API] Bot permissions:",
      botMember.permissions.toArray()
    );

    // Fetch members with proper error handling and intent detection
    let fetchSuccess = false;

    try {
      logger.debug(
        "[MEMBERS API] Attempting to fetch members (real-time with force refresh)..."
      );
      // Force refresh members from Discord - ignores cache and fetches latest from server
      await guild.members.fetch({ force: true });
      logger.info(
        "[MEMBERS API] ✅ Members fetched successfully (real-time)"
      );
      fetchSuccess = true;
    } catch (fetchErr) {
      const errorCode = fetchErr.code;
      const errorStatus = fetchErr.status;

      logger.error(
        `[MEMBERS API] Fetch error - Code: ${errorCode}, Status: ${errorStatus}, Message: ${fetchErr.message}`
      );

      // Detect if it's a privileged intent issue
      if (
        fetchErr.message.includes("Privileged intent") ||
        fetchErr.code === 50001 ||
        fetchErr.status === 403 ||
        fetchErr.message.includes("requires the SERVER_MEMBERS intent") ||
        fetchErr.message.includes("requires the GUILD_MEMBERS intent")
      ) {
        logger.warn(
          "[MEMBERS API] ⚠️ GUILD_MEMBERS privileged intent not enabled in Discord Developer Portal!"
        );
        logger.warn(
          "[MEMBERS API] To fix: Go to https://discord.com/developers/applications"
        );
        logger.warn("[MEMBERS API] 1. Select your bot application");
        logger.warn("[MEMBERS API] 2. Go to 'Bot' tab");
        logger.warn(
          "[MEMBERS API] 3. Enable 'Server Members Intent' under 'Privileged Gateway Intents'"
        );
        logger.warn("[MEMBERS API] 4. Save changes and restart bot");
        logger.warn(
          "[MEMBERS API] Falling back to cached members (may be incomplete)"
        );
      } else {
        logger.error(
          "[MEMBERS API] Unknown error fetching members. Falling back to cache."
        );
        logger.debug("[MEMBERS API] Full error:", fetchErr);
      }
    }

    // Get members from cache (will be fresh if fetch succeeded, or cached if it failed)
    const members = guild.members.cache
      .filter((member) => !member.user.bot) // Exclude bots
      .map((member) => ({
        id: member.id,
        username: member.user.username,
        displayName: member.displayName || member.user.username,
        avatar: member.user.displayAvatarURL({ size: 64 }),
        discriminator: member.user.discriminator,
      }))
      .sort((a, b) => a.username.localeCompare(b.username));

    logger.info(
      `[MEMBERS API] Returning ${members.length} members (real-time: ${fetchSuccess})`
    );

    res.json({
      success: true,
      members,
      fetchedRealtime: fetchSuccess,
      warning: fetchSuccess
        ? null
        : "Members from cache - enable GUILD_MEMBERS intent for real-time data",
    });
  } catch (err) {
    logger.error("[MEMBERS API] Error:", err);
    res.json({ success: false, message: "Discord request failed. Check the logs for details." });
  }
});

// Endpoint for Discord roles from a server
router.get("/discord-roles", authenticateToken, async (_req, res) => {
  try {
    logger.debug("[ROLES API] Request received");
    if (!botState.discordClient || !botState.discordClient.user) {
      logger.debug("[ROLES API] Bot not running");
      return res.json({ success: false, message: "Bot not running" });
    }

    const guildId = settings.GUILD_ID;
    logger.debug("[ROLES API] GUILD_ID from env:", guildId);
    if (!guildId) {
      logger.debug("[ROLES API] No guild selected");
      return res.json({ success: false, message: "No guild selected" });
    }

    const guild = botState.discordClient.guilds.cache.get(guildId);
    if (!guild) {
      logger.debug("[ROLES API] Guild not found in cache");
      return res.json({ success: false, message: "Guild not found" });
    }

    logger.debug("[ROLES API] Guild found:", guild.name);

    // Fetch roles
    const roles = guild.roles.cache
      .filter((role) => !role.managed) // Exclude managed roles (bot roles)
      // Discord's own order (highest role first, @everyone last). Member counts come from a
      // partial cache, so sorting by them shuffled the list between loads.
      .sort((a, b) => b.position - a.position)
      .map((role) => ({
        id: role.id,
        name: role.name,
        color: role.hexColor,
        memberCount: role.members.size,
      }));

    logger.debug(`[ROLES API] Returning ${roles.length} roles`);
    res.json({ success: true, roles });
  } catch (err) {
    logger.error("[ROLES API] Error:", err);
    res.json({ success: false, message: "Discord request failed. Check the logs for details." });
  }
});

export default router;
