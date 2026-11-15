// Catppuccin flavor + accent, saved in this browser (Macchiato by default).
// public/theme-init.js applies the saved choice before first paint.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

export const FLAVORS = ["latte", "frappe", "macchiato", "mocha"] as const
export const ACCENTS = [
  "rosewater", "flamingo", "pink", "mauve", "red", "maroon", "peach",
  "yellow", "green", "teal", "sky", "sapphire", "blue", "lavender",
] as const

export type Flavor = (typeof FLAVORS)[number]
export type Accent = (typeof ACCENTS)[number]

export const DEFAULT_FLAVOR: Flavor = "macchiato"
export const DEFAULT_ACCENT: Accent = "mauve"

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key)
    return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private mode: the choice just is not remembered
  }
}

function apply(flavor: Flavor, accent: Accent) {
  const root = document.documentElement
  root.dataset.flavor = flavor
  root.dataset.accent = accent
  root.classList.toggle("dark", flavor !== "latte")
}

interface ThemeValue {
  flavor: Flavor
  accent: Accent
  setFlavor: (flavor: Flavor) => void
  setAccent: (accent: Accent) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [flavor, setFlavorState] = useState<Flavor>(() => read("anchorr.flavor", FLAVORS, DEFAULT_FLAVOR))
  const [accent, setAccentState] = useState<Accent>(() => read("anchorr.accent", ACCENTS, DEFAULT_ACCENT))

  useEffect(() => apply(flavor, accent), [flavor, accent])

  const value: ThemeValue = {
    flavor,
    accent,
    setFlavor: (next) => {
      write("anchorr.flavor", next)
      setFlavorState(next)
    },
    setAccent: (next) => {
      write("anchorr.accent", next)
      setAccentState(next)
    },
  }
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const value = useContext(ThemeContext)
  if (!value) throw new Error("useTheme outside ThemeProvider")
  return value
}
