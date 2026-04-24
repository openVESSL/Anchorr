import fs from "fs";
import path from "path";
import logger from "./logger.js";

const LOCALES_DIR = path.join(process.cwd(), "locales");
const FALLBACK_LANG = "en";
// Accept only conservative locale codes (e.g. "en", "de", "pt_BR"). Prevents
// path traversal or JSON-read of arbitrary files if LANGUAGE is somehow
// attacker-influenced in the future.
const LANG_CODE_RE = /^[a-zA-Z]{2,3}(?:[_-][a-zA-Z0-9]{2,8})?$/;

let translations = null;
let loadedLang = null;

function safeLang(raw) {
  if (!raw || typeof raw !== "string") return FALLBACK_LANG;
  return LANG_CODE_RE.test(raw) ? raw : FALLBACK_LANG;
}

function loadLocaleFile(lang) {
  const file = path.join(LOCALES_DIR, `${lang}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    logger.error(`[i18n] Failed to parse ${file}:`, err.message);
    return null;
  }
}

function ensureLoaded() {
  const lang = safeLang(process.env.LANGUAGE || FALLBACK_LANG);
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
  const value = lookup(translations, key);
  if (typeof value !== "string") return key;
  return interpolate(value, vars);
}

export function resetI18nCache() {
  translations = null;
  loadedLang = null;
}
