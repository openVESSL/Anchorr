import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { Field, PageHeader, SaveBar, Section, SwitchRow, useSettingsForm } from "@/components/settings"
import { ThemePicker } from "@/components/theme-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, ApiError } from "@/lib/api"
import { LANGUAGES, useT, type Language } from "@/lib/i18n"
import { keys, useSetupState } from "@/lib/queries"

export function SystemPage() {
  const { t, language, setLanguage } = useT()
  const form = useSettingsForm({ LANGUAGE: "en", AUTO_START_BOT: "true", DEBUG: "false" })
  const botLanguages = useQuery({ queryKey: ["languages"], queryFn: () => api.get<{ code: string; name: string }[]>("/languages") })

  return (
    <>
      <PageHeader title={t("Settings")} description={t("Dashboard look, languages and sign-in.")} />

      <Section title={t("Dashboard")} description={t("Saved in this browser.")}>
        <ThemePicker />
        <Field id="ui-language" label={t("Dashboard language")}>
          <Select value={language} onValueChange={(v) => setLanguage(v as Language)}>
            <SelectTrigger id="ui-language" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </Section>

      <Section title={t("Bot")}>
        <Field id="bot-language" label={t("Bot language")} help={t("Language of the bot's messages in Discord.")} error={form.errors.LANGUAGE}>
          <Select value={String(form.values.LANGUAGE ?? "en")} onValueChange={(v) => form.set("LANGUAGE", v)}>
            <SelectTrigger id="bot-language" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(botLanguages.data ?? [{ code: "en", name: "English" }]).map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <SwitchRow form={form} name="AUTO_START_BOT" label={t("Start the bot with Anchorr")} />
        <SwitchRow form={form} name="DEBUG" label={t("Detailed logs")} help={t("Writes debug messages to the logs. Turn it off again when done.")} />
      </Section>

      <LocalAccountSection />
      <SaveBar form={form} />
    </>
  )
}

function LocalAccountSection() {
  const { t } = useT()
  const setup = useSetupState().data
  const client = useQueryClient()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await api.post("/auth/register", { username, password })
      toast.success(t("Local sign-in added"))
      client.invalidateQueries({ queryKey: keys.setup })
      client.invalidateQueries({ queryKey: keys.auth })
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Something went wrong"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title={t("Local sign-in")}
      description={t("Administrators sign in with their Jellyfin account. A local account lets you in even when Jellyfin is down.")}
    >
      {setup?.localAccount ? (
        <p className="text-sm">{t("A local account exists.")}</p>
      ) : (
        <form onSubmit={create} className="grid max-w-md gap-4">
          <div className="space-y-2">
            <Label htmlFor="local-user">{t("Username")}</Label>
            <Input id="local-user" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="local-pass">{t("Password")}</Label>
            <Input id="local-pass" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <Button type="submit" disabled={busy} className="justify-self-start">
            {t("Add local sign-in")}
          </Button>
        </form>
      )}
    </Section>
  )
}
