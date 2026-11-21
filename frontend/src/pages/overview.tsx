import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Check, ExternalLink, Play, Square, X } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Link } from "react-router"
import { toast } from "sonner"

import { PageHeader } from "@/components/settings"
import { UpgradeCard } from "@/components/upgrade-card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { api, ApiError } from "@/lib/api"
import { useT, type Translate } from "@/lib/i18n"
import { keys, useOverview, useSetupState, useStatus, useUpgrade, type ActivityType, type Overview } from "@/lib/queries"
import { cn } from "@/lib/utils"


interface SeerrRequest {
  id: number
  type: "movie" | "tv"
  status: number // 1 pending, 2 approved, 3 declined, 4 failed, 5 completed
  mediaStatus: number | null // 4 partly available, 5 available
  is4k: boolean
  createdAt: string
  tmdbId: number | null
  title: string | null
  year: string | null
  poster: string | null
  seasons: number[]
  requestedBy: { name: string | null; avatar: string | null }
}

export function OverviewPage() {
  const { t } = useT()
  const status = useStatus()
  const setup = useSetupState().data
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const s = status.data
  const mokaMode = Boolean(setup?.mokaMode)
  const incomplete = setup && (mokaMode ? !setup.moka : !setup.jellyfin || !setup.seerr || !setup.discord || !setup.discordServer)
  const overview = useOverview()
  const o = overview.data
  const upgradeQuery = useUpgrade()
  const upgrade = upgradeQuery.data

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
      client.invalidateQueries({ queryKey: keys.overview })
    }
  }

  const discord = o?.discord
  const jellyfin = o?.jellyfin
  const seerr = o?.seerr
  const moka = o?.moka

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
      {upgrade?.show && <UpgradeCard upgrade={upgrade} />}
      {upgradeQuery.isError && !upgrade && (
        <Alert className="mb-4">
          <AlertTriangle />
          <AlertTitle>{t("Could not load the upgrade checklist")}</AlertTitle>
          <AlertDescription>{upgradeQuery.error instanceof ApiError ? upgradeQuery.error.message : t("Something went wrong")}</AlertDescription>
        </Alert>
      )}
      {/* the upgrade checklist already lists the Webhook plugin; wait for it to avoid a flash */}
      {s?.legacyWebhookLastSeen && !upgradeQuery.isPending && !upgrade?.show && (
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

      <div className="grid gap-4 md:grid-cols-3">
        <StatusCard
          title={t("Discord bot")}
          ok={s?.isBotRunning}
          image={discord?.serverIcon ?? discord?.botAvatar}
          value={s?.isBotRunning ? (discord?.serverName ?? s.botUsername ?? t("Online")) : t("Offline")}
          lines={
            discord
              ? [discord.botTag, [discord.memberCount != null && t("{count} members", { count: discord.memberCount }), discord.ping != null && `${discord.ping} ms`].filter(Boolean).join(" · ")]
              : []
          }
        />
        {mokaMode ? (
          <div className="md:col-span-2">
            <StatusCard
              title="Moka"
              ok={Boolean(moka?.paired)}
              value={moka ? (moka.paired ? t("Connected") : t("Waiting for Moka")) : t("Not reachable")}
              lines={[moka?.version && t("Version {version}", { version: moka.version }), t("Library, requests and linked people come from Moka.")]}
              link={moka?.url}
            />
          </div>
        ) : (
          <>
        <StatusCard
          title="Jellyfin"
          ok={s?.jellyfinConnected}
          value={jellyfin?.serverName ?? (s?.jellyfinConnected ? t("Connected") : setup?.jellyfin ? t("Not connected") : t("Not set up"))}
          lines={[
            jellyfin?.version && t("Version {version}", { version: jellyfin.version }),
            s?.jellyfinConnected ? t("Watching for new items") : setup?.jellyfin && t("Not watching for new items"),
          ]}
          link={jellyfin?.url}
        />
        <StatusCard
          title="Seerr"
          ok={Boolean(seerr)}
          value={seerr ? t("Connected") : setup?.seerr ? t("Not reachable") : t("Not set up")}
          lines={[seerr?.version && t("Version {version}", { version: seerr.version })]}
          link={seerr?.url}
        />
          </>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label={t("Pending requests")} value={o?.requestCounts?.pending} loading={overview.isPending} />
        <Stat label={mokaMode ? t("Requests in Moka") : t("Requests in Seerr")} value={o?.requestCounts?.total} loading={overview.isPending} />
        <Stat label={t("Notifications, last 7 days")} value={o ? (o.activity.week.notification ?? 0) : undefined} loading={overview.isPending} />
        <Stat label={t("Discord requests, last 7 days")} value={o ? (o.activity.week.request ?? 0) : undefined} loading={overview.isPending} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          {(setup?.seerr || setup?.moka) && <RecentRequests seerrUrl={mokaMode ? moka?.url : seerr?.url} moka={mokaMode} />}
        </div>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("Recent activity")}</CardTitle>
          </CardHeader>
          <CardContent>
            {overview.isPending ? (
              <ListSkeleton />
            ) : !o?.activity.recent.length ? (
              <p className="text-muted-foreground text-sm">{t("Nothing yet. Notifications, requests, daily picks and roundups show up here.")}</p>
            ) : (
              <ul className="divide-y">
                {o.activity.recent.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="flex items-baseline justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{activityTitle(e, t)}</p>
                      <p className="text-muted-foreground truncate text-xs">{[activityLabel(e.type, t), e.user].filter(Boolean).join(" · ")}</p>
                    </div>
                    <RelativeTime at={e.at} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-muted-foreground mt-6 text-sm">
        {s && t("Version {version}, running for {uptime}", { version: s.version, uptime: s.uptimeFormatted })}
      </p>
    </>
  )
}

function activityLabel(type: ActivityType, t: Translate) {
  return { notification: t("New in Jellyfin"), request: t("Requested from Discord"), "daily-pick": t("Daily pick"), roundup: t("Weekly roundup") }[type] ?? type
}

function activityTitle(e: Overview["activity"]["recent"][number], t: Translate) {
  if (e.type === "roundup") return t("{count} new titles", { count: e.detail ?? 0 })
  return e.title ?? t("Untitled")
}

function RecentRequests({ seerrUrl, moka = false }: { seerrUrl?: string; moka?: boolean }) {
  const { t } = useT()
  const client = useQueryClient()
  const [pending, setPending] = useState<number | null>(null)
  const requests = useQuery({
    queryKey: keys.recentRequests,
    queryFn: () => api.get<{ results: SeerrRequest[]; total: number }>("/requests/recent?take=10"),
    refetchInterval: 30_000,
  })

  async function act(r: SeerrRequest, action: "approve" | "decline") {
    setPending(r.id)
    try {
      await api.post(`/requests/${r.id}/${action}`)
      toast.success(action === "approve" ? t("Request approved") : t("Request declined"))
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Something went wrong"))
    } finally {
      setPending(null)
      client.invalidateQueries({ queryKey: keys.recentRequests })
      client.invalidateQueries({ queryKey: keys.overview })
    }
  }

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t("Recent requests")}</CardTitle>
      </CardHeader>
      <CardContent>
        {requests.isPending ? (
          <ListSkeleton />
        ) : requests.isError ? (
          <p className="text-muted-foreground text-sm">{requests.error instanceof ApiError ? requests.error.message : t("Could not reach Seerr.")}</p>
        ) : !requests.data.results.length ? (
          <p className="text-muted-foreground text-sm">{t("No requests yet.")}</p>
        ) : (
          <ul className="divide-y">
            {requests.data.results.map((r) => {
              const state = requestState(r, t)
              // Moka's show pages live under /show
              const path = moka && r.type === "tv" ? "show" : r.type
              const href = seerrUrl && r.tmdbId ? `${seerrUrl}/${path}/${r.tmdbId}` : undefined
              return (
                <li key={r.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  {r.poster ? (
                    <img src={r.poster} alt="" loading="lazy" className="h-16 w-11 shrink-0 rounded object-cover" />
                  ) : (
                    <div className="bg-muted h-16 w-11 shrink-0 rounded" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer" className="hover:underline underline-offset-4">
                          {r.title ?? t("Unknown title")}
                        </a>
                      ) : (
                        (r.title ?? t("Unknown title"))
                      )}
                      {r.year && <span className="text-muted-foreground font-normal"> ({r.year})</span>}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {[
                        r.type === "movie" ? t("Movie") : r.seasons.length ? t("Seasons {list}", { list: r.seasons.join(", ") }) : t("Show"),
                        r.is4k && "4K",
                        r.requestedBy.name,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <p className="mt-1 flex items-center gap-2 text-xs">
                      <span className={cn("font-medium", state.className)}>{state.label}</span>
                      <RelativeTime at={Date.parse(r.createdAt)} />
                    </p>
                  </div>
                  {r.status === 1 && (
                    <div className="flex shrink-0 gap-1.5">
                      <Button size="sm" onClick={() => act(r, "approve")} disabled={pending === r.id}>
                        <Check />
                        <span className="sr-only sm:not-sr-only">{t("Approve")}</span>
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => act(r, "decline")} disabled={pending === r.id}>
                        <X />
                        <span className="sr-only sm:not-sr-only">{t("Decline")}</span>
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function requestState(r: SeerrRequest, t: Translate) {
  if (r.status === 1) return { label: t("Pending approval"), className: "text-warning" }
  if (r.status === 3) return { label: t("Declined"), className: "text-destructive" }
  if (r.status === 4) return { label: t("Failed"), className: "text-destructive" }
  if (r.mediaStatus === 5) return { label: t("Available"), className: "text-success" }
  if (r.mediaStatus === 4) return { label: t("Partially available"), className: "text-success" }
  return { label: t("Processing"), className: "text-primary" }
}

function RelativeTime({ at }: { at: number }) {
  const { language } = useT()
  if (!Number.isFinite(at)) return null
  const seconds = Math.round((at - Date.now()) / 1000)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ]
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? ["second", 1]
  const text = new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(Math.round(seconds / size), unit)
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString(language)} className="text-muted-foreground shrink-0 text-xs">
      {text}
    </time>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  )
}

function Stat({ label, value, loading }: { label: string; value?: number; loading: boolean }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="px-4">
        <p className="text-muted-foreground text-xs">{label}</p>
        {loading ? <Skeleton className="mt-1 h-7 w-12" /> : <p className="text-2xl font-semibold tabular-nums">{value ?? "–"}</p>}
      </CardContent>
    </Card>
  )
}

function StatusCard({ title, ok, value, image, lines = [], link }: { title: string; ok?: boolean; value: string; image?: string | null; lines?: (ReactNode | false | null | undefined)[]; link?: string }) {
  const { t } = useT()
  const shown = lines.filter(Boolean)
  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-muted-foreground text-sm font-medium">{title}</CardTitle>
        {link && (
          <a href={link} target="_blank" rel="noreferrer" aria-label={t("Open {name}", { name: title })} className="text-muted-foreground hover:text-foreground">
            <ExternalLink className="size-4" />
          </a>
        )}
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="flex items-center gap-2">
          {image ? <img src={image} alt="" className="size-6 shrink-0 rounded-full" /> : null}
          <span className={cn("size-2.5 shrink-0 rounded-full", ok ? "bg-success" : "bg-muted-foreground")} />
          <span className="truncate font-medium">{value}</span>
        </div>
        {shown.map((line, i) => (
          <p key={i} className="text-muted-foreground truncate text-xs">
            {line}
          </p>
        ))}
      </CardContent>
    </Card>
  )
}
