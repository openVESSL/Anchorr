import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { PageHeader, Section } from "@/components/settings"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n"
import { keys, useConfig, useLibraries, useStatus } from "@/lib/queries"
import { JellyfinStep } from "@/pages/setup"

export function JellyfinPage() {
  const { t } = useT()
  const config = useConfig().data
  const status = useStatus().data
  const libraries = useLibraries()
  const client = useQueryClient()
  const url = config?.JELLYFIN_BASE_URL as string | undefined

  return (
    <>
      <PageHeader title="Jellyfin" description={t("Anchorr watches Jellyfin directly for new items. No plugin or webhook is needed.")} />
      {url && (
        <Section title={t("Connection")}>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{url}</span>
            <Badge variant="outline">{status?.jellyfinConnected ? t("Watching for new items") : t("Not connected")}</Badge>
          </div>
          {libraries.data && (
            <p className="text-muted-foreground text-sm">
              {t("Libraries")}: {libraries.data.map((l) => l.name).join(", ")}
            </p>
          )}
        </Section>
      )}
      <JellyfinStep
        onDone={() => {
          toast.success(t("Jellyfin connected"))
          for (const key of [keys.config, keys.setup, keys.status, keys.libraries]) client.invalidateQueries({ queryKey: key })
        }}
      />
    </>
  )
}
