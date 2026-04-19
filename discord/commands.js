/**
 * Discord Slash Command Definitions
 * Defines all slash commands for the Discord bot
 */

import { SlashCommandBuilder } from "discord.js";

/**
 * Get all command definitions
 * @returns {Array} Array of command builders
 */
export function getCommands() {
  return [
    new SlashCommandBuilder()
      .setName("search")
      .setDescription("Search for a movie/TV show (you can request it later)")
      .addStringOption((opt) =>
        opt
          .setName("title")
          .setDescription("Title")
          .setRequired(true)
          .setAutocomplete(true)
      ),
    new SlashCommandBuilder()
      .setName("request")
      .setDescription("Send instant request for a movie/TV show")
      .addStringOption((opt) =>
        opt
          .setName("title")
          .setDescription("Title")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("tag")
          .setDescription(
            "Select a tag for this request (optional, e.g., anime)"
          )
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("server")
          .setDescription(
            "Select a Radarr/Sonarr server (optional, uses default if not specified)"
          )
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("quality")
          .setDescription(
            "Select a quality profile (optional, uses default if not specified)"
          )
          .setRequired(false)
          .setAutocomplete(true)
      ),
    new SlashCommandBuilder()
      .setName("trending")
      .setDescription("Browse trending movies and TV shows")
      .addStringOption((opt) =>
        opt
          .setName("title")
          .setDescription("Select from trending content")
          .setRequired(true)
          .setAutocomplete(true)
      ),
  ].map((c) => c.toJSON());
}

/**
 * Register commands with Discord
 * @param {REST} rest - Discord REST client
 * @param {string} botId - Bot application ID
 * @param {string} guildId - Guild ID to register commands in
 * @param {Function} logger - Logger instance
 */
export async function registerCommands(rest, botId, guildId, logger) {
  try {
    const commands = getCommands();

    // Try global commands first (takes up to 1 hour to update globally)
    try {
      const globalEndpoint = `/applications/${botId}/commands`;
      await rest.put(globalEndpoint, { body: commands });
      logger.info("✅ Global commands registered successfully!");
      return; // Success, exit early
    } catch (globalErr) {
      // Only attempt guild-specific fallback if guildId is provided
      if (!guildId) {
        logger.error(
          `Global command registration failed: ${globalErr.message} — slash commands may not appear in Discord.`
        );
        logger.warn(
          `To fix: add your server ID as GUILD_ID in config.json for immediate guild-specific registration.`
        );
        return;
      }

      logger.warn(
        `Global registration failed, falling back to guild-specific: ${globalErr.message}`
      );

      // Fallback to guild-specific commands
      const guildEndpoint = `/applications/${botId}/guilds/${guildId}/commands`;
      await rest.put(guildEndpoint, { body: commands });
      logger.info("✅ Guild commands registered successfully!");
    }
  } catch (err) {
    logger.error(`❌ Failed to register Discord commands: ${err.message}`);
    if (err.response) {
      logger.error(`Response data:`, err.response.data);
    }
    throw new Error(`Failed to register Discord commands: ${err.message}`);
  }
}
