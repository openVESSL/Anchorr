import { Field, PageHeader, SaveBar, Section, SwitchRow, useSettingsForm, type SettingsForm } from "@/components/settings"
import { Input } from "@/components/ui/input"
import { useT } from "@/lib/i18n"

const CONTENT = [
  { key: "BACKDROP", label: "Backdrop image" },
  { key: "OVERVIEW_MOVIES", label: "Summary for movies and shows" },
  { key: "OVERVIEW_EPISODES", label: "Summary for seasons and episodes" },
  { key: "GENRE", label: "Genre" },
  { key: "RUNTIME", label: "Runtime" },
  { key: "RATING", label: "Rating" },
]
const BUTTONS = [
  { key: "BUTTON_LETTERBOXD", label: "Letterboxd" },
  { key: "BUTTON_IMDB", label: "IMDb" },
  { key: "BUTTON_WATCH", label: "Watch on Jellyfin" },
]
const COLORS = [
  { key: "MOVIE", label: "New movie", value: "#cba6f7" },
  { key: "SERIES", label: "New show", value: "#cba6f7" },
  { key: "SEASON", label: "New season", value: "#89b4fa" },
  { key: "EPISODE_SINGLE", label: "One episode", value: "#89b4fa" },
  { key: "EPISODE_FEW", label: "A few episodes", value: "#89b4fa" },
  { key: "EPISODE_MANY", label: "Many episodes", value: "#89b4fa" },
  { key: "SEARCH", label: "Search result", value: "#fab387" },
  { key: "SUCCESS", label: "Request sent / now available", value: "#a6e3a1" },
]

export function EmbedsPage() {
  const { t } = useT()
  const form = useSettingsForm({
    ...Object.fromEntries([...CONTENT, ...BUTTONS].map((f) => [`EMBED_SHOW_${f.key}`, "true"])),
    ...Object.fromEntries(COLORS.map((c) => [`EMBED_COLOR_${c.key}`, c.value])),
  })
  return (
    <>
      <PageHeader title={t("Appearance")} description={t("What the bot's Discord messages show, and their colors.")} />
      <Section title={t("Content")}>
        {CONTENT.map((f) => (
          <SwitchRow key={f.key} form={form} name={`EMBED_SHOW_${f.key}`} label={t(f.label)} />
        ))}
      </Section>
      <Section title={t("Buttons")}>
        {BUTTONS.map((f) => (
          <SwitchRow key={f.key} form={form} name={`EMBED_SHOW_${f.key}`} label={t(f.label)} />
        ))}
      </Section>
      <Section title={t("Colors")}>
        <div className="grid gap-5 sm:grid-cols-2">
          {COLORS.map((c) => (
            <ColorField key={c.key} form={form} name={`EMBED_COLOR_${c.key}`} label={t(c.label)} />
          ))}
        </div>
      </Section>
      <SaveBar form={form} />
    </>
  )
}

const HEX = /^#?[0-9a-f]{6}$/i

/** Native color picker plus a hex field (no third-party script). */
export function ColorField({ form, name, label, allowEmpty = false, placeholder }: { form: SettingsForm; name: string; label: string; allowEmpty?: boolean; placeholder?: string }) {
  const value = String(form.values[name] ?? "")
  const normalized = HEX.test(value) ? (value.startsWith("#") ? value : `#${value}`) : placeholder || "#cba6f7"
  return (
    <Field id={`field-${name}`} label={label} error={form.errors[name]}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={label}
          value={normalized}
          onChange={(e) => form.set(name, e.target.value)}
          className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
        />
        <Input
          id={`field-${name}`}
          className="w-32 font-mono"
          value={value}
          placeholder={allowEmpty ? placeholder : undefined}
          onChange={(e) => form.set(name, e.target.value.trim())}
          aria-invalid={Boolean(value) && !HEX.test(value)}
        />
      </div>
    </Field>
  )
}
