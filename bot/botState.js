// Shared mutable bot state — imported by app.js and route files alike.
// Using a plain object so property writes are visible to all importers.
export const botState = {
  isBotRunning: false,
  discordClient: null,
  jellyfinWebSocketClient: null,
};
