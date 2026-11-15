import { Check } from "lucide-react"

import { useT } from "@/lib/i18n"
import { ACCENTS, FLAVORS, useTheme, type Flavor } from "@/lib/theme"
import { cn } from "@/lib/utils"

const FLAVOR_NAMES: Record<Flavor, string> = {
  auto: "Auto",
  latte: "Latte",
  frappe: "Frappé",
  macchiato: "Macchiato",
  mocha: "Mocha",
}

/** Catppuccin flavor and accent color, used in the top bar and on the Settings page. */
export function ThemePicker() {
  const { t } = useT()
  const { flavor, accent, setFlavor, setAccent } = useTheme()
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm font-medium">{t("Theme")}</p>
        <div className="grid grid-cols-3 gap-1.5">
          {FLAVORS.map((f) => (
            <button
              key={f}
              onClick={() => setFlavor(f)}
              aria-pressed={flavor === f}
              className={cn(
                "rounded-md border px-2 py-1.5 text-sm transition-colors",
                flavor === f ? "border-primary bg-primary/10" : "hover:bg-accent"
              )}
            >
              {f === "auto" ? t("Auto") : FLAVOR_NAMES[f]}
            </button>
          ))}
        </div>
        {flavor === "auto" && <p className="text-muted-foreground mt-2 text-xs">{t("Follows your system: Latte when light, Mocha when dark.")}</p>}
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
    </div>
  )
}
