<p align="center">
  <img src="./assets/logo-text.png" alt="Anchorr" width="300"/>
</p>

<p align="center">
  <strong>A Discord bot for your media server: request movies and shows through Seerr, and announce what arrives in Jellyfin.</strong>
</p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#first-setup">First setup</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#upgrading-from-1x">Upgrading from 1.x</a> ·
  <a href="./CHANGELOG.md">Changelog</a> ·
  <a href="https://discord.gg/S5JrsZe9mB">Discord</a>
</p>

---

Anchorr connects three things you already run: **Jellyfin**, **Seerr** and a **Discord** server. Members search and request titles from Discord, and the bot announces new movies and episodes as soon as Jellyfin has them. Everything is set up from a web dashboard by signing in; there are no API keys to copy and no Jellyfin plugin to install.

## Features

**Requests from Discord**

- `/search`, `/request` and `/trending`, with autocomplete as you type
- Season picker for shows, plus optional server, quality profile and tags
- Checks Seerr first, so titles that are already available are not requested again
- Linked members request as their own Seerr user, with their own quota and permissions. Everyone else requests through a guest account whose limits you set in Seerr

**New content announcements**

- Movies, shows, seasons and episodes, each switchable and routable to its own channel, usually posted within a minute of Jellyfin adding them
- Episodes that arrive together are grouped into one message
- Per-library channels, and libraries marked as anime use their own default quality profile
- Quality upgrades from Sonarr and Radarr are not announced again
- Optional direct message to whoever requested a title once it is available

**Extras**

- Daily random pick with a Request button
- Weekly roundup of everything added in the last seven days
- Role allowlist and blocklist, private replies
- Customizable embeds: fields, buttons and colors

**Dashboard**

