import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { PageHeader, Section } from "@/components/settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n"
import { keys, useConfig, useLibraries, useSetupState, useStatus } from "@/lib/queries"
import { JellyfinStep } from "@/pages/setup"

export function JellyfinPage() {
  const { t } = useT()
  const config = useConfig().data
  const setup = useSetupState().data
  const status = useStatus().data
  const libraries = useLibraries()
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const url = config?.JELLYFIN_BASE_URL as string | undefined
  const connected = Boolean(setup?.jellyfin && url)

  return (
    <>
      <PageHeader title="Jellyfin" description={t("Anchorr watches Jellyfin directly for new items. No plugin or webhook is needed.")} />
      {connected && (
        <Section title={t("Connection")}>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{url}</span>
            <Badge variant="outline">{status?.jellyfinConnected ? t("Watching for new items") : t("Not connected")}</Badge>
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => setEditing(!editing)}>
              {editing ? t("Cancel") : t("Change connection")}
            </Button>
          </div>
          {libraries.data && (
            <p className="text-muted-foreground text-sm">
              {t("Libraries")}: {libraries.data.map((l) => l.name).join(", ")}
            </p>
          )}
        </Section>
      )}
      {(!connected || editing) && (
        <JellyfinStep
          onDone={async () => {
            toast.success(t("Jellyfin connected"))
            await Promise.all([keys.config, keys.setup, keys.status, keys.libraries].map((key) => client.invalidateQueries({ queryKey: key })))
            setEditing(false)
          }}
        />
      )}
    </>
  )
}
