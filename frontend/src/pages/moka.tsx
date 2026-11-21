import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { PageHeader, Section } from "@/components/settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { api, ApiError } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { keys, useOverview } from "@/lib/queries"
import { MokaStep } from "@/pages/setup"

interface MokaState {
  connected: boolean
  url: string | null
  publicUrl: string | null
  announcesFrom: "moka" | "jellyfin" | null
}

export function MokaPage() {
  const { t } = useT()
  const client = useQueryClient()
  const moka = useQuery({ queryKey: ["moka"], queryFn: () => api.get<MokaState>("/moka") })
  const overview = useOverview().data
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const data = moka.data

  const refresh = () =>
    Promise.all([["moka"], keys.config, keys.setup, keys.auth, keys.overview].map((key) => client.invalidateQueries({ queryKey: key })))

  async function disconnect() {
    setBusy(true)
    try {
      await api.delete("/moka/connect")
      toast.success(t("Moka disconnected"))
      await refresh()
    } catch (err) {
      toast.error(err instanceof ApiError ? t(err.message) : t("Something went wrong"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Moka"
        description={t("Use Moka for search and requests instead of Seerr. New titles are announced from Jellyfin when it is linked, otherwise from Moka.")}
      />
      {data?.connected && (
        <Section title={t("Connection")}>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{data.url}</span>
            <Badge variant="outline">{overview?.moka ? t("Connected") : t("Not reachable")}</Badge>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(!editing)}>
                {editing ? t("Cancel") : t("Change connection")}
              </Button>
              <Button variant="outline" size="sm" onClick={disconnect} disabled={busy}>
                {t("Disconnect")}
              </Button>
            </div>
          </div>
          <p className="text-muted-foreground text-sm">
            {data.announcesFrom === "jellyfin"
              ? t("New titles are announced from Jellyfin, with its watch links. Requests go to Moka.")
              : t("New titles are announced from Moka. Link Jellyfin too if people watch there.")}
          </p>
          <p className="text-muted-foreground text-sm">
            {t("Members request in their own name once their Discord ID is set on their Moka user (Moka > Users). Everyone else requests as Moka's guest account.")}
          </p>
        </Section>
      )}
      {(!data?.connected || editing) && (
        <MokaStep
          onDone={async () => {
            toast.success(t("Moka connected"))
            await refresh()
            setEditing(false)
          }}
        />
      )}
    </>
  )
}
