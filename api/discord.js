/**
 * Discord REST calls used during setup, before the bot is connected.
 */
import http from "../utils/http.js";

// Overridable for tests only
const API = () => process.env.DISCORD_API_URL || "https://discord.com/api/v10";

// View Channels, Send Messages, Embed Links, Send Messages in Threads
export const BOT_PERMISSIONS = String(1024 + 2048 + 16384 + 274877906944);
const GUILD_MEMBERS_INTENT_FLAGS = (1 << 14) | (1 << 15); // GATEWAY_GUILD_MEMBERS(_LIMITED)

const botHeaders = (token) => ({ Authorization: `Bot ${token}` });

/** Checks a bot token. @returns {{ id, username, membersIntent }} */
export async function verifyBotToken(token) {
  const { data: user } = await http.get(`${API()}/users/@me`, { headers: botHeaders(token) });
  let membersIntent = null;
  try {
    const { data: application } = await http.get(`${API()}/applications/@me`, { headers: botHeaders(token) });
    membersIntent = Boolean(Number(application.flags) & GUILD_MEMBERS_INTENT_FLAGS);
  } catch {
    // unknown: the dashboard simply does not warn
  }
  return { id: user.id, username: user.username, membersIntent };
}

/** Servers the bot has joined. */
export async function listBotGuilds(token) {
  const { data } = await http.get(`${API()}/users/@me/guilds`, { headers: botHeaders(token) });
  return (data || []).map((g) => ({ id: g.id, name: g.name }));
}

/** Link that adds the bot to a server with the permissions Anchorr needs. */
export function inviteUrl(botId) {
  const params = new URLSearchParams({ client_id: botId, scope: "bot applications.commands", permissions: BOT_PERMISSIONS });
  return `https://discord.com/oauth2/authorize?${params.toString().replace(/\+/g, "%20")}`;
}
