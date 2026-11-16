// Dashboard language. Strings are written in English in the code and looked up in the
// translation tables (gettext style); a missing translation falls back to English.
import { createContext, useContext, useState, type ReactNode } from "react"

import de from "@/i18n/de.json"
import fr from "@/i18n/fr.json"
import sv from "@/i18n/sv.json"

export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "sv", name: "Svenska" },
] as const

export type Language = (typeof LANGUAGES)[number]["code"]

const TABLES: Record<Language, Record<string, string>> = { en: {}, de, fr, sv }

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem("anchorr.lang")
    if (saved && saved in TABLES) return saved as Language
  } catch {
    // ignore
  }
  const browser = navigator.language.slice(0, 2)
  return browser in TABLES ? (browser as Language) : "en"
}

type Vars = Record<string, string | number>
export type Translate = (text: string, vars?: Vars) => string

interface I18nValue {
  language: Language
  setLanguage: (language: Language) => void
  t: Translate
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage)
  const t: Translate = (text, vars) => {
    const translated = TABLES[language][text] || text
    return vars ? translated.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : translated
  }
  const setLanguage = (next: Language) => {
    try {
      localStorage.setItem("anchorr.lang", next)
    } catch {
      // ignore
    }
    document.documentElement.lang = next
    setLanguageState(next)
  }
  return <I18nContext.Provider value={{ language, setLanguage, t }}>{children}</I18nContext.Provider>
}

export function useT() {
  const value = useContext(I18nContext)
  if (!value) throw new Error("useT outside I18nProvider")
  return value
}
