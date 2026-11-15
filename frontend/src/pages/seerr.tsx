import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { PageHeader, Section } from "@/components/settings"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n"
import { keys, useConfig, useSetupState } from "@/lib/queries"
import { SeerrStep } from "@/pages/setup"

export function SeerrPage() {
  const { t } = useT()
  const config = useConfig().data
  const setup = useSetupState().data
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const url = config?.SEERR_URL as string | undefined
  const guest = config?.SEERR_GUEST_USER_ID as string | undefined
  const connected = Boolean(setup?.seerr && config?.SEERR_API_KEY)

  return (
    <>
      <PageHeader title="Seerr" description={t("Search, details, ratings and requests all go through Seerr.")} />
      {connected && (
        <Section title={t("Connection")}>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{url}</span>
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => setEditing(!editing)}>
              {editing ? t("Cancel") : t("Change connection")}
            </Button>
          </div>
          <p className="text-muted-foreground text-sm">
            {guest
              ? t('Discord members without a linked account request as the Seerr user "Discord (Anchorr)" (id {id}). Set its quota and permissions in Seerr.', { id: guest })
              : t('The guest account "Discord (Anchorr)" has not been created yet. Members without a linked account cannot request until it exists.')}
          </p>
        </Section>
      )}
      {(!connected || editing) && (
        <SeerrStep
          jellyfinLogin={null}
          onDone={async () => {
            toast.success(t("Seerr connected"))
            await Promise.all([keys.config, keys.setup, keys.seerrOptions].map((key) => client.invalidateQueries({ queryKey: key })))
            setEditing(false)
          }}
        />
      )}
    </>
  )
}
