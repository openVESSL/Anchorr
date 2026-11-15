import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { PageHeader, Section } from "@/components/settings"
import { useT } from "@/lib/i18n"
import { keys, useConfig } from "@/lib/queries"
import { SeerrStep } from "@/pages/setup"

export function SeerrPage() {
  const { t } = useT()
  const config = useConfig().data
  const client = useQueryClient()
  const url = config?.SEERR_URL as string | undefined
  const guest = config?.SEERR_GUEST_USER_ID as string | undefined

  return (
    <>
      <PageHeader title="Seerr" description={t("Search, details, ratings and requests all go through Seerr.")} />
      {config?.SEERR_API_KEY ? (
        <Section title={t("Connection")}>
          <p className="text-sm font-medium">{url}</p>
          <p className="text-muted-foreground text-sm">
            {guest
              ? t('Discord members without a linked account request as the Seerr user "Discord (Anchorr)" (id {id}). Set its quota and permissions in Seerr.', { id: guest })
              : t('The guest account "Discord (Anchorr)" has not been created yet. Members without a linked account cannot request until it exists.')}
          </p>
        </Section>
      ) : null}
      <SeerrStep
        jellyfinLogin={null}
        onDone={() => {
          toast.success(t("Seerr connected"))
          for (const key of [keys.config, keys.setup, keys.seerrOptions]) client.invalidateQueries({ queryKey: key })
        }}
      />
    </>
  )
}
