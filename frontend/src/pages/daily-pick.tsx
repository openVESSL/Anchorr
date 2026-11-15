import { Send } from "lucide-react"
import { toast } from "sonner"

import { ChannelSelect, Field, PageHeader, SaveBar, Section, SwitchRow, useSettingsForm } from "@/components/settings"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api, ApiError } from "@/lib/api"
import { useT } from "@/lib/i18n"

export function DailyPickPage() {
  const { t } = useT()
  const form = useSettingsForm({ DAILY_RANDOM_PICK_ENABLED: "false", DAILY_RANDOM_PICK_CHANNEL_ID: "", DAILY_RANDOM_PICK_INTERVAL: "1440" })

  async function test() {
    try {
      await api.post("/test-random-pick")
      toast.success(t("Random pick sent"))
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Something went wrong"))
    }
  }

  return (
    <>
      <PageHeader
        title={t("Daily pick")}
        description={t("Posts a random movie or show from Seerr (trending, upcoming, a genre mix or a hidden gem) with a Request button.")}
        actions={
          <Button variant="outline" onClick={test}>
            <Send /> {t("Send one now")}
          </Button>
        }
      />
      <Section title={t("Schedule")}>
        <SwitchRow form={form} name="DAILY_RANDOM_PICK_ENABLED" label={t("Post a random pick")} />
        <ChannelSelect form={form} name="DAILY_RANDOM_PICK_CHANNEL_ID" label={t("Channel")} />
        <Field id="pick-interval" label={t("Every (minutes)")} help={t("1440 minutes is once a day.")} error={form.errors.DAILY_RANDOM_PICK_INTERVAL}>
          <Input
            id="pick-interval"
            type="number"
            min={1}
            className="w-32"
            value={String(form.values.DAILY_RANDOM_PICK_INTERVAL ?? "")}
            onChange={(e) => form.set("DAILY_RANDOM_PICK_INTERVAL", e.target.value)}
          />
        </Field>
      </Section>
      <SaveBar form={form} />
    </>
  )
}
