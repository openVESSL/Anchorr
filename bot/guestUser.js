// The Seerr guest account used for Discord users without a mapping.
import { ensureGuestUser } from "../api/seerr.js";
import { updateConfig } from "../utils/configFile.js";
import logger from "../utils/logger.js";
import { settings } from "../utils/settings.js";

let pending = null;

/** Makes sure the guest account exists and its id is saved. Never throws; null when unavailable. */
export function prepareGuestUser() {
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
    } catch (err) {
      logger.error(
        `Could not prepare the Seerr guest account; Discord users without a linked account cannot request until it exists: ${err.message}`
      );
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** Guest id for a request: the saved one, or a fresh attempt if Seerr was down at startup. */
export async function getGuestUserId() {
  return settings.SEERR_GUEST_USER_ID ? Number(settings.SEERR_GUEST_USER_ID) : prepareGuestUser();
}
