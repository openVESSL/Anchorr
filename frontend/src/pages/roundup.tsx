import { Send } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { ChannelSelect, Field, PageHeader, SaveBar, Section, SwitchRow, useSettingsForm } from "@/components/settings"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, ApiError } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { useRoles, useStatus } from "@/lib/queries"
import { ColorField } from "@/pages/embeds"

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const NONE = "__none__"

export function RoundupPage() {
  const { t } = useT()
  const botRunning = useStatus().data?.isBotRunning ?? false
  const roles = useRoles(botRunning)
  const form = useSettingsForm({
    WEEKLY_ROUNDUP_ENABLED: "false",
    WEEKLY_ROUNDUP_CHANNEL_ID: "",
    WEEKLY_ROUNDUP_WEEKDAY: "0",
    WEEKLY_ROUNDUP_HOUR: "18",
    WEEKLY_ROUNDUP_ROLE_ID: "",
    WEEKLY_ROUNDUP_EMBED_COLOR: "",
  })

  const [sending, setSending] = useState(false)

  async function test() {
    setSending(true)
    try {
      await api.post("/test-weekly-roundup")
      toast.success(t("Roundup sent"))
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Something went wrong"))
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <PageHeader
        title={t("Weekly roundup")}
        description={t("Once a week, one post with everything added to Jellyfin in the last 7 days, grouped by library.")}
        actions={
          <Button variant="outline" onClick={test} disabled={sending}>
            <Send /> {t("Send one now")}
          </Button>
        }
      />
      <Section title={t("Schedule")}>
        <SwitchRow form={form} name="WEEKLY_ROUNDUP_ENABLED" label={t("Post a weekly roundup")} />
        <ChannelSelect form={form} name="WEEKLY_ROUNDUP_CHANNEL_ID" label={t("Channel")} />
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="roundup-day" label={t("Day")} error={form.errors.WEEKLY_ROUNDUP_WEEKDAY}>
            <Select value={String(form.values.WEEKLY_ROUNDUP_WEEKDAY ?? "0")} onValueChange={(v) => form.set("WEEKLY_ROUNDUP_WEEKDAY", v)}>
              <SelectTrigger id="roundup-day" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKDAYS.map((day, i) => (
                  <SelectItem key={day} value={String(i)}>
                    {t(day)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="roundup-hour" label={t("Hour (server time)")} error={form.errors.WEEKLY_ROUNDUP_HOUR}>
            <Select value={String(form.values.WEEKLY_ROUNDUP_HOUR ?? "18")} onValueChange={(v) => form.set("WEEKLY_ROUNDUP_HOUR", v)}>
              <SelectTrigger id="roundup-hour" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, h) => (
                  <SelectItem key={h} value={String(h)}>
                    {String(h).padStart(2, "0")}:00
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field id="roundup-role" label={t("Mention a role")} help={t("Optional. Pinged on scheduled posts, not on test posts.")} error={form.errors.WEEKLY_ROUNDUP_ROLE_ID}>
          <Select value={String(form.values.WEEKLY_ROUNDUP_ROLE_ID ?? "") || NONE} onValueChange={(v) => form.set("WEEKLY_ROUNDUP_ROLE_ID", v === NONE ? "" : v)} disabled={!roles.data}>
            <SelectTrigger id="roundup-role" className="w-full max-w-md">
              <SelectValue placeholder={botRunning ? undefined : t("Start the bot to list roles")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t("No mention")}</SelectItem>
              {roles.data?.map((role) => (
                <SelectItem key={role.id} value={role.id}>
                  @{role.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <ColorField form={form} name="WEEKLY_ROUNDUP_EMBED_COLOR" label={t("Color")} allowEmpty placeholder="#cba6f7" />
      </Section>
      <SaveBar form={form} />
    </>
  )
}
