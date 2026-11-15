// Minimal stand-in for a discord.js Client: records every channel message, edit and DM
// as plain JSON so tests compare what Discord would receive, not builder internals.
const toJSON = (value) =>
  value && typeof value.toJSON === "function" ? value.toJSON() : value;

function serialize(payload) {
  const out = {
    embeds: (payload.embeds || []).map(toJSON),
    components: (payload.components || []).filter(Boolean).map(toJSON),
  };
  if (payload.content !== undefined) out.content = payload.content;
  if (payload.allowedMentions !== undefined) out.allowedMentions = payload.allowedMentions;
  return out;
}

export function createFakeDiscord({ missingChannels = [] } = {}) {
  const sent = [];
  const edits = [];
  const dms = [];
  const messages = new Map();

  const channel = (id) => ({
    id,
    send: async (payload) => {
      const message = {
        id: `msg-${sent.length + 1}`,
        channelId: id,
        edit: async (next) => edits.push({ channelId: id, messageId: message.id, ...serialize(next) }),
      };
      messages.set(message.id, message);
      sent.push({ channelId: id, messageId: message.id, ...serialize(payload) });
      return message;
    },
    messages: {
      fetch: async (messageId) => {
        const message = messages.get(messageId);
        if (!message) throw new Error(`Unknown message ${messageId}`);
        return message;
      },
    },
  });

  const client = {
    channels: {
      fetch: async (id) => {
        if (missingChannels.includes(id)) throw new Error(`Unknown channel ${id}`);
        return channel(id);
      },
    },
    users: {
      fetch: async (id) => ({
        id,
        send: async (payload) => dms.push({ userId: id, ...serialize(payload) }),
      }),
    },
  };

  return { client, sent, edits, dms };
}
