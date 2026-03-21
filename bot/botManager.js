import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
} from "discord.js";
import { registerCommands } from "../discord/commands.js";
import { botState, loadPendingRequests } from "./botState.js";
import { registerInteractions } from "./interactions.js";
import { scheduleDailyRandomPick } from "./dailyPick.js";
import { loadConfigToEnv } from "../utils/configFile.js";
import logger from "../utils/logger.js";

export async function startBot() {
  if (botState.isBotRunning && botState.discordClient) {
    logger.info("Bot is already running.");
    return { success: true, message: "Bot is already running." };
  }

  loadPendingRequests();

  const configLoaded = loadConfigToEnv();
  if (!configLoaded) {
    throw new Error(
      "Configuration file (config.json) not found or is invalid."
    );
  }

  // ----------------- VALIDATE ENV -----------------
  const REQUIRED_DISCORD = ["DISCORD_TOKEN", "BOT_ID"];
  const missing = REQUIRED_DISCORD.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Bot cannot start. Missing required Discord variables: ${missing.join(", ")}`
    );
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.Channel],
  });
  botState.discordClient = client;

  // ----------------- REGISTER COMMANDS -----------------
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  try {
    await registerCommands(
      rest,
      process.env.BOT_ID,
      process.env.GUILD_ID,
      logger
    );
  } catch (err) {
    logger.error(
      `[REGISTER COMMANDS] Failed to register Discord commands:`,
      err
    );
    throw new Error(`Failed to register Discord commands: ${err.message}`);
  }

  // ----------------- REGISTER INTERACTIONS -----------------
  registerInteractions(client);

  // ----------------- LOGIN -----------------
  return new Promise((resolve, reject) => {
    client.once("clientReady", async () => {
      logger.info(`✅ Bot logged in as ${client.user.tag}`);
      botState.isBotRunning = true;

      logger.info("ℹ️ Jellyfin notifications will be received via webhooks.");

      scheduleDailyRandomPick(client);

      resolve({ success: true, message: `Logged in as ${client.user.tag}` });
    });

    client.login(process.env.DISCORD_TOKEN).catch((err) => {
      logger.error("[DISCORD LOGIN ERROR] Bot login failed:");
      if (err && err.message) {
        logger.error("[DISCORD LOGIN ERROR] Message:", err.message);
      }
      if (err && err.code) {
        logger.error("[DISCORD LOGIN ERROR] Code:", err.code);
      }
      if (err && err.stack) {
        logger.error("[DISCORD LOGIN ERROR] Stack:", err.stack);
      }
      botState.isBotRunning = false;
      botState.discordClient = null;
      reject(err);
    });
  });
}
