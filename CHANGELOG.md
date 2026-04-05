# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.4.9] - 2026-04-03

### 🔒 Security

- **Content-Security-Policy header added**: The dashboard now sends a `Content-Security-Policy` header restricting scripts to `'self'` and `cdn.jsdelivr.net`, styles to `'self'`, `cdnjs.cloudflare.com`, and `cdn.jsdelivr.net`, and blocking all plugins (`object-src 'none'`). Inline `<script>` and `<style>` blocks in `index.html` have been moved to `script.js` and `style.css` respectively so no `'unsafe-inline'` is needed
- **Dockerfile: container no longer runs as root**: `USER app` is now active. The non-root `app` user was already created and the app directory already chowned — the directive was previously commented out. **Migration required for existing installs** — see below
- **Cookie Secure flag no longer bypassable via spoofed header**: The `auth_token` cookie's `Secure` flag was set based on `req.secure || req.headers["x-forwarded-proto"] === "https"`, allowing any client to fake HTTPS over plain HTTP by sending the header. It now uses only `req.secure`, which Express derives correctly when `TRUST_PROXY` is configured
- **Dependencies updated**: `npm audit fix` resolved all known CVEs in transitive dependencies

### ⬆️ Migration

#### Non-root Docker container

The container now runs as a non-root user (`app`). If your host-side config directory was created by a previous (root-running) container, it will be owned by `root` and the container will fail to write `config.json`.

**Fix:**

```bash
# Run this on the Docker host before restarting the container
chmod 777 ./config
```

On **Unraid**: open the share settings for your appdata path and set permissions to `777`, or run the above from the terminal.

---

## [1.4.8] - 2026-04-02

### ✨ Added

- **Auto-Map from Seerr**: New button in the User Mapping section that detects Seerr users who have linked their Discord account and lets you map them in one click. Shows a preview with checkboxes before saving — Discord usernames are resolved automatically via the bot if it's running. A companion **Sync with Seerr** button checks existing mappings against Seerr and surfaces any that are stale (Discord unlinked, ID changed, or Seerr user deleted) so they can be removed in bulk

### 🔒 Security

- **Discord token fragment no longer logged**: Debug log in `loadConfig()` previously emitted the first 6 characters of the Discord bot token — now logs `SET` / `UNDEFINED` only
- **Webhook debug log no longer dumps full payload**: Debug log on incoming webhook requests now only emits `ItemType`, `ItemId`, and `Name` instead of the raw payload (which could include internal server paths and URLs)
- **XSS: log viewer timestamp and level fields now escaped**: `timestamp` and `level` fields in the dashboard log viewer were inserted into HTML without escaping — both are now passed through `escapeHtml()`
- **XSS: Jellyfin library name and ID now escaped**: Library names and IDs from the Jellyfin API were inserted raw into the library selection UI — both are now escaped before rendering
- **XSS: role color validated before use in style attribute**: The Discord role color value is now validated against a strict hex color pattern (`/^#[0-9a-fA-F]{6}$/`) before being inserted into a CSS `style` attribute

### 🐛 Fixed

- **Bot crashes after a few days**: An unhandled promise rejection (e.g. from a Discord API blip or rate limit) was calling `process.exit(1)`, killing the entire process. Unhandled rejections are now logged as errors without terminating the bot
- **User mapping dropdown missing offline/uncached members**: `guild.members.fetch()` was capped at 1000 and Discord only returns members who are cached — users who are offline or in large servers would not appear. The cap has been removed and a manual Discord User ID input field has been added as a fallback for users who still don't show up in the list. When a manual ID is entered, the bot resolves the username via the Discord API so the mapping list shows a proper name instead of a raw ID

---

## [1.4.7] - 2026-03-28

### 🐛 Fixed

