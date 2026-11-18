// Upgrade checklist for installs migrated from 1.x: what changed and what still needs a look.
// Shown on the Overview until the admin dismisses it.
import { Router } from "express";
import fs from "fs";
import { botState } from "../bot/botState.js";
import { authenticateToken } from "../utils/auth.js";
import { updateConfig, v1BackupDir } from "../utils/configFile.js";
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";

const router = Router();

const UTC_ZONES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT"]);

const isHttpUrl = (value) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/**
 * The checklist items, most important first.
 * state: "done" / "todo" (checked live), "manual" (to check in Seerr), "info" (nothing to do).
 */
export function upgradeChecklist({ record, values, legacyWebhookSeen, timeZone, backupDir, backupExists }) {
  const items = [];
  const linked = Boolean(values.JELLYFIN_BASE_URL && values.JELLYFIN_API_KEY);
  items.push({ id: "jellyfin_linked", severity: "critical", state: linked ? "done" : "todo" });

  // mappings is null when 1.x had unreadable mappings: mention it rather than miss it
  if (record.autoApprove && record.mappings !== 0) {
    items.push({ id: "auto_approve", severity: "important", state: "manual" });
  }
  if (values.SEERR_URL && values.SEERR_API_KEY) {
    const guestId = values.SEERR_GUEST_USER_ID;
    const item = { id: "guest_limits", severity: "important", state: guestId ? "manual" : "todo" };
    if (guestId && isHttpUrl(values.SEERR_URL)) item.link = `${values.SEERR_URL.replace(/\/+$/, "")}/users/${guestId}/settings`;
    items.push(item);
  }
  if (values.WEEKLY_ROUNDUP_ENABLED === "true") {
    items.push({ id: "time_zone", severity: "important", state: UTC_ZONES.has(timeZone) ? "todo" : "done", timeZone });
  }
  items.push({ id: "webhook_plugin", severity: "cleanup", state: legacyWebhookSeen ? "todo" : "done" });
  items.push({ id: "backup", severity: "info", state: "info", path: backupDir, exists: backupExists });
  items.push({ id: "removed_keys", severity: "info", state: "info" });
  return items;
}

// Read from the in-memory settings (kept current by every config write), not from disk on each poll
router.get("/upgrade", authenticateToken, (_req, res) => {
  if (!settings.UPGRADE_FROM_V1 || settings.UPGRADE_DISMISSED_AT) return res.json({ show: false, items: [] });
  let record;
  try {
    record = JSON.parse(settings.UPGRADE_FROM_V1);
    if (!record || typeof record !== "object") throw new Error("not an object");
  } catch (err) {
    logger.error(`UPGRADE_FROM_V1 in config.json is not readable: ${err.message}`);
    return res.status(500).json({ success: false, error: "The upgrade record in config.json is not readable." });
  }
  const backupDir = v1BackupDir();
  res.json({
    show: true,
    upgradedAt: record.at,
    items: upgradeChecklist({
      record,
      values: settings,
      legacyWebhookSeen: Boolean(botState.legacyWebhookLastSeen),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      backupDir,
      backupExists: fs.existsSync(backupDir),
    }),
  });
});

// JSON only, so a plain HTML form on another site cannot send it with the session cookie
router.post("/upgrade/dismiss", authenticateToken, (req, res) => {
  if (!req.is("application/json")) {
    return res.status(415).json({ success: false, error: "Expected a JSON request." });
  }
  if (!updateConfig({ UPGRADE_DISMISSED_AT: new Date().toISOString() })) {
    logger.error("Could not save that the upgrade checklist was dismissed");
    return res.status(500).json({ success: false, error: "Could not save the configuration. Check the server logs." });
  }
  res.json({ success: true });
});

export default router;
