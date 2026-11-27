// The Seerr guest account used for Discord users without a mapping.
import { isMokaMode } from "../api/moka.js";
import { ensureGuestUser } from "../api/seerr.js";
import { updateConfig } from "../utils/configFile.js";
import logger from "../utils/logger.js";
import { normalizeSeerrUrl } from "../utils/seerrUrl.js";
import { settings } from "../utils/settings.js";

// The lookup that is running, and which Seerr it asks
let pending = null;

const seerrOf = (url, apiKey) => `${normalizeSeerrUrl(url || "")}|${apiKey || ""}`;

/**
 * Finds or creates the guest account on the given Seerr (default: the saved one) and saves
 * its id when that is still the saved Seerr. Throws when Seerr fails.
 */
function resolveGuestUser({ seerrUrl = settings.SEERR_URL, apiKey = settings.SEERR_API_KEY } = {}) {
  // Moka creates its guest account and hands over the id when it pairs
  if (isMokaMode()) return Promise.resolve(settings.MOKA_GUEST_USER_ID ? Number(settings.MOKA_GUEST_USER_ID) : null);
  if (!seerrUrl || !apiKey) return Promise.resolve(null);
  const seerr = seerrOf(seerrUrl, apiKey);
  const isSavedSeerr = () => seerr === seerrOf(settings.SEERR_URL, settings.SEERR_API_KEY);
  // One lookup at a time per Seerr, even when several requests arrive together
  if (pending?.seerr === seerr) return pending.promise;

  const run = { seerr };
  pending = run;
  run.promise = (async () => {
    try {
      const id = await ensureGuestUser({
        seerrUrl,
        apiKey,
        guestUserId: isSavedSeerr() ? settings.SEERR_GUEST_USER_ID || null : null, // the saved id belongs to the saved Seerr
        autoApprove: settings.SEERR_AUTO_APPROVE === "true",
      });
      // Seerr may have changed while this ran; then the id is not the saved Seerr's
      if (isSavedSeerr() && String(id) !== String(settings.SEERR_GUEST_USER_ID ?? "")) {
        updateConfig({ SEERR_GUEST_USER_ID: String(id) });
      }
      return Number(id);
    } finally {
      if (pending === run) pending = null;
    }
  })();
  return run.promise;
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
export function getGuestUserId(seerr) {
  // Seerr errors reach the member as "Seerr unreachable", not as "not linked"
  return resolveGuestUser(seerr);
}
