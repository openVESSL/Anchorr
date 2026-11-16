import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import logger from "./logger.js";
import { settings } from "./settings.js";

// Resolve relative to this module so the loader works regardless of cwd
// (e.g. when the bot is launched from a different working directory).
const LOCALES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "locales"
);
const FALLBACK_LANG = "en";
// Accept only conservative locale codes (e.g. "en", "de", "pt_BR"). Prevents
// path traversal or JSON-read of arbitrary files if LANGUAGE is somehow
// attacker-influenced in the future.
const LANG_CODE_RE = /^[a-zA-Z]{2,3}(?:[_-][a-zA-Z0-9]{2,8})?$/;

let translations = null;
let englishFallback = null;
let loadedLang = null;
const warnedMissingKeys = new Set();

function safeLang(raw) {
  if (!raw || typeof raw !== "string") return FALLBACK_LANG;
  return LANG_CODE_RE.test(raw) ? raw : FALLBACK_LANG;
}

function loadLocaleFile(lang) {
  const file = path.join(LOCALES_DIR, `${lang}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    // ENOENT is the "missing locale" path; everything else (EACCES, parse
    // errors, etc.) is a real failure that should be loud in the logs so
    // empty translations aren't silently blamed on a missing file.
    if (err.code === "ENOENT") return null;
    logger.error(`[i18n] Failed to read/parse ${file}: ${err.message}`);
    return null;
  }
}

function ensureLoaded() {
  const lang = safeLang(settings.LANGUAGE || FALLBACK_LANG);
  if (translations && loadedLang === lang) return;

  const primary = loadLocaleFile(lang);
  const fallback = lang === FALLBACK_LANG ? null : loadLocaleFile(FALLBACK_LANG);

  if (!primary && !fallback) {
    logger.warn(`[i18n] No locale files found (tried ${lang}, ${FALLBACK_LANG}).`);
    translations = {};
  } else {
    translations = primary || fallback;
    if (!primary && fallback) {
      logger.warn(`[i18n] Locale '${lang}' not found, using '${FALLBACK_LANG}'.`);
    }
  }
  // Per-key fallback: a locale file that exists but is missing a specific
  // key (e.g. added after that translation was last updated) should still
  // resolve to English instead of leaking the raw key into user-facing text.
  // Reuse `fallback` above instead of re-reading en.json a second time.
  englishFallback = lang === FALLBACK_LANG ? translations : fallback;
  if (lang !== FALLBACK_LANG && !englishFallback) {
    // Unlike the "primary locale missing" case above (expected for
    // less-maintained translations), en.json missing entirely means
    // per-key fallback has nothing to fall back to — every miss in the
    // active locale will now silently return the raw key.
    logger.error(
      `[i18n] English fallback locale ('${FALLBACK_LANG}.json') failed to load; missing keys in '${lang}' will render as raw keys.`
    );
  }
  loadedLang = lang;
}

function lookup(obj, key) {
  return key.split(".").reduce((acc, part) => {
    if (acc && typeof acc === "object" && part in acc) return acc[part];
    return undefined;
  }, obj);
}

function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (match, name) =>
    name in vars ? String(vars[name]) : match
  );
}

export function t(key, vars) {
  ensureLoaded();
  if (!key || typeof key !== "string") return String(key ?? "");
  let value = lookup(translations, key);
  if (typeof value !== "string") {
    value = lookup(englishFallback, key);
    if (typeof value !== "string") {
      // Missing in the active locale AND in English: the raw key is about to
      // be rendered to a user, so this is a code bug, not a translation gap.
      const missKey = `__missing_everywhere__:${key}`;
      if (!warnedMissingKeys.has(missKey)) {
        warnedMissingKeys.add(missKey);
        logger.error(
          `[i18n] Key '${key}' is missing in '${loadedLang}' AND in '${FALLBACK_LANG}' — the raw key will be shown to users.`
        );
      }
      return key;
    }
    // Warn once per key — t() runs per rendered string, so an untranslated
    // locale would otherwise flood the log on every roundup.
    const warnKey = `${loadedLang}:${key}`;
    if (!warnedMissingKeys.has(warnKey)) {
      warnedMissingKeys.add(warnKey);
      logger.warn(`[i18n] Key '${key}' missing in '${loadedLang}', falling back to '${FALLBACK_LANG}'.`);
    }
  }
  return interpolate(value, vars);
}

export function resetI18nCache() {
  translations = null;
  englishFallback = null;
  loadedLang = null;
  warnedMissingKeys.clear();
}
