// Fake discord.js interactions. Every response method is recorded as plain JSON in `calls`,
// in order, so tests assert on what the user would see.
const toJSON = (value) =>
  value && typeof value.toJSON === "function" ? value.toJSON() : value;

function serialize(payload = {}) {
  if (Array.isArray(payload)) return { choices: payload }; // autocomplete
  const out = { ...payload };
  if (payload.embeds) out.embeds = payload.embeds.map(toJSON);
  if (payload.components) out.components = payload.components.filter(Boolean).map(toJSON);
  return out;
}

export function createInteraction({
  type,
  commandName = null,
  options = {},
  focused = null,
  customId = null,
  values = [],
  userId = "user-1",
  guildId = "guild-1",
  member = { roles: { cache: [] } },
  messageComponents = [],
}) {
  const calls = [];
  const record = (method) => async (payload) => {
    calls.push({ method, ...serialize(payload) });
    if (["reply", "deferReply", "deferUpdate"].includes(method)) {
      interaction[method === "reply" ? "replied" : "deferred"] = true;
    }
  };

  const interaction = {
    calls,
    commandName,
    customId,
    values,
    guildId,
    member,
    user: { id: userId },
    replied: false,
    deferred: false,
    message: { components: messageComponents },
    isCommand: () => type === "command",
    isChatInputCommand: () => type === "command",
    isAutocomplete: () => type === "autocomplete",
    isButton: () => type === "button",
    isStringSelectMenu: () => type === "select",
    isRepliable: () => type !== "autocomplete",
    options: {
      getString: (name) => options[name] ?? null,
      getFocused: (full) => (full ? focused : focused?.value),
      data: Object.entries(options).map(([name, value]) => ({ name, value })),
    },
    reply: record("reply"),
    deferReply: record("deferReply"),
    editReply: record("editReply"),
    followUp: record("followUp"),
    deleteReply: record("deleteReply"),
    deferUpdate: record("deferUpdate"),
    update: record("update"),
    respond: record("respond"),
  };
  return interaction;
}

// Registers the bot's interaction handler on a fake client and returns a dispatcher.
export function captureHandler(registerInteractions) {
  let handler = null;
  registerInteractions({
    on: (event, fn) => {
      if (event === "interactionCreate") handler = fn;
    },
  });
  if (!handler) throw new Error("registerInteractions did not attach interactionCreate");
  return async (interaction) => {
    await handler(interaction);
    return interaction.calls;
  };
}
