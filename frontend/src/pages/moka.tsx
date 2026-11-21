// Moka (experimental): a short explanation, then connecting by signing in as a Moka admin.
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, type FormEvent } from "react"
import { Link } from "react-router"
import { toast } from "sonner"

import { PageHeader, Section } from "@/components/settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, ApiError } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { keys, useOverview } from "@/lib/queries"
import { MokaLink } from "@/pages/experimental"
import { ErrorAlert, StepCard, useSubmit } from "@/pages/setup"

interface MokaState {
  enabled: boolean
  connected: boolean
  url: string | null
  publicUrl: string | null
  announcesFrom: "moka" | "jellyfin" | null
}

/** Connects Moka by signing in as a Moka admin; Moka creates the bot's own account. */
function MokaStep({ onDone }: { onDone: () => void }) {
  const { t } = useT()
  const [url, setUrl] = useState("")
  const [publicUrl, setPublicUrl] = useState("")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const { busy, error, run } = useSubmit()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (await run(() => api.post("/moka/connect", { url, publicUrl, username, password }))) onDone()
  }

  return (
    <StepCard
      title={t("Connect Moka")}
      description={t("Sign in with a Moka administrator account. Moka creates the bot's own account; your password is not stored. Search and requests then go through Moka.")}
    >
      <form onSubmit={submit} className="space-y-4">
        <ErrorAlert message={error} />
        <div className="space-y-2">
          <Label htmlFor="moka-url">{t("Moka address")}</Label>
          <Input id="moka-url" type="url" placeholder="http://192.168.1.10:8484" value={url} onChange={(e) => setUrl(e.target.value)} required autoFocus />
          <p className="text-muted-foreground text-sm">{t("The address Anchorr uses to reach Moka, for example its LAN address.")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="moka-public">{t("Public address (optional)")}</Label>
          <Input id="moka-public" type="url" placeholder="https://moka.example.com" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} />
          <p className="text-muted-foreground text-sm">{t("Used for links in Discord. Leave it empty to keep the one set in Moka.")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="moka-user">{t("Username")}</Label>
          <Input id="moka-user" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="moka-pass">{t("Password")}</Label>
          <Input id="moka-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <div className="flex justify-end">
          <Button type="submit" disabled={busy}>
            {busy ? t("Connecting...") : t("Connect")}
          </Button>
        </div>
      </form>
    </StepCard>
  )
}

/** What Moka is, and how Anchorr works with it. */
function HowItWorks() {
  const { t } = useT()
  return (
    <>
    <Section title={t("What Moka is")}>
      <p className="text-muted-foreground text-sm">
        {t("Moka is a self-hosted media server. It brings what usually takes several apps into one: a catalog of films and shows to browse and request, searching your indexers and downloading through your own download client, importing into your library, and playing in the browser or in apps made for Jellyfin. It is still in development.")}{" "}
        <MokaLink />
      </p>
    </Section>
    <Section title={t("How it works with Anchorr")}>
      <ul className="text-muted-foreground list-disc space-y-1.5 pl-5 text-sm">
        <li>{t("Once Anchorr is connected to Moka, search and requests from Discord go to Moka, and Seerr is not used while Moka stays connected.")}</li>
        <li>{t("Jellyfin keeps announcing new titles if it is linked; without it, Moka announces them. Disconnect Moka to go back to Seerr.")}</li>
        <li>{t("Members link their Discord account by their Discord ID on their Moka user and request in their own name, with their own limits. Everyone else requests as Moka's guest account.")}</li>
      </ul>
    </Section>
    </>
  )
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
      <PageHeader title="Moka" description={t("Experimental. Use Moka for search and requests from Discord.")} />
      <HowItWorks />
      {data && !data.enabled && (
        <Section title={t("Turned off")}>
          <p className="text-muted-foreground text-sm">
            {t("Moka is turned off.")}{" "}
            <Link to="/experimental" className="underline underline-offset-4">
              {t("Turn it on under Experimental")}
            </Link>
          </p>
        </Section>
      )}
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
        </Section>
      )}
      {data?.enabled && (!data.connected || editing) && (
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
