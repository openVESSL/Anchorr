# Contributing to Anchorr

Thanks for helping. Bug reports, translations, documentation and code are all welcome.

## Reporting bugs

[Open an issue](https://github.com/openVESSL/Anchorr/issues/new?labels=bug) with:

- What you did, what you expected and what happened instead
- Your Anchorr version (shown on the dashboard's Overview page) and how you run it (Docker, Unraid, Node.js)
- Your Jellyfin and Seerr versions
- The relevant lines from **Logs** in the dashboard. Log entries never include API keys from 2.0 on, but check for anything else private before posting.

For security issues, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.

## Suggesting features

Check the [existing issues](https://github.com/openVESSL/Anchorr/issues) first, then open one describing the problem you want solved and how you would use the feature. Ideas are also discussed on the [Discord server](https://discord.gg/S5JrsZe9mB).

## Development setup

Requirements: Node.js 22.12 or later, and a Jellyfin, Seerr and Discord bot to test against.

```bash
git clone https://github.com/openVESSL/Anchorr.git
cd Anchorr
npm install
npm run build      # builds the dashboard into frontend/dist
npm start          # http://127.0.0.1:8282
```

While working on the dashboard, run Anchorr with `npm start` and the dashboard dev server with `npm run dev:dashboard` (http://127.0.0.1:5173, which forwards `/api` to Anchorr).

### Project layout

| Path | Contents |
| --- | --- |
| `app.js` | Web server setup and startup |
| `routes/` | Dashboard API (auth, setup, configuration, tests, logs) |
| `bot/` | Discord bot: commands, buttons, embeds, daily pick, weekly roundup, guest account |
| `jellyfin/` | Jellyfin feed (poll every minute, WebSocket for the connection status) and turning new items into Discord announcements: library routing, dedup and episode grouping (`itemHandler.js`), the post itself (`notificationEmbed.js`, `notificationSender.js`) |
| `api/` | Clients for Seerr, Jellyfin, Discord and Seerr metadata |
| `utils/` | Settings, config file, logging, HTTP client, auth, validation |
| `frontend/` | Dashboard (React, Vite, Tailwind, shadcn/ui) |
| `locales/` | Bot message translations |
| `test/` | Automated tests |

### Tests

```bash
npm test
```

The tests run without internet access: Jellyfin, Seerr and Discord are replaced by small local fakes, and the data directory is a temporary folder, so your own `config/` and `logs/` are never touched. Please add or update tests for behavior you change.

To type-check the dashboard: `npm --prefix frontend run lint`.

### Pull requests

1. Fork the repository and create a branch from `dev`, for example `fix/season-picker-tags`.
2. Keep changes focused. Separate refactors from behavior changes.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for messages: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
4. Make sure `npm test` passes and the dashboard builds.
5. Describe what changed and why in the pull request, and link the issue it addresses.

## Translations

Anchorr has two sets of texts: the bot's messages in Discord and the dashboard.

**Bot messages** live in `locales/<code>.json`.

1. Copy `locales/template.json` to `locales/<code>.json`, using an [ISO 639-1](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes) code such as `es` or `pt-br`.
2. Fill in the `_meta` section (language name, code, your name).
3. Translate the values. Keep the keys, any `{placeholders}` and HTML tags unchanged.

The language then appears in the dashboard under **Settings > Bot language**. Missing keys fall back to English.

**Dashboard texts** live in `frontend/src/i18n/<code>.json`. Each entry maps the English text to its translation:

```json
{
  "Save changes": "Änderungen speichern",
  "Working in {server}.": "Arbeitet auf {server}."
}
```

1. Copy an existing file, for example `de.json`, and translate the values. Keep `{placeholders}` as they are.
2. Add the language to `LANGUAGES` in `frontend/src/lib/i18n.tsx` and import the file there.

Anything left out shows in English.

## Code of conduct

Be kind and constructive. Disagreement is fine, disrespect is not.
