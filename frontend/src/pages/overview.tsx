import { useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Play, Square } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"

import { PageHeader } from "@/components/settings"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { api, ApiError } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { keys, useSetupState, useStatus } from "@/lib/queries"
import { cn } from "@/lib/utils"

export function OverviewPage() {
  const { t } = useT()
  const status = useStatus()
  const setup = useSetupState().data
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const s = status.data
  const incomplete = setup && (!setup.jellyfin || !setup.seerr || !setup.discord || !setup.discordServer)

  async function toggleBot() {
    setBusy(true)
    try {
      await api.post(s?.isBotRunning ? "/stop-bot" : "/start-bot")
      toast.success(s?.isBotRunning ? t("Bot stopped") : t("Bot started"))
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Something went wrong"))
    } finally {
      setBusy(false)
      client.invalidateQueries({ queryKey: keys.status })
    }
  }

  return (
    <>
      <PageHeader
        title={t("Overview")}
        actions={
          <Button variant={s?.isBotRunning ? "outline" : "default"} onClick={toggleBot} disabled={busy || !s}>
            {s?.isBotRunning ? <Square /> : <Play />}
            {s?.isBotRunning ? t("Stop bot") : t("Start bot")}
          </Button>
        }
      />

      {incomplete && (
        <Alert className="mb-4">
          <AlertTriangle />
          <AlertTitle>{t("Setup is not finished")}</AlertTitle>
          <AlertDescription>
            <span>
              {t("Some connections are missing.")}{" "}
              <Link to="/setup" className="underline underline-offset-4">
                {t("Continue setup")}
              </Link>
            </span>
          </AlertDescription>
        </Alert>
      )}
      {s?.legacyWebhookLastSeen && (
        <Alert className="mb-4">
          <AlertTriangle />
          <AlertTitle>{t("The Jellyfin Webhook plugin is no longer needed")}</AlertTitle>
          <AlertDescription>{t("Anchorr now watches Jellyfin directly and ignores the plugin's calls. You can remove Anchorr from the plugin's destinations, or uninstall the plugin.")}</AlertDescription>
        </Alert>
      )}
      {s?.proxyWithoutTrust && (
        <Alert className="mb-4">
          <AlertTriangle />
          <AlertTitle>{t("Behind a reverse proxy")}</AlertTitle>
          <AlertDescription>{t("Set the environment variable TRUST_PROXY=true so sign-in cookies are marked secure and rate limits see each visitor.")}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatusCard title={t("Discord bot")} ok={s?.isBotRunning} value={s?.isBotRunning ? (s.botUsername ?? t("Online")) : t("Offline")} />
        <StatusCard title="Jellyfin" ok={s?.jellyfinConnected} value={s?.jellyfinConnected ? t("Watching for new items") : setup?.jellyfin ? t("Not connected") : t("Not set up")} />
        <StatusCard title="Seerr" ok={setup?.seerr} value={setup?.seerr ? t("Connected") : t("Not set up")} />
      </div>

      <p className="text-muted-foreground mt-6 text-sm">
        {s && t("Version {version}, running for {uptime}", { version: s.version, uptime: s.uptimeFormatted })}
      </p>
    </>
  )
}

function StatusCard({ title, ok, value }: { title: string; ok?: boolean; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-2">
        <span className={cn("size-2.5 shrink-0 rounded-full", ok ? "bg-success" : "bg-muted-foreground")} />
        <span className="truncate font-medium">{value}</span>
      </CardContent>
    </Card>
  )
}
