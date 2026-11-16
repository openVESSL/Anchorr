# Security Policy

## Supported Versions

Anchorr is developed on the `main` branch, and security fixes are only guaranteed for the latest release and the current `main` branch.

| Version | Supported |
| ------- | --------- |
| 2.0.x (latest release) | Yes |
| `main` branch | Yes |
| 1.x and older | No, update to 2.0 |

If you are running an older version, please update before reporting a security issue unless the issue prevents safe updating.

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Instead, report vulnerabilities privately by contacting the maintainer through one of the following private channels:

- A private security advisory on GitHub (**Security > Report a vulnerability**), if enabled for this repository
- A direct message to the maintainer on the [Anchorr Discord server](https://discord.gg/S5JrsZe9mB)

If no private reporting channel is available, open a minimal GitHub issue **without disclosing exploitation details**, only stating that you need a private contact for a security report.

## What to Include

Please include as much of the following as possible:

- A clear description of the vulnerability
- Affected version or commit
- Steps to reproduce
- Proof of concept, if available
- Impact assessment
- Any suggested remediation

Useful context may include whether the issue affects:

- The web dashboard
- Authentication or session handling
- Stored configuration or secrets
- Discord bot commands or permissions
- The Jellyfin connection, and the old `/jellyfin-webhook` endpoint that is still answered but ignored
- Seerr request handling
- Docker deployment defaults

## Response Process

The maintainer will try to:

1. Acknowledge receipt of the report
2. Confirm whether the issue is reproducible
3. Assess severity and impact
4. Prepare a fix
5. Publish the fix and disclose the issue responsibly

Please allow reasonable time for investigation and remediation before public disclosure.

## Disclosure Policy

Please practice responsible disclosure.

Do not publicly share exploit details, proof of concept code, or reproduction steps until:

- A fix has been released, or
- The maintainer has confirmed that public disclosure is safe

## Security Best Practices for Users

When self-hosting Anchorr:

- Do not expose the dashboard directly to the public internet unless you fully understand the risk
- Use a reverse proxy with HTTPS if remote access is required
- Keep API keys, bot tokens, and secrets out of screenshots, logs, and public config files
- Treat `config.json` and configuration backups downloaded from Settings as secrets: they hold the bot token and API keys encoded, not encrypted
- If you shared log files from 1.x, rotate the Jellyfin and Seerr API keys: failed requests could write them into the logs
- Restrict who can access the dashboard
- Keep Anchorr and all dependencies up to date
- Review Discord bot permissions and only grant what is necessary
- Avoid overly broad role lists, and give the Seerr guest account "Discord (Anchorr)" only the permissions and quota you want every unlinked member to have
- Behind a reverse proxy, set `TRUST_PROXY=true` so sign-in cookies are marked secure

## Scope

This policy applies to vulnerabilities that could affect the confidentiality, integrity, or availability of Anchorr or user data, including but not limited to:

- Remote code execution
- Authentication bypass
- Authorization flaws
- Secret leakage
- Abuse of the setup, backup and restore, or webhook endpoints
- Injection vulnerabilities
- Dependency vulnerabilities with real impact
- Sensitive information exposure

The following are generally out of scope unless they demonstrate real security impact:

- Best-practice suggestions without an exploit path
- Denial of service requiring unrealistic conditions
- Vulnerabilities only present in unsupported versions
- Issues caused solely by insecure third-party deployment choices without an Anchorr defect

## Credits

Security researchers who report valid issues responsibly may be credited in release notes or documentation, unless they prefer to remain anonymous.
