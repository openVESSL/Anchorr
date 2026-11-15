import { Check } from "lucide-react"

import { useT } from "@/lib/i18n"
import { ACCENTS, FLAVORS, useTheme, type Flavor } from "@/lib/theme"
import { cn } from "@/lib/utils"

const FLAVOR_NAMES: Record<Flavor, string> = {
  latte: "Latte",
  frappe: "Frappé",
  macchiato: "Macchiato",
  mocha: "Mocha",
}

/** Credit for the color palette, linking to Catppuccin. */
export function CatppuccinCredit({ className }: { className?: string }) {
  const { t } = useT()
  return (
    <p className={cn("text-muted-foreground text-xs", className)}>
      {t("Color palette by")}{" "}
      <a href="https://catppuccin.com" target="_blank" rel="noreferrer" className="text-primary font-medium underline-offset-4 hover:underline">
        Catppuccin
      </a>
    </p>
  )
}

/** Catppuccin flavor and accent color, used in the top bar and on the Settings page. */
export function ThemePicker() {
  const { t } = useT()
  const { flavor, accent, setFlavor, setAccent } = useTheme()
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm font-medium">{t("Theme")}</p>
        <div className="grid grid-cols-2 gap-1.5">
          {FLAVORS.map((f) => (
            <button
              key={f}
              onClick={() => setFlavor(f)}
              aria-pressed={flavor === f}
              data-flavor-preview={f}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors",
                flavor === f ? "border-primary bg-primary/10 text-primary" : "hover:bg-accent"
              )}
            >
              <span className={cn("size-3 rounded-full border", f === "latte" ? "bg-[#eff1f5]" : f === "frappe" ? "bg-[#303446]" : f === "macchiato" ? "bg-[#24273a]" : "bg-[#1e1e2e]")} />
              {FLAVOR_NAMES[f]}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium">{t("Accent color")}</p>
        <div className="grid grid-cols-7 gap-1.5">
          {ACCENTS.map((a) => (
            <button
              key={a}
              onClick={() => setAccent(a)}
              aria-label={a}
              aria-pressed={accent === a}
              title={a}
              className="grid aspect-square place-items-center rounded-full ring-offset-2 ring-offset-[var(--popover)] focus-visible:ring-2"
              style={{ background: `var(--ctp-${a})` }}
            >
              {accent === a && <Check className="size-3.5" style={{ color: "var(--on-accent)" }} />}
            </button>
          ))}
        </div>
      </div>
      <CatppuccinCredit />
    </div>
  )
}