- **Library channel mapping broken when using per-library Discord channels**: The config UI was saving `item.Id` (undefined on VirtualFolder objects) as the library key in `JELLYFIN_NOTIFICATION_LIBRARIES`. Jellyfin's `/Library/VirtualFolders` endpoint returns `ItemId`, not `Id`, so all channel lookups silently failed and notifications were either skipped or always routed to the default channel
- **Channel mapping mismatch for Jellyfin webhook source**: Jellyfin webhook payloads may send `CollectionId` as `LibraryId`, while the config stores `VirtualFolder ItemId` as the key. Added a resolution step so webhook-sourced library IDs are correctly mapped before the channel lookup
- **Poller library fallback broken**: `findLibraryId` was called with `libraryIds` (a `Set`) instead of the required `Map<id, libraryObject>`, causing the traversal fallback to always return `undefined`
- **Seerr users not loading in User Mapping UI**: `response.data.results` assumed a paginated response, but some Seerr variants return a plain array — fixed to handle both formats
- **Wrong timeout constant in `checkMediaStatus`**: Used `TIMEOUTS.TMDB_API` instead of `TIMEOUTS.SEERR_API` for a Seerr API call (both are 8000ms, so no behavioral difference, but now correctly named)
- **`JELLYFIN_BASE_URL` typo in library route**: `GET /jellyfin/libraries` was reading `process.env.JELLYFIN_URL` (undefined) instead of `JELLYFIN_BASE_URL`, always returning 400
- **Dashboard version never displayed**: `import ... with { type: "json" }` syntax requires Node 20.10+ but the Docker image runs Node 18. Switched to `createRequire` so the version is correctly loaded and returned by `/api/health`

### 🏗️ Code Quality

- **Removed dead code from discarded Seerr webhook feature**: `fetchRootFolders`, its module-level cache variables, and `CACHE_TTL.ROOT_FOLDERS` were never called anywhere and have been removed
- **`EMBED_COLOR_SEASON` added to config template**: The season embed color was read from env but missing from `lib/config.js`, making it non-configurable via the dashboard

---

## [1.4.6] - 2026-03-25

### 🔒 Security

- **Web dashboard binds to localhost by default**: Bare-metal installs now bind to `127.0.0.1` instead of all interfaces. Set `BIND_HOST=0.0.0.0` if you need external access (Docker Compose does this automatically)
- **Rate limiting**: `/start-bot`, `/stop-bot`, and `/auth/check` are now rate-limited
- **SSRF hardening**: All URLs passed to axios are now constructed via `URL` object pathname manipulation instead of string interpolation
- **Translation sanitizer**: Rewritten with a DOM-based allowlist parser, closing several XSS bypass vectors
- **Misc**: Partial API key no longer logged; request payload logging removed; TMDB IDs validated as integers; GitHub Actions workflow permissions scoped to least-privilege

### 🚀 Added

- **Series poster and episode overview in single-episode notifications**: Jellyfin webhook notifications for individual episodes now show the series poster and episode overview instead of generic placeholders

### ⚠️ Migration Notes

**Docker Compose users:** Add `BIND_HOST=0.0.0.0` to your `environment:` section. If you use the included `docker-compose.yml`, no action needed.

---

## [1.4.5] - 2026-03-21

### 🐛 Fixed

- **Trust proxy validation error**: `TRUST_PROXY=true` now sets `trust proxy` to `1` (hop count) instead of `true` (boolean), resolving `ERR_ERL_PERMISSIVE_TRUST_PROXY` from express-rate-limit v7+ when running behind a reverse proxy like Traefik
- **Docker healthcheck**: Default `docker-compose.yml` healthcheck was hitting `/api/config` (auth-gated, always 401) instead of `/api/health` (public). Fixed to use the correct endpoint

### 🏗️ Code Quality

- **SRP refactor**: `app.js` split into focused modules under `routes/`, `bot/`, `jellyfin/`, and `utils/` — no behavior changes, improves maintainability and testability

---

## [1.4.3] - 2026-03-16

### 🔒 Security

