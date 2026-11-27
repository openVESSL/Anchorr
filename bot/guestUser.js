// The Seerr guest account used for Discord users without a mapping.
import { isMokaMode } from "../api/moka.js";
import { ensureGuestUser } from "../api/seerr.js";
import { updateConfig } from "../utils/configFile.js";
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";

let pending = null;

/** Finds or creates the guest account and saves its id; throws when Seerr fails. */
function resolveGuestUser() {
  // Moka creates its guest account and hands over the id when it pairs
  if (isMokaMode()) return Promise.resolve(settings.MOKA_GUEST_USER_ID ? Number(settings.MOKA_GUEST_USER_ID) : null);
  if (!settings.SEERR_URL || !settings.SEERR_API_KEY) return Promise.resolve(null);
  // One attempt at a time, even when several requests arrive together
  pending ??= (async () => {
    try {
      const id = await ensureGuestUser({
        seerrUrl: settings.SEERR_URL,
        apiKey: settings.SEERR_API_KEY,
        guestUserId: settings.SEERR_GUEST_USER_ID || null,
        autoApprove: settings.SEERR_AUTO_APPROVE === "true",
      });
      if (String(id) !== String(settings.SEERR_GUEST_USER_ID ?? "")) {
        updateConfig({ SEERR_GUEST_USER_ID: String(id) });
      }
      return Number(id);
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** Makes sure the guest account exists and its id is saved. Never throws; null when unavailable. */
export function prepareGuestUser() {
  return resolveGuestUser().catch((err) => {
    logger.error(
      `Could not prepare the Seerr guest account; Discord users without a linked account cannot request until it exists: ${err.message}`
    );
    return null;
  });
}

/** Guest id for a request, checked against Seerr each time: after a Seerr reset the saved id can be a real person. */
export function getGuestUserId() {
  // Seerr errors reach the member as "Seerr unreachable", not as "not linked"
  return resolveGuestUser();
}
