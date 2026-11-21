import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
} from "discord.js";
import { registerCommands } from "../discord/commands.js";
import { botState, loadPendingRequests, pendingRequests, savePendingRequests } from "./botState.js";
import { announcesFromMoka } from "../api/moka.js";
import { JellyfinFeed } from "../jellyfin/feed.js";
import { startMokaFeed } from "../jellyfin/mokaFeed.js";
import { handleJellyfinItem } from "../jellyfin/itemHandler.js";
import { registerInteractions } from "./interactions.js";
import { prepareGuestUser } from "./guestUser.js";
import { scheduleDailyRandomPick, stopDailyRandomPick } from "./dailyPick.js";
import { start as startRoundupScheduler, stop as stopRoundupScheduler } from "./roundupScheduler.js";
import { loadSettings } from "../utils/configFile.js";
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";

/** (Re)starts watching Jellyfin; each new item goes to the notification handler. */
export function startJellyfinFeed(client = botState.discordClient) {
  botState.jellyfinFeed?.stop();
  botState.jellyfinFeed = null;
  if (!client || !botState.isBotRunning) return;
  // Without Jellyfin, new titles come from Moka
  if (announcesFromMoka()) {
    botState.jellyfinFeed = startMokaFeed();
    return;
  }
  botState.jellyfinFeed = new JellyfinFeed({
    dispatch: (payload) => handleJellyfinItem(payload, client, pendingRequests, savePendingRequests),
  });
  botState.jellyfinFeed.start();
}

async function startBotNow() {
  if (botState.isBotRunning && botState.discordClient) {
    logger.info("Bot is already running.");
    return { success: true, message: "Bot is already running." };
  }

  loadPendingRequests();

  const configLoaded = loadSettings();
  if (!configLoaded) {
    throw new Error(
      "Configuration file (config.json) not found or is invalid."
    );
  }

  // ----------------- VALIDATE ENV -----------------
  const REQUIRED_DISCORD = ["DISCORD_TOKEN", "BOT_ID"];
  const missing = REQUIRED_DISCORD.filter((k) => !settings[k]);
  if (missing.length) {
    throw new Error(
      `Bot cannot start. Missing required Discord variables: ${missing.join(", ")}`
    );
  }

  // Not awaited: requests that arrive before it finishes wait for the same attempt
  prepareGuestUser();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.Channel],
  });
  botState.discordClient = client;

  // ----------------- REGISTER COMMANDS -----------------
  const rest = new REST({ version: "10" }).setToken(settings.DISCORD_TOKEN);

  try {
    await registerCommands(
      rest,
      settings.BOT_ID,
      settings.GUILD_ID,
      logger
    );
  } catch (err) {
    logger.error(
      `[REGISTER COMMANDS] Failed to register Discord commands:`,
      err
    );
    botState.discordClient = null;
    throw new Error(`Failed to register Discord commands: ${err.message}`);
  }

  // ----------------- REGISTER INTERACTIONS -----------------
  registerInteractions(client);

  // ----------------- LOGIN -----------------
  return new Promise((resolve, reject) => {
    client.once("clientReady", async () => {
      logger.info(`✅ Bot logged in as ${client.user.tag}`);
      botState.isBotRunning = true;

      startJellyfinFeed(client);

      scheduleDailyRandomPick(client);
      startRoundupScheduler(client);

      resolve({ success: true, message: `Logged in as ${client.user.tag}` });
    });

    client.login(settings.DISCORD_TOKEN).catch((err) => {
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
      client.destroy().catch(() => {});
      reject(err);
    });
  });
}

/** Disconnects the bot and stops its schedulers and the Jellyfin feed. */
async function stopBotNow() {
  stopRoundupScheduler();
  stopDailyRandomPick();
  botState.jellyfinFeed?.stop();
  botState.jellyfinFeed = null;
  const client = botState.discordClient;
  botState.isBotRunning = false;
  botState.discordClient = null;
  if (client) await client.destroy();
}

// Start, stop and restart run one at a time: two overlapping starts would leave a second,
// unreachable bot connected (double replies and double announcements).
let lifecycle = Promise.resolve();
function oneAtATime(task) {
  const run = lifecycle.then(task, task);
  lifecycle = run.catch(() => {});
  return run;
}

export const startBot = () => oneAtATime(startBotNow);
export const stopBot = () => oneAtATime(stopBotNow);

/** Starts the bot, or restarts it so new Discord settings take effect. */
export const restartBot = () =>
  oneAtATime(async () => {
    if (botState.isBotRunning || botState.discordClient) await stopBotNow();
    return startBotNow();
  });