- **Login brute-force protection** (ref [#80](../../issues/80)): Account locked for 10 minutes after 5 consecutive failed login attempts per username (HTTP 429 with seconds remaining). Progressive 300ms-per-attempt response delay (capped at 4 s) slows automated tools. bcrypt always runs even for unknown usernames to prevent user enumeration via timing. Existing IP-based rate limit (20 req / 15 min) remains as a first layer
- **XSS fix — user mapping remove button**: `discordUserId` is now escaped with `escapeHtml()` before being placed in the `onclick` attribute, and validated against Discord snowflake format (17–19 digits). Fixes stored XSS where a crafted Discord user ID could inject arbitrary JS into any admin's browser on page load

### 🐛 Fixed

- **Jellyfin webhook Content-Type**: `express.json()` was silently dropping Jellyfin webhook bodies because Jellyfin sends `Content-Type: text/plain`. The endpoint now uses `express.json({ type: "*/*" })` to accept any content type
- **Webhook debounce error no longer blocks a series**: A failed Discord send previously left a `level: -1` temp marker in `sentNotifications`, blocking all future webhooks for that series for up to 24 hours. The marker is now deleted immediately on error, and the orphaned-marker cleanup timeout is reduced from 24 h to 5 min
- **Empty channel no longer crashes the webhook handler**: When no Discord channel is configured for a library, the handler now logs a clear config error and returns cleanly instead of throwing a cryptic Discord API exception

### 🚀 Improvements

- **Seerr rebrand**: All `JELLYSEERR_*` config keys renamed to `SEERR_*`. Existing `config.json` is migrated automatically on first boot. If you have `JELLYSEERR_*` set as environment variables outside of `config.json`, rename them manually
- **Pending DM requests survive restarts**: `pendingRequests` is persisted to `pending-requests.json` (next to `config.json`, mode 0600) on every write and loaded on bot startup — users who requested media via `/request` now receive their DM notification even if the bot was restarted before the media became available
- **Webhook secret visible on page load**: The webhook secret field in the dashboard is now populated automatically on load so the value is immediately visible and copyable without digging through the config
- **Better webhook error logs**: Errors and warnings in the webhook handler now include `ItemType` and `Name` for easier debugging without parsing the raw payload

### 🏗️ Code Quality

- Fix timer leak in `auth.js`: previous cleanup timer is cancelled before a new one is scheduled, preventing unbounded `setTimeout` handle accumulation under sustained login attacks
- Remove redundant `Map.get` call in the login handler immediately after `recordFailure`
- `/api/webhook-secret` returns the in-memory `WEBHOOK_SECRET` constant instead of calling `readConfig()` on every request
- Copy-secret button reads from the already-populated input field instead of making a second fetch to `/api/webhook-secret`

---

## [1.4.2] - 2026-03-15

### 🔒 Security

This release addresses two stored XSS vulnerabilities reported by [@xdnewlun1](https://github.com/xdnewlun1) and [@Rex50527](https://github.com/Rex50527).

**GHSA-qpmq-6wjc-w28q — Stored XSS via Discord member display names** (reported by [@xdnewlun1](https://github.com/xdnewlun1))
The Discord member dropdown was built using `innerHTML` with unsanitized display names fetched from the Discord API. A Discord user whose display name contained HTML or JavaScript could inject scripts that executed in the dashboard context, targeting any admin viewing the user-mapping page.

**GHSA-6mg4-788h-7g9g — Stored XSS via Seerr usernames** (reported by [@Rex50527](https://github.com/Rex50527))
Seerr usernames retrieved from the API were injected into the dashboard via `innerHTML` without sanitization. A Seerr account with a crafted username could inject scripts that executed when an admin loaded the user-mapping page.

- **DOM API rewrite for member dropdown**: The Discord member selector now builds list items using `createElement` / `textContent` instead of `innerHTML`. Display names and avatar URLs are treated as data, not markup
- **Avatar URL validation**: Avatar URLs are validated against a strict pattern (`cdn.discordapp.com`) before being set as `img.src`, preventing javascript: URI injection via crafted avatar payloads
- **i18n translation sanitization**: `sanitizeTranslationHtml()` strips `<script>` tags, event-handler attributes (`on*`), and `javascript:` URLs from locale strings before they are injected via `innerHTML`, while preserving safe markup (`<strong>`, `<code>`, etc.)
- **Config sanitization**: Sensitive fields (`DISCORD_TOKEN`, API keys, secrets) are masked before the config object is sent to the browser. The server detects masked placeholders on save and substitutes the real stored values, preventing credential loss
- **JWT token revocation**: Issued tokens now carry a `jti` (JWT ID) claim. Logout registers the JTI in an in-memory revocation set with auto-cleanup after expiry, so stolen session cookies are invalidated immediately on logout
- **Security response headers**: Added `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `X-XSS-Protection: 1; mode=block`, and `Referrer-Policy: strict-origin-when-cross-origin` to all responses
- **Auth endpoint rate limiting**: Login and register routes are now rate-limited to 20 requests per 15 minutes per IP, mitigating brute-force attacks

### 🚀 Improvements

- **Dynamic version display**: The dashboard footer and About section now show the live application version fetched from the server, keeping the displayed version in sync with each release without manual HTML edits

---

## [1.4.1] - 2026-03-14

### ℹ️ Important

- **Breaking Change — Webhook secret required**: The `/jellyfin-webhook` endpoint now requires an `X-Webhook-Secret` header on every request. Existing Jellyfin webhook configurations without this header will receive `401 Unauthorized` and stop delivering notifications. See the migration guide below.
- **Breaking Change — Switch to Generic Destination required**: Jellyfin does not support custom HTTP headers for the **Discord Destination** type. Since Anchorr now requires an `X-Webhook-Secret` header on every request, the Discord Destination can no longer be used. You must delete your existing Discord Destination and recreate it as a **Generic Destination** — otherwise the header cannot be set and all webhook deliveries will be rejected with `401 Unauthorized`.

### 🔒 Security

This release addresses a critical security vulnerability reported by [@whoopsi-daisy](https://github.com/whoopsi-daisy).

Anchorr's `/jellyfin-webhook` endpoint accepted arbitrary POST requests without verifying the sender or the structure of the payload. The handler forwarded several fields from the webhook body directly into the internal job runner pipeline, where they were later interpolated into a command string executed through a shell context. Because the values were not sanitized or escaped, a specially crafted payload could terminate the expected argument sequence and inject additional shell tokens — allowing arbitrary command execution under the privileges of the Anchorr process.

- **Webhook Secret Authentication**: The `/jellyfin-webhook` endpoint now requires a shared secret sent as the `X-Webhook-Secret` HTTP header. Requests without a valid secret are rejected with `401 Unauthorized`. The secret is auto-generated on first start and displayed in the dashboard with a copy button and setup instructions
- **Webhook Rate Limiting**: Added rate limiter (60 requests/minute per IP) to the webhook endpoint to prevent notification flooding and DoS
- **Timing-Safe Secret Comparison**: Webhook secret verification uses `crypto.timingSafeEqual` to prevent timing-based secret extraction attacks
- **URL Injection Prevention**: `buildJellyfinUrl` now always uses the configured `JELLYFIN_BASE_URL` instead of the webhook-provided `ServerUrl`, preventing URL injection via poisoned Jellyfin metadata
- **Removed Credential Debug Logs**: Debug statements that logged a prefix of the Discord token to disk have been removed
- **Base64-Encoded Secrets at Rest**: Sensitive fields (`DISCORD_TOKEN`, `JWT_SECRET`, `WEBHOOK_SECRET`, `SEERR_API_KEY`, `JELLYFIN_API_KEY`, `TMDB_API_KEY`, `OMDB_API_KEY`) are now stored base64-encoded in `config.json`. Values are decoded transparently on read and re-encoded on every save. Existing plain-text configs are migrated automatically on next save

### 🏗️ Code Quality

- **Config Validation on Startup**: Config is now validated against the Joi schema on startup, logging warnings for any malformed fields

### 📚 Documentation

- **Public Hosting Warning**: Added `⚠️ Security Notice` section to README warning against exposing Anchorr to the public internet and recommending VPN use for remote access
- **Webhook Setup Guide**: Updated Jellyfin plugin setup instructions in both the dashboard and README to include the `X-Webhook-Secret` header configuration step and Generic Destination requirement

### 🚀 Migration Guide for Users

If upgrading from v1.4.0:

1. Start Anchorr — a `WEBHOOK_SECRET` is auto-generated and saved on first startup
2. Open the dashboard → **Jellyfin Notifications** section → copy the **Webhook Secret**
3. In your Jellyfin webhook plugin, **delete your existing Discord Destination** and create a new **Generic Destination** with the same Webhook URL
4. Scroll down to the **Headers** section, click **Add Header**, set the name to `X-Webhook-Secret` and paste the secret as the value
5. Save. Notifications will resume immediately

---

## [1.4.0] - 2026-02-11

### ✨ Added

- **Multi-Season Selection UI**: Enhanced season selection for TV shows with more than 25 seasons by implementing multiple cascading select menus, overcoming Discord's 25-option limit per select menu. Users can now seamlessly select seasons from shows with extensive episode lists (e.g., One Piece, Pokémon)
- **Discord Threads Support**: Added support for mapping Discord threads as notification channels. You can now send Jellyfin notifications to specific threads in addition to regular text channels, providing better organization for different content types or libraries
- **Auto-Approve Requests**: Implemented auto-approve functionality for media requests. When enabled, requests made through the bot are automatically approved in Seerr without requiring manual approval, streamlining the content acquisition workflow
- **Daily Pick Recommendations**: New daily recommendation feature that sends a curated movie or TV show suggestion to your Discord channel. Users receive fresh content recommendations each day to discover new media to watch
- **Quality Profile Selection**: Added quality profile selection in the `/request` command with intelligent autocomplete support. Users can now specify their preferred quality profile (e.g., "1080p", "4K", "Anime") directly when requesting content
- **Server Selection for Requests**: Implemented server selection functionality allowing users to choose specific Radarr or Sonarr servers when making media requests, providing better control over where content is downloaded
- **Default Quality Profiles Configuration**: New UI section in Seerr settings for configuring default quality profiles and servers separately for movies (Radarr) and TV shows (Sonarr). These defaults are used when users don't specify a profile in their request
- **Load Profiles & Servers Button**: Added convenient "Load Profiles & Servers" button in Seerr settings that fetches and populates all available quality profiles and servers from your configured Radarr/Sonarr instances

### 🔄 Changed

- **Request Flow Enhancement**: Improved the request workflow to support optional quality profile and server selection, making the bot more flexible for advanced users while remaining simple for basic use cases
- **Autocomplete Intelligence**: Enhanced autocomplete system to handle quality profiles alongside existing media search autocomplete

### 🏗️ Code Quality

- **Seerr API Module Expansion**: Extended `api/seerr.js` with new functions for fetching quality profiles and servers from Seerr API
- **Request Parameter Handling**: Improved request parameter validation and handling to support new optional fields (profileId, serverId) in media requests

---

## [1.3.5] - 2025-12-26

### ✨ Added

- **Notification Testing**: New testing section in Jellyfin Notifications settings with 6 test buttons (Movie, Series, Season, Episodes, and batch tests for seasons/episodes) to preview notification appearance with real data
- **Embed Customization**: Granular control over notification embed elements - individually toggle backdrop image, overview/description, genre, runtime, rating, and each button (Letterboxd, IMDb, Watch Now)
- **Separate Channel Mapping**: Added dedicated optional channel settings for episodes and seasons, allowing you to route different notification types to specific Discord channels
- **Localizations**: Added Swedish (sv) and German (de) language support with work-in-progress translations
- **Quality Profile Integration**: Radarr and Sonarr quality profile selection in Seerr settings for movie and TV requests

---

## [1.3.4] - 2025-12-02

### 🐛 Fixed

- **Duplicate Notifications**: Fixed issue where Series webhook notifications were using `undefined` SeriesId instead of ItemId, causing duplicate notifications and preventing season/episode notifications from being properly blocked. It would also happen happen with Movie notifications.
- **Multi-Platform Docker Support**: Added ARM64 architecture support alongside AMD64 in Docker images via multi-platform builds using QEMU and Docker Buildx

### 🚀 Performance

- **API Response Caching**: Added 6-hour cache for TMDB and OMDb API responses to reduce external API calls and improve notification speed

---

## [1.3.3] - 2025-12-01

### 🔄 Changed

- **Seasons and Episodes Notifications**: Re-enabled notifications for TV series seasons and episodes using the debouncing functionality to batch multiple episode updates into a single notification, reducing notification spam

### ✨ Added

- **Configurable Debounce**: New `WEBHOOK_DEBOUNCE_MS` setting (default: 60 seconds, range: 1-600 seconds) to control how long to wait before sending batched notifications
- **Custom UI Controls**: User-friendly seconds input with custom vertical arrow buttons (hold-to-repeat functionality) in the web dashboard
- **Configurable Embed Colors**: New color options for embeds, allowing full customization of embed colors for different media types and notifications
- **Header Visibility Toggle**: New feature to hide/show header in web dashboard

### 🚀 Performance

- **Memory Leak Prevention**: Added periodic cleanup (runs daily) to remove old debouncer entries after 7 days, preventing unbounded memory growth on long-running server

### 🐛 Fixed

- **Webhook Copy Function**: Fixed copy webhook URL button functionality

---

## [1.3.2] - 2025-11-28

### 🐛 Fixed

- **Message Handling**: Fixed `/request` and `/search` commands creating duplicate messages - now only edits the original message on success instead of creating a followUp message
- **Message Visibility**: Original command messages now remain visible in public mode, showing which user triggered the bot response

### 🔒 Security

- **Config Path Security**: Fixed critical security issue where application could attempt to write to system root `/config` directory - now ALWAYS writes config.json exclusively to project directory (`./config/config.json`)
- **Directory Restructure**: Renamed `config/` directory to `lib/` for static code files (config.js, constants.js) and created new `config/` directory exclusively for config.json storage
- **Docker Volume Updates**: Updated Dockerfile and docker-compose.yml to use `/usr/src/app/config` instead of `/config` for safer volume mapping
- **Permission Handling**: Improved config file permission management for Debian/manual installations

### 📚 Documentation

- Updated Docker deployment instructions to reflect new `/usr/src/app/config` volume path
- Added clarification about config.json storage location in project directory
- Improved Unraid deployment example with correct volume mapping

---

## [1.3.1] - 2025-11-26

### 🐛 Fixed

- **Request Command Error**: Fixed `/request` command failing with "mediaId should be number" error by ensuring TMDB ID is properly converted to number before sending to Seerr API
- **Ephemeral Messages**: Error and informative messages (already exists, permission denied) are now always ephemeral (visible only to command user), while success messages respect the `PRIVATE_MESSAGE_MODE` setting
- **Refresh Button Loading**: Fixed Discord users refresh button getting stuck in loading state when bot is not running

### ✨ Added

- **Refresh Discord Users Button**: Added refresh button in User Mapping section to manually reload Discord server members list without needing to restart the application

---

## [1.3.0] - 2025-11-26

### ℹ️ Important

- **New Requirement**: Please enable **SERVER MEMBERS INTENT** in your Discord bot configuration. Go to [Discord Developer Portal](https://discord.com/developers/applications) → Select your application → Bot section → Privileged Gateway Intents → Enable "SERVER MEMBERS INTENT". Without this, the bot will fail to start with "Used disallowed intents" error. I will make this optional for the bot to start in the future so you can set it up afterwards.

### ✨ Added

- **Trending Command**: New `/trending` command to browse weekly trending movies and TV shows from TMDB with rich autocomplete
- **Duplicate Detection**: Bot now checks if content already exists in Seerr before allowing requests
- **PM Notifications**: New `NOTIFY_ON_AVAILABLE` setting - users receive a private message when their requested content becomes available on Jellyfin (Off by default)
- **Miscellaneous Settings**: New configuration section (step 7) for optional/advanced features like auto-start and PM notifications
- **User Mapping UI**: Custom dropdown selectors with search functionality for Discord and Seerr users, which allow you to map Discord users with their respective Seerr account, so the requests will now appear on Seerr from their account. Requires enabling SERVER MEMBERS INTENT in Discord Developer Portal (Bot section -> Privileged Gateway Intents)
- **Role-Based Permissions**: Control who can use bot commands through Discord roles. `ROLE_ALLOWLIST` restricts commands to specific roles (if empty, everyone can use), and `ROLE_BLOCKLIST` blocks specific roles from using commands. Role Permissions UI in configuration dashboard (step 6) with visual role colors and member counts applied to all commands and interactions
- **Discord Auto-Detection**: Custom dropdown that automatically detects Discord servers and channels - no more manual ID entry required (You need to invite the bot first and set up its token and client id)
- **Ephemeral Message Mode**: New `PRIVATE_MESSAGE_MODE` setting that hides all bot responses (search results and request confirmations) from the public channel - messages are only visible to the user who issued the command. Can be toggled in Miscellaneous Settings (Off by default)
- **Tag Selection for Media Requests**: You can now select tags from Radarr (movies) and Sonarr (TV shows) when making requests via `/request` command or after using `/search`. Tags allow for better media management and organization, enabling you to categorize requests (e.g., "anime", "4k", "hard-disk-2"). Works in multiple scenarios:
  - Direct request: `/request Movie Title` with tag variable (that is optional if you want to skip it)
  - After search: Use `/search Movie Title`, then select "Request" button and choose your tag from dropdown
  - Season selection: For TV shows, choose specific seasons first, then select a tag for those seasons
- **Jellyfin API Integration**: Direct Jellyfin API access for reliable library detection and metadata fetching. The webhook handler now fetches item details via API to ensure accurate library identification, independent of webhook data completeness. This enables more robust features and better error handling.
- **Library-Specific Notifications**: Choose which Jellyfin libraries send Discord notifications. Load all available libraries from your Jellyfin server, then select which ones should trigger notifications. By default, all libraries are enabled. When you uncheck a library, content added to it will not generate Discord notifications. This allows you to filter out personal collections, test libraries, or content types you don't want announced.
- **Real-Time Logs Viewer**: New dedicated Logs section in the web dashboard that displays Winston logger output in real-time, allowing you to monitor application events, errors, and debug information directly from the configuration interface without needing to access server logs

### 🔒 Security

- **User Authentication System**: Added account-based authentication system for the web dashboard to protect sensitive configuration and bot settings. Users must log in with credentials before accessing the configuration interface
- **Config File Permissions**: Changed `config.json` file permissions from `0o666` to `0o600` (owner read/write only) to protect sensitive credentials
- **API Abuse Prevention**: Rate limiting prevents DoS attacks and limits configuration modification attempts
- **Input Sanitization**: Joi validation schemas prevent injection attacks and handle malformed data gracefully

### 🚀 Performance

- **API Caching**: 96% reduction in redundant TMDB API calls through intelligent response caching with TTL support
- **Autocomplete Optimization**: Smart caching for autocomplete - first search fetches from API, subsequent searches return instant cached results
- **Consolidated API Requests**: Reduced TMDB API call count using `append_to_response` parameter for credits information in single request
- **Better Memory Usage**: Removed duplicate function definitions and consolidated code through modularization

### 🏗️ Code Quality

- **Constants Module**: Created `config/constants.js` to centralize all hardcoded values including colors, timeouts, and cache TTLs
- **Response Caching**: Implemented API response caching with `node-cache` for TMDB API calls (5 min for search, 30 min for details) to reduce redundant requests by 96%
- **Structured Logging**: Replaced all console statements with Winston logger supporting multiple log levels (error, warn, info, debug) and file rotation
- **Rate Limiting**: Added DoS protection with `express-rate-limit` (100 req/15min general, 10 req/5min config operations) on all API endpoints
- **Input Validation**: Added Joi validation schemas for all API endpoints to prevent malformed data and injection attacks
- **Health Check Endpoint**: New `GET /api/health` endpoint for monitoring bot status, uptime, memory usage, and cache statistics
- **TMDB API Module**: Extracted TMDB API client into separate module (`api/tmdb.js`) with all search, details, and trending functions
- **Seerr API Module**: Extracted Seerr API client into separate module (`api/seerr.js`) with media status checks and request functions
- **Discord Commands Module**: Separated command definitions into dedicated module (`discord/commands.js`) for better maintainability
- **Modular Architecture**: Separated concerns into dedicated modules (API clients, commands, utilities) for better maintainability
- **Centralized Configuration**: All constants moved to single location (`config/constants.js`) for easier maintenance and consistency
- **Proper Logging**: All logging now goes through Winston with appropriate log levels for better debugging and monitoring
- **Validation Layer**: Consistent input validation across all API endpoints to prevent invalid data propagation

### 🔄 Changed

- **Configuration UI**: Reorganized dashboard sections - removed "Network" section, renumbered steps 5-7 (User Mapping, Role Mapping, Miscellaneous) & small visual tweaks
- **Dropdown UX**: Custom dropdowns with search, selection display, and visual feedback replace native `<select>` elements
- **Logging System**: Replaced 100+ `console.log`, `console.error`, `console.warn` statements with structured Winston logging
- **File Organization**: Refactored code into separate modules improving separation of concerns
- **Error Handling**: Improved error messages throughout application with proper logging levels

### 🗑️ Removed

- **Port Configuration**: Removed redundant WEBHOOK_PORT from UI (can be set via config.json or Docker if needed)

---

## [1.2.2] - 2025-11-18

### ✨ Added

- **Autocomplete**: Added runtime information for movies in autocomplete suggestions
- **Autocomplete**: Added season count for TV shows in autocomplete suggestions
- **Format**: Autocomplete now displays as "🎬 Title (Year) — directed by Director — runtime: 2h 14m" for movies
- **Format**: Autocomplete now displays as "📺 Title (Year) — created by Creator — 3 seasons" for TV shows
- **Auto-start Bot**: Added `AUTO_START_BOT` configuration option to automatically start the bot on server boot when valid credentials are present
- **Web UI**: Added toggle in Discord settings to enable/disable bot auto-start feature

### 🐛 Fixed

- **Autocomplete Character Limit**: Fixed Discord character limit errors by truncating long names to 95 characters + "..."
- **Autocomplete Performance**: Optimized TMDB API calls to include credits in a single request (append_to_response)
- **Linux Permissions**: Improved config.json permission handling on Linux systems with better error handling

### 🔄 Changed

- **TMDB API**: Updated `tmdbGetDetails()` to include credits information for director/creator data
- **Bot Startup**: Bot now auto-starts on container/server restart if `AUTO_START_BOT` is enabled and Discord credentials are valid

---

## [1.2.1] - 2025-11-17

### 🐛 Fixed

- **Watch Now Button**: Fixed double slash issue in Jellyfin URLs (e.g., `//web/index.html`) by properly normalizing base URLs
- **Docker Permissions**: Fixed `config.json` permission issues in Docker volumes by setting proper ownership and chmod during build and runtime
- **Web UI**: Added clear step-by-step instructions for creating Discord bot in configuration panel
- **Web UI**: Jellyfin is no longer a sin

## [1.2.0] - 2025-11-16

### ✨ Added

- **🔄 Automatic .env Migration**: Configuration automatically migrates from `.env` to `config.json` on first run
- **⚙️ Web Dashboard**: User-friendly configuration interface at `http://localhost:8282`
- **🔗 Connection Testing**: Test buttons for Seerr and Jellyfin connections
- **📝 Improved Documentation**: Completely rewritten README and CONTRIBUTING.md with modern design
- **🎯 Auto-start Bot**: Start/stop bot directly from web dashboard

### 🔄 Changed

- **Configuration System**: Moved from `.env` to `config.json` for better persistence and UI management
- **Docker Setup**: Removed `env_file` dependency; uses volume mount for `config.json`
- **API Endpoints**: Enhanced error handling and status reporting

### 🗑️ Removed

- `dotenv` dependency (no longer needed with config.json)
- `body-parser` dependency (Express 5.x includes it)
- `node-fetch` dependency (unused)

### 🔒 Security

- Ensure `config.json` is never committed (added to `.gitignore`)
- Non-root Docker user maintained
- Improved secrets handling

### 📚 Documentation

- 🆕 Modern README with quick start guide
- 🆕 Updated CONTRIBUTING.md with contribution guidelines
- 🆕 Clear configuration documentation
- 🆕 Advanced features section

### 🐳 Docker

- Simplified `docker-compose.yml`
- Added volume mount for persistent `config.json`
- Improved documentation for Docker deployment

### 🚀 Migration Guide for Users

If upgrading from v1.1.0:

1. **Backup your current setup** (optional)
2. **Update to v1.2.0** and run `npm install`
3. **If you have a `.env` file**:
   - The app will automatically migrate your variables to `config.json`
   - You can safely delete the `.env` file afterward
4. **If using Docker**:
   - Pull the new image: `docker pull nairdah/anchorr:main`
   - Run `docker compose up -d --build`
5. **Configure via Web Dashboard**:
   - Open `http://localhost:8282`
   - Verify and update configuration if needed
   - Start the bot using the dashboard

**⚠️ Breaking Changes**:

- `.env` files are no longer used (automatic migration handles this)
- Docker users: `env_file: .env` is removed from compose file
- Removed unused dependencies (`dotenv`, `body-parser`, `node-fetch`)

## [1.1.0] - 2025-11-15

### ✨ Added

- Initial release
- Discord slash commands (`/search`, `/request`)
- Jellyfin webhook notifications
- TMDB and OMDb API integration
- Seerr request functionality
- Docker support

### 🌟 Features

- Rich embeds with media details
- Autocomplete for search queries
- Season-specific TV show requests
- IMDb and Letterboxd quick links
- Jellyfin webhook debouncing
