// Catppuccin flavor + accent, saved in this browser. "auto" follows the system: Latte when
// light, Mocha when dark. index.html applies the saved choice before first paint.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

export const FLAVORS = ["auto", "latte", "frappe", "macchiato", "mocha"] as const
export const ACCENTS = [
  "rosewater", "flamingo", "pink", "mauve", "red", "maroon", "peach",
  "yellow", "green", "teal", "sky", "sapphire", "blue", "lavender",
] as const

export type Flavor = (typeof FLAVORS)[number]
export type Accent = (typeof ACCENTS)[number]

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private mode: the choice just is not remembered
  }
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches

export function resolveFlavor(flavor: Flavor): Exclude<Flavor, "auto"> {
  return flavor === "auto" ? (systemDark() ? "mocha" : "latte") : flavor
}

function apply(flavor: Flavor, accent: Accent) {
  const resolved = resolveFlavor(flavor)
  const root = document.documentElement
  root.dataset.flavor = resolved
  root.dataset.accent = accent
  root.classList.toggle("dark", resolved !== "latte")
}

interface ThemeValue {
  flavor: Flavor
  accent: Accent
  resolved: Exclude<Flavor, "auto">
  setFlavor: (flavor: Flavor) => void
  setAccent: (accent: Accent) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [flavor, setFlavorState] = useState<Flavor>(() => (FLAVORS as readonly string[]).includes(read("anchorr.flavor") ?? "") ? (read("anchorr.flavor") as Flavor) : "auto")
  const [accent, setAccentState] = useState<Accent>(() => (ACCENTS as readonly string[]).includes(read("anchorr.accent") ?? "") ? (read("anchorr.accent") as Accent) : "mauve")
  const [, rerender] = useState(0)

  useEffect(() => apply(flavor, accent), [flavor, accent])

  useEffect(() => {
    if (flavor !== "auto") return
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => {
      apply("auto", accent)
      rerender((n) => n + 1)
    }
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [flavor, accent])

  const value: ThemeValue = {
    flavor,
    accent,
    resolved: resolveFlavor(flavor),
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
