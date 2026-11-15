import { Check } from "lucide-react"
import type { CSSProperties } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { useT } from "@/lib/i18n"
import { ACCENTS, FLAVORS, useTheme, type Accent, type Flavor } from "@/lib/theme"
import { cn } from "@/lib/utils"

const FLAVOR_NAMES: Record<Flavor, string> = {
  latte: "Latte",
  frappe: "Frappé",
  macchiato: "Macchiato",
  mocha: "Mocha",
}

const accentName = (a: Accent) => a[0].toUpperCase() + a.slice(1)

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

function AccentSwatches({ size }: { size: "sm" | "lg" }) {
  const { accent, setAccent } = useTheme()
  return (
    <div className={cn("flex flex-wrap", size === "lg" ? "gap-2" : "gap-1.5")}>
      {ACCENTS.map((a) => (
        <button
          key={a}
          onClick={() => setAccent(a)}
          aria-label={accentName(a)}
          aria-pressed={accent === a}
          title={accentName(a)}
          className={cn(
            "ring-offset-background grid place-items-center rounded-full ring-offset-2 transition-transform hover:scale-110 focus-visible:ring-2",
            size === "lg" ? "size-9" : "size-7",
            accent === a && "ring-foreground/60 ring-2"
          )}
          style={{ background: `var(--ctp-${a})` }}
        >
          {accent === a && <Check className={size === "lg" ? "size-4" : "size-3.5"} style={{ color: "var(--on-accent)" }} />}
        </button>
      ))}
    </div>
  )
}

/** Compact flavor and accent picker for the top bar popover. */
export function ThemePicker() {
  const { t } = useT()
  const { flavor, setFlavor } = useTheme()
  return (
    <div className="max-w-sm space-y-4">
      <div>
        <p className="mb-2 text-sm font-medium">{t("Theme")}</p>
        <div className="grid grid-cols-2 gap-1.5">
          {FLAVORS.map((f) => (
            <button
              key={f}
              onClick={() => setFlavor(f)}
              aria-pressed={flavor === f}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors",
                flavor === f ? "border-primary bg-primary/10 text-primary" : "hover:bg-accent"
              )}
            >
              <span data-flavor-preview={f} className="size-3 rounded-full border bg-[var(--ctp-base)]" />
              {FLAVOR_NAMES[f]}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium">{t("Accent color")}</p>
        <AccentSwatches size="sm" />
      </div>
      <CatppuccinCredit />
    </div>
  )
}

/** A miniature dashboard drawn in one flavor's colors, with the chosen accent. */
function FlavorMock({ flavor, accent }: { flavor: Flavor; accent: Accent }) {
  // Inline on the same element, so var() resolves against this flavor's palette
  const style = { "--pa": `var(--ctp-${accent})`, background: "var(--ctp-base)" } as CSSProperties
  const bar = "h-1.5 rounded-full"
  return (
    <div data-flavor-preview={flavor} style={style} className="flex h-28 overflow-hidden rounded-md">
      <div className="flex w-1/4 flex-col gap-1.5 p-2" style={{ background: "var(--ctp-mantle)" }}>
        <span className="mb-1 size-3 rounded-full" style={{ background: "var(--pa)" }} />
        <span className={cn(bar, "w-full")} style={{ background: "color-mix(in srgb, var(--pa) 35%, transparent)" }} />
        <span className={cn(bar, "w-4/5")} style={{ background: "var(--ctp-surface1)" }} />
        <span className={cn(bar, "w-3/5")} style={{ background: "var(--ctp-surface1)" }} />
        <span className={cn(bar, "w-4/5")} style={{ background: "var(--ctp-surface1)" }} />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-2.5">
        <span className={cn(bar, "h-2 w-1/2")} style={{ background: "var(--ctp-text)" }} />
        <div className="flex flex-1 flex-col justify-between rounded-md p-2" style={{ background: "var(--ctp-surface0)" }}>
          <div className="space-y-1">
            <span className={cn(bar, "block w-3/4")} style={{ background: "var(--ctp-subtext0)" }} />
            <span className={cn(bar, "block w-1/2")} style={{ background: "var(--ctp-overlay0)" }} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-8 rounded-sm" style={{ background: "var(--pa)" }} />
            <span className="h-3 w-8 rounded-sm border" style={{ borderColor: "var(--ctp-surface2)" }} />
            <span className="ml-auto flex h-2.5 w-4.5 items-center justify-end rounded-full p-px" style={{ background: "var(--pa)" }}>
              <span className="size-2 rounded-full" style={{ background: "var(--ctp-base)" }} />
            </span>
            <span className="size-1.5 rounded-full" style={{ background: "var(--ctp-green)" }} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Full appearance settings for the Settings page: flavor previews, accent and a live sample. */
export function AppearanceSettings() {
  const { t } = useT()
  const { flavor, accent, setFlavor } = useTheme()
  return (
    <div className="space-y-6">
      <div>
        <p className="mb-3 text-sm font-medium">{t("Theme")}</p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {FLAVORS.map((f) => (
            <button
              key={f}
              onClick={() => setFlavor(f)}
              aria-pressed={flavor === f}
              className={cn(
                "rounded-lg border p-1.5 text-left transition-colors",
                flavor === f ? "border-primary ring-primary/30 ring-2" : "hover:border-foreground/30"
              )}
            >
              <FlavorMock flavor={f} accent={accent} />
              <span className="flex items-center justify-between px-1 pt-2 pb-0.5 text-sm">
                <span className="font-medium">{FLAVOR_NAMES[f]}</span>
                {flavor === f ? <Check className="text-primary size-4" /> : <span className="text-muted-foreground text-xs">{f === "latte" ? t("Light") : t("Dark")}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-3 text-sm font-medium">
          {t("Accent color")} <span className="text-muted-foreground font-normal">· {accentName(accent)}</span>
        </p>
        <AccentSwatches size="lg" />
      </div>

      <div>
        <p className="mb-3 text-sm font-medium">{t("Preview")}</p>
        <div className="bg-background flex flex-wrap items-center gap-3 rounded-lg border p-4">
          <Button size="sm">{t("Save")}</Button>
          <Button size="sm" variant="outline">
            {t("Cancel")}
          </Button>
          <Badge>{t("New")}</Badge>
          <Badge variant="outline">{t("Pending approval")}</Badge>
          <Switch defaultChecked aria-label={t("Preview")} />
          <Checkbox defaultChecked aria-label={t("Preview")} />
          <a href="#" onClick={(e) => e.preventDefault()} className="text-primary text-sm underline-offset-4 hover:underline">
            {t("A link")}
          </a>
          <span className="text-success text-sm font-medium">{t("Available")}</span>
        </div>
      </div>

      <CatppuccinCredit />
    </div>
  )
}