- Guided setup: Jellyfin, Seerr and Discord in three steps
- Overview with your servers, Seerr request counts, the latest requests (approve or decline them) and recent bot activity
- Sign in with your Jellyfin administrator account, or an optional local account
- Download a backup of the configuration and restore it, on the same or a new install
- All four [Catppuccin](https://catppuccin.com) flavors with a choice of accent color (Macchiato by default)
- English, German, French and Swedish for the dashboard and every bot message; titles, overviews and genres come in the bot's language when TMDB has a translation

## Requirements

- A Jellyfin server (10.10 or 12.x)
- A Seerr instance connected to that Jellyfin
- A Discord server where you can add bots
- Docker, or Node.js 22 (22.23.4 or later), 24 (24.22.1 or later) or 26 (26.12.1 or later)

## Installation

Anchorr runs well next to Jellyfin and Seerr on the same machine or network. Pick one method below, then continue with [First setup](#first-setup).

### Docker Compose (recommended)

Create a folder, download the compose file and start it:

```bash
mkdir anchorr && cd anchorr
curl -O https://raw.githubusercontent.com/openVESSL/Anchorr/main/docker-compose.yml
docker compose up -d
```

Open `http://<server-ip>:8282`. Settings are stored in `./anchorr-data` next to the compose file. Set `TZ` in the compose file to your time zone. This works the same way in Portainer stacks, TrueNAS and Synology Container Manager.

### Docker run

```bash
docker run -d \
  --name anchorr \
  --restart unless-stopped \
  -p 8282:8282 \
  -e TZ=Europe/Berlin \
  -v ./anchorr-data:/usr/src/app/config \
  nairdah/anchorr:latest
```

To use another port on the host, change the first number, for example `-p 9000:8282`. Set `TZ` to your time zone: the weekly roundup hour and the log times follow it.

### Unraid

1. Open **Apps** (Community Applications) and search for **Anchorr**.
2. Keep the defaults: port `8282` and the config path `/mnt/user/appdata/anchorr`.
3. Select **Apply**, then open the WebUI from the container's menu.

If Anchorr does not show up in Apps, add the template manually: **Docker > Add Container > Template**, using `https://raw.githubusercontent.com/openVESSL/Anchorr/main/anchorr.xml`.

### Node.js (Linux, macOS, Windows)

Install Node.js first (see [Requirements](#requirements)), then:

```bash
git clone https://github.com/openVESSL/Anchorr.git
cd Anchorr
npm install
npm run build
npm start
```

`npm run build` builds the dashboard and is needed once per update. Anchorr then listens on `http://127.0.0.1:8282`, reachable only from the same machine. To open it from other devices on your network, set `BIND_HOST`:

```bash
# Linux and macOS
BIND_HOST=0.0.0.0 npm start
```

```powershell
# Windows (PowerShell)
$env:BIND_HOST = "0.0.0.0"; npm start
```

Settings are stored in the `config` folder inside the project. Set `ANCHORR_CONFIG_DIR` to keep them somewhere else.

<details>
<summary>Run as a service on Linux (systemd)</summary>

Create `/etc/systemd/system/anchorr.service`, adjusting the user and path:

```ini
[Unit]
Description=Anchorr
After=network-online.target
Wants=network-online.target

[Service]
User=anchorr
WorkingDirectory=/opt/anchorr
ExecStart=/usr/bin/node app.js
Environment=NODE_ENV=production
Environment=BIND_HOST=0.0.0.0
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now anchorr
journalctl -u anchorr -f   # follow the logs
```

</details>

## First setup

Open the dashboard. On the first visit it starts a short setup:

1. **Jellyfin.** Enter its address and sign in with a Jellyfin administrator account. Anchorr creates its own API key named "Anchorr" in Jellyfin. Your password is not stored. Signing in as a Jellyfin administrator is also what makes you the owner of this Anchorr.
2. **Seerr.** Enter its address. Anchorr signs in to Seerr with the same Jellyfin account to read Seerr's API key, then creates the guest account used by members without a linked account.
3. **Discord.** Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Under **Bot**, select **Reset Token**, copy the token and turn on **Server Members Intent**. Paste the token in Anchorr, use the invite button to add the bot to your server, and pick that server.

The bot comes online and the commands are ready. Everything else, such as the announcement channel, linked users and the weekly roundup, can be set later from the sidebar.

You can paste API keys instead of signing in at the Jellyfin and Seerr steps if you prefer.

## Commands

| Command | What it does |
| --- | --- |
| `/search <title>` | Shows details for a movie or show, with a Request button. Shows open a season picker. |
| `/request <title>` | Requests a movie right away, or opens the season picker for a show. Optional `server`, `quality` and `tag`. |
| `/trending` | Lists this week's trending titles to pick from. |

Who may use the commands is set under **Requests > Roles**. Whether a request is approved automatically follows the requesting user's permissions in Seerr.

## Upgrading from 1.x

Your existing configuration is upgraded automatically on the first start. Before that, Anchorr copies the config folder to `backup-1.x` inside it; if the copy fails, it does not start. Your local account, linked members, channels and other settings stay as they are. Afterwards the Overview shows a checklist of what changed.

1. **Back up the config folder** to another place before you update. The automatic copy stays in the same folder, so it does not help if the volume itself is lost.
2. **Update Anchorr** as described in [Updating](#updating). Without Docker, use Node.js 22.23.4, 24.22.1, 26.12.1 or newer and run `npm run build` after `npm install`.
3. **Remove what is no longer used:**
   - The Anchorr destination in the Jellyfin Webhook plugin. Anchorr now watches Jellyfin directly and catches up on anything added while it was offline. Calls from the plugin are ignored, and the dashboard reminds you while they keep arriving. Uninstall the plugin if nothing else uses it.
   - Your TMDB and OMDb keys. Search, details, ratings and the daily pick come from Seerr, and the keys are removed from the configuration automatically.
   - The `JELLYFIN_POLLING_ENABLED` variable, if you set it. Watching Jellyfin is always on.
4. **Check the Seerr user "Discord (Anchorr)".** In 1.x, members without a linked account requested as the API key's owner, which skipped approvals and quotas. In 2.0 they request as this guest user, created automatically. Set its quota and permissions in Seerr.
5. **Check auto-approve.** Anchorr's switch now applies to the guest account only; linked members follow their own Seerr permissions. If you relied on the switch to approve everyone, give those users the Auto-Approve permission in Seerr.
6. **Set the time zone** on Docker with `TZ`, for example `TZ=Europe/Berlin`, so the weekly roundup posts at the hour you pick. Unraid sets it for containers created from the template.
7. **Rotate API keys if you shared logs.** Versions before 2.0 could write the Jellyfin and Seerr API keys into the log files when a request failed.

You can also sign in with a Jellyfin administrator account now. The previous dashboard is still available at `/legacy` during the 2.0 series.

## Configuration reference

Almost everything is set in the dashboard and saved in `config.json`. A few settings belong to the environment, mainly for Docker:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBHOOK_PORT` | `8282` | Port of the dashboard inside the container or process. |
| `BIND_HOST` | `0.0.0.0` in Docker, `127.0.0.1` otherwise | Address to listen on. |
| `TRUST_PROXY` | off | Set to `true` behind a reverse proxy, so sign-in cookies are marked secure and rate limits see real client addresses. |
| `ANCHORR_CONFIG_DIR` | `/usr/src/app/config` in Docker, `./config` otherwise | Where the configuration and state files (`config.json`, `pending-requests.json`, `activity.json`) are kept. |
| `JELLYFIN_POLLING_INTERVAL` | `60000` (1 min) | How often to check Jellyfin for new items, in milliseconds. |

## Security

Anchorr is meant for your home network. The dashboard holds your Discord token and API keys, so do not expose it directly to the internet.

- For remote access, prefer a VPN. If you use a reverse proxy, put it behind HTTPS and set `TRUST_PROXY=true`.
- Only Jellyfin administrators, or the local account, can sign in. Failed sign-ins are slowed down and locked per address.
- Secrets in `config.json` are encoded, not encrypted. Keep the config folder and any backup downloaded from Settings private.

See [SECURITY.md](./SECURITY.md) to report a vulnerability.

## Updating

```bash
# Docker Compose
docker compose pull && docker compose up -d

# Docker run: pull, remove and recreate the container with the same options
docker pull nairdah/anchorr:latest

# Node.js
git pull && npm install && npm run build
```

On Unraid, use **Check for Updates** on the Docker tab.

## Translations

The bot's messages live in `locales/`, the dashboard's in `frontend/src/i18n/`. To add a language, see [CONTRIBUTING.md](./CONTRIBUTING.md#translations).

## Community and contributing

Questions, ideas and known issues are discussed on the [Anchorr Discord server](https://discord.gg/S5JrsZe9mB). There is also a channel on the [r/JellyfinCommunity](https://discord.gg/awFC5m4xkr) server.

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md). If Anchorr is useful to you, you can support it on [Ko-fi](https://ko-fi.com/nairdah).

### Contributors

<table>
  <tr>
    <td align="center"><a href="https://github.com/nairdahh"><img src="https://images.weserv.nl/?url=avatars.githubusercontent.com/nairdahh?v=4&h=80&w=80&fit=cover&mask=circle&maxage=7d" width="80" alt="" /><br/><sub><b>nairdahh</b></sub></a></td>
    <td align="center"><a href="https://github.com/lucideds"><img src="https://images.weserv.nl/?url=avatars.githubusercontent.com/lucideds?v=4&h=80&w=80&fit=cover&mask=circle&maxage=7d" width="80" alt="" /><br/><sub><b>lucideds</b></sub></a></td>
    <td align="center"><a href="https://github.com/retardgerman"><img src="https://images.weserv.nl/?url=avatars.githubusercontent.com/retardgerman?v=4&h=80&w=80&fit=cover&mask=circle&maxage=7d" width="80" alt="" /><br/><sub><b>retardgerman</b></sub></a></td>
    <td align="center"><a href="https://github.com/TheColorman"><img src="https://images.weserv.nl/?url=avatars.githubusercontent.com/TheColorman?v=4&h=80&w=80&fit=cover&mask=circle&maxage=7d" width="80" alt="" /><br/><sub><b>TheColorman</b></sub></a></td>
    <td align="center"><a href="https://github.com/IPvNick"><img src="https://images.weserv.nl/?url=avatars.githubusercontent.com/IPvNick?v=4&h=80&w=80&fit=cover&mask=circle&maxage=7d" width="80" alt="" /><br/><sub><b>IPvNick</b></sub></a></td>
    <td align="center"><a href="https://github.com/whoopsi-daisy"><img src="https://images.weserv.nl/?url=avatars.githubusercontent.com/whoopsi-daisy?v=4&h=80&w=80&fit=cover&mask=circle&maxage=7d" width="80" alt="" /><br/><sub><b>whoopsi-daisy</b></sub></a></td>
    <td align="center"><a href="https://github.com/nyakuoff"><img src="https://images.weserv.nl/?url=avatars.githubusercontent.com/nyakuoff?v=4&h=80&w=80&fit=cover&mask=circle&maxage=7d" width="80" alt="" /><br/><sub><b>nyakuoff</b></sub></a></td>
  </tr>
</table>

## License

Released into the public domain under the [Unlicense](./LICENSE).
