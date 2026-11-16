/**
 * Routes every Discord interaction to its handler in bot/interactions/, after the role
 * check that applies to all of them (commands, buttons, menus and autocomplete).
 */
import { t } from "../utils/i18n.js";
import logger from "../utils/logger.js";
import { checkRolePermission } from "./botUtils.js";
import { handleAutocomplete } from "./interactions/autocomplete.js";
import { handleDailyPickButton, handleRequestButton, handleRequestedButton } from "./interactions/requestButtons.js";
import { handleCommand } from "./interactions/search.js";
import { handleSeasonSelect, handleTagSelect } from "./interactions/seasonPicker.js";

const BUTTONS = [
  ["request_btn|", handleRequestButton],
  ["requested|", handleRequestedButton],
  ["request_random_", handleDailyPickButton],
];
const MENUS = [
  ["select_seasons|", handleSeasonSelect],
  ["select_tags|", handleTagSelect],
];

const handlerFor = (routes, customId) => routes.find(([prefix]) => customId.startsWith(prefix))?.[1];

async function route(interaction) {
  const checked = interaction.isCommand() || interaction.isButton() || interaction.isStringSelectMenu() || interaction.isAutocomplete();
  if (checked && !checkRolePermission(interaction.member, interaction.guildId)) {
    if (interaction.isAutocomplete()) return interaction.respond([]);
    logger.info(`[PERMISSION] Denied interaction from user ${interaction.user.id} (${interaction.guildId ? `guild ${interaction.guildId}` : "DM"})`);
    return interaction.reply({
      content: t(interaction.guildId ? "permission_errors.denied" : "permission_errors.dm_denied"),
      flags: 64,
    });
  }

  if (interaction.isAutocomplete()) return handleAutocomplete(interaction);
  if (interaction.isCommand()) return handleCommand(interaction);
  if (interaction.isButton()) return handlerFor(BUTTONS, interaction.customId)?.(interaction);
  if (interaction.isStringSelectMenu()) return handlerFor(MENUS, interaction.customId)?.(interaction);
}

export function registerInteractions(client) {
  client.on("interactionCreate", async (interaction) => {
    try {
      await route(interaction);
    } catch (err) {
      logger.error("Interaction handler error:", err);
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: t("replies.unexpected"), flags: 64 });
        }
      } catch {
        // the interaction may already be acknowledged
      }
    }
  });
}
