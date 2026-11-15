// Runtime settings: values from config.json, falling back to the process environment.
// Config values never go into process.env, so nothing saved from the dashboard can change
// how Node itself behaves (TLS, proxies, bind address).
// Reads return what process.env used to return (strings, objects as JSON) so callers
// keep their existing parsing.

// Deployment settings that only the environment may set, never config.json.
const ENV_ONLY = new Set([
  "NODE_ENV",
  "TRUST_PROXY",
  "ANCHORR_CONFIG_DIR",
  "JELLYFIN_POLLING_ENABLED",
  "JELLYFIN_POLLING_INTERVAL",
]);

let values = {};

/** Replace all config-backed settings (called after config.json is loaded or written). */
export function replaceSettings(config) {
  values = { ...(config || {}) };
}

function asEnvString(value) {
  if (value === undefined || value === null) return undefined;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export const settings = new Proxy(
  {},
  {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      if (!ENV_ONLY.has(key) && Object.hasOwn(values, key)) return asEnvString(values[key]);
      return process.env[key];
    },
    has(_target, key) {
      return (!ENV_ONLY.has(key) && Object.hasOwn(values, key)) || key in process.env;
    },
    set() {
      throw new Error("settings are read-only; use writeConfig/updateConfig");
    },
  }
);
