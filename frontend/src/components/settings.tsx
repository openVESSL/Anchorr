// Building blocks for the settings pages: a form hook that saves only its own keys and
// shows server validation errors next to the field, plus cards, rows and pickers.
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useLocation } from "react-router"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { ApiError, type Config } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { PAGE_ICONS } from "@/lib/nav"
import { useChannels, useConfig, useSaveConfig } from "@/lib/queries"
import { cn } from "@/lib/utils"

export type FormValues = Record<string, unknown>

/** Form state for a fixed set of config keys, with per-key defaults. */
export function useSettingsForm(defaults: FormValues) {
  const config = useConfig()
  const save = useSaveConfig()
  const { t } = useT()
  const fieldKeys = Object.keys(defaults)
  const saved = useMemo(() => {
    const out: FormValues = {}
    for (const key of fieldKeys) out[key] = config.data?.[key] ?? defaults[key]
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.data])
  const [values, setValues] = useState<FormValues>(saved)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => setValues(saved), [saved])

  const dirty = fieldKeys.some((key) => JSON.stringify(values[key]) !== JSON.stringify(saved[key]))

  return {
    loading: config.isPending,
    config: config.data as Config | undefined,
    values,
    errors,
    dirty,
    saving: save.isPending,
    set: (key: string, value: unknown) => {
      setValues((current) => ({ ...current, [key]: value }))
      setErrors(({ [key]: _, ...rest }) => rest)
    },
    reset: () => {
      setValues(saved)
      setErrors({})
    },
    save: async () => {
      const changed: FormValues = {}
      for (const key of fieldKeys) if (JSON.stringify(values[key]) !== JSON.stringify(saved[key])) changed[key] = values[key]
      try {
        await save.mutateAsync(changed)
        setErrors({})
        toast.success(t("Settings saved"))
      } catch (err) {
        if (err instanceof ApiError && Object.keys(err.fields).length) {
          setErrors(err.fields)
          toast.error(t("Please fix the highlighted fields"))
        } else {
          toast.error(err instanceof Error ? err.message : t("Could not save the settings"))
        }
      }
    },
  }
}

export type SettingsForm = ReturnType<typeof useSettingsForm>

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  const Icon = PAGE_ICONS[useLocation().pathname]
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        {Icon && (
          <span className="bg-primary/15 text-primary grid size-10 shrink-0 place-items-center rounded-lg">
            <Icon className="size-5" />
          </span>
        )}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-muted-foreground mt-1 max-w-2xl text-sm">{description}</p>}
        </div>
      </div>
      {actions}
    </div>
  )
}

export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-primary text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  )
}

/** Label, control, help text and the field's error from the server. */
export function Field({ id, label, help, error, children }: { id: string; label: string; help?: string; error?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p role="alert" className="text-destructive text-sm">{error}</p>
      ) : (
        help && <p className="text-muted-foreground text-sm">{help}</p>
      )}
    </div>
  )
}

/** A setting turned on or off; values are stored as "true"/"false" strings. */
export function SwitchRow({ form, name, label, help }: { form: SettingsForm; name: string; label: string; help?: string }) {
  const id = `field-${name}`
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        {help && <p className="text-muted-foreground text-sm">{help}</p>}
      </div>
      <Switch id={id} checked={form.values[name] === "true"} onCheckedChange={(on) => form.set(name, on ? "true" : "false")} />
    </div>
  )
}

const NONE = "__none__"

/** Picks a channel of the configured Discord server; empty means "not set". */
export function ChannelSelect({ form, name, label, help, allowNone = true }: { form: SettingsForm; name: string; label: string; help?: string; allowNone?: boolean }) {
  const { t } = useT()
  const guildId = form.config?.GUILD_ID as string | undefined
  const channels = useChannels(guildId)
  const value = String(form.values[name] ?? "")
  const id = `field-${name}`

  let placeholder = t("Choose a channel")
  if (!guildId) placeholder = t("Pick a Discord server first")
  else if (channels.isError) placeholder = t("Start the bot to list channels")
  else if (channels.isPending) placeholder = t("Loading channels...")

  return (
    <Field id={id} label={label} help={help} error={form.errors[name]}>
      <Select value={value || NONE} onValueChange={(v) => form.set(name, v === NONE ? "" : v)} disabled={!channels.data}>
        <SelectTrigger id={id} className={cn("w-full max-w-md", form.errors[name] && "border-destructive")}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value={NONE}>{t("Not set")}</SelectItem>}
          {value && !channels.data?.some((c) => c.id === value) && <SelectItem value={value}>{t("Unknown channel ({id})", { id: value })}</SelectItem>}
          {channels.data?.map((channel) => (
            <SelectItem key={channel.id} value={channel.id}>
              # {channel.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

/** Shown while a page has unsaved changes. */
export function SaveBar({ form }: { form: SettingsForm }) {
  const { t } = useT()
  if (!form.dirty) return null
  return (
    <div className="bg-background/90 sticky bottom-0 z-10 -mx-4 mt-6 flex items-center justify-end gap-2 border-t px-4 py-3 backdrop-blur md:-mx-10 md:px-10">
      <span className="text-muted-foreground mr-auto text-sm">{t("You have unsaved changes")}</span>
      <Button variant="ghost" onClick={form.reset} disabled={form.saving}>
        {t("Discard")}
      </Button>
      <Button onClick={form.save} disabled={form.saving}>
        {form.saving ? t("Saving...") : t("Save changes")}
      </Button>
    </div>
  )
}
