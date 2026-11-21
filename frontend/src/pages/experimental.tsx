import { PageHeader, SaveBar, Section, SwitchRow, useSettingsForm } from "@/components/settings"
import { useT } from "@/lib/i18n"

/** Options that are still being tried out; off by default. */
export function ExperimentalPage() {
  const { t } = useT()
  const form = useSettingsForm({ EXPERIMENTAL_MOKA: "false" })
  return (
    <>
      <PageHeader title={t("Experimental")} description={t("Features that are still being tried out. They are off until you turn them on.")} />
      <Section title="Moka">
        <SwitchRow
          form={form}
          name="EXPERIMENTAL_MOKA"
          label={t("Use Moka")}
          help={t("Adds Moka to Connections, next to Jellyfin and Seerr. Nothing changes until you connect it there.")}
        />
      </Section>
      <SaveBar form={form} />
    </>
  )
}
