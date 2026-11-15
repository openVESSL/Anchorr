// First-run wizard: Jellyfin, then Seerr, then Discord. Required steps only; everything
// optional lives in the dashboard afterwards.
import { useQueryClient } from "@tanstack/react-query"
import { Check, ExternalLink, RefreshCw } from "lucide-react"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { Link, Navigate } from "react-router"

import { Logo } from "@/components/logo"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, ApiError, type DiscordSetup } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { keys, useAuth, useSetupState } from "@/lib/queries"
import { cn } from "@/lib/utils"

type Step = "jellyfin" | "seerr" | "discord" | "done"
const STEPS: Step[] = ["jellyfin", "seerr", "discord", "done"]

export function SetupPage() {
  const { t } = useT()
  const auth = useAuth()
  const state = useSetupState()
  const client = useQueryClient()
  const [step, setStep] = useState<Step | null>(null)
  // Kept only in this page's memory so the Seerr step can reuse the Jellyfin sign-in
  const [jellyfinLogin, setJellyfinLogin] = useState<{ username: string; password: string } | null>(null)

  useEffect(() => {
    if (step || !state.data) return
    if (!state.data.jellyfin) setStep("jellyfin")
    else if (!state.data.seerr) setStep("seerr")
    else if (!state.data.discord || !state.data.discordServer) setStep("discord")
    else setStep("done")
  }, [state.data, step])

  if (auth.isPending || state.isPending) return null
  if (!auth.data?.needsSetup && !auth.data?.isAuthenticated) return <Navigate to="/login?next=/setup" replace />

  const refresh = () => {
    client.invalidateQueries({ queryKey: keys.auth })
    client.invalidateQueries({ queryKey: keys.setup })
  }
  const labels: Record<Step, string> = { jellyfin: "Jellyfin", seerr: "Seerr", discord: "Discord", done: t("Done") }

  return (
    <div className="mx-auto flex min-h-svh max-w-xl flex-col px-4 py-10">
      <div className="mb-8 flex items-center gap-3">
        <Logo className="size-10" />
        <div>
          <h1 className="text-xl font-semibold">{t("Set up Anchorr")}</h1>
          <p className="text-muted-foreground text-sm">{t("Three connections and you are done. Everything else is optional.")}</p>
        </div>
      </div>

      <ol className="mb-6 flex gap-2" aria-label={t("Setup steps")}>
        {STEPS.map((s, i) => {
          const current = s === step
          const past = step ? STEPS.indexOf(step) > i : false
          return (
            <li key={s} className="flex flex-1 flex-col gap-1.5" aria-current={current ? "step" : undefined}>
              <span className={cn("h-1 rounded-full", past || current ? "bg-primary" : "bg-muted")} />
              <span className={cn("text-xs", current ? "text-foreground font-medium" : "text-muted-foreground")}>
                {i + 1}. {labels[s]}
              </span>
            </li>
          )
        })}
      </ol>

      {step === "jellyfin" && (
        <JellyfinStep
          onDone={(login) => {
            setJellyfinLogin(login)
            refresh()
            setStep("seerr")
          }}
        />
      )}
      {step === "seerr" && (
        <SeerrStep
          jellyfinLogin={jellyfinLogin}
          onBack={() => setStep("jellyfin")}
          onDone={() => {
            refresh()
            setStep("discord")
          }}
        />
      )}
      {step === "discord" && (
        <DiscordStep
          onBack={() => setStep("seerr")}
          onDone={() => {
            refresh()
            setStep("done")
          }}
        />
      )}
      {step === "done" && <DoneStep />}
    </div>
  )
}

function StepCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card className="border-t-primary border-t-2">
      <CardHeader>
        <CardTitle className="text-primary">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function ErrorAlert({ message }: { message: string }) {
  if (!message) return null
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function useSubmit() {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setBusy(true)
    setError("")
    try {
      return await action()
    } catch (err) {
      setError(err instanceof ApiError ? t(err.message) : t("Something went wrong"))
      return undefined
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

export function JellyfinStep({ onDone }: { onDone: (login: { username: string; password: string } | null) => void }) {
  const { t } = useT()
  const [url, setUrl] = useState("")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [withKey, setWithKey] = useState(false)
  const { busy, error, run } = useSubmit()

  async function submit(e: FormEvent) {
    e.preventDefault()
    const result = await run(() => api.post("/setup/jellyfin", withKey ? { url, apiKey } : { url, username, password }))
    if (result) onDone(withKey ? null : { username, password })
  }

  return (
    <StepCard
      title={t("Connect Jellyfin")}
      description={t("Sign in with a Jellyfin administrator account. Anchorr creates its own API key; your password is not stored.")}
    >
      <form onSubmit={submit} className="space-y-4">
        <ErrorAlert message={error} />
        <div className="space-y-2">
          <Label htmlFor="jf-url">{t("Jellyfin address")}</Label>
          <Input id="jf-url" type="url" placeholder="http://192.168.1.10:8096" value={url} onChange={(e) => setUrl(e.target.value)} required autoFocus />
          <p className="text-muted-foreground text-sm">{t("The address Anchorr uses to reach Jellyfin, for example its LAN address.")}</p>
        </div>
        {withKey ? (
          <div className="space-y-2">
            <Label htmlFor="jf-key">{t("API key")}</Label>
            <Input id="jf-key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
            <p className="text-muted-foreground text-sm">{t("Jellyfin: Dashboard > API Keys > +.")}</p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="jf-user">{t("Username")}</Label>
              <Input id="jf-user" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="jf-pass">{t("Password")}</Label>
              <Input id="jf-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline" onClick={() => setWithKey(!withKey)}>
            {withKey ? t("Sign in instead") : t("Use an API key instead")}
          </button>
          <Button type="submit" disabled={busy}>
            {busy ? t("Connecting...") : t("Connect")}
          </Button>
        </div>
      </form>
    </StepCard>
  )
}

export function SeerrStep({ jellyfinLogin, onBack, onDone }: { jellyfinLogin: { username: string; password: string } | null; onBack?: () => void; onDone: () => void }) {
  const { t } = useT()
  const [url, setUrl] = useState("")
  const [mode, setMode] = useState<"same" | "other" | "key">(jellyfinLogin ? "same" : "other")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [apiKey, setApiKey] = useState("")
  const { busy, error, run } = useSubmit()

  async function submit(e: FormEvent) {
    e.preventDefault()
    const body =
      mode === "key"
        ? { url, apiKey }
        : mode === "same" && jellyfinLogin
          ? { url, ...jellyfinLogin }
          : { url, username, password }
    const result = await run(() => api.post("/setup/seerr", body))
    if (result) onDone()
  }

  return (
    <StepCard
      title={t("Connect Seerr")}
      description={t("Anchorr reads Seerr's API key by signing in with the Jellyfin account you use in Seerr. Search, details and requests then all go through Seerr.")}
    >
      <form onSubmit={submit} className="space-y-4">
        <ErrorAlert message={error} />
        <div className="space-y-2">
          <Label htmlFor="seerr-url">{t("Seerr address")}</Label>
          <Input id="seerr-url" type="url" placeholder="http://192.168.1.10:5055" value={url} onChange={(e) => setUrl(e.target.value)} required autoFocus />
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">{t("How should Anchorr sign in to Seerr?")}</legend>
          {jellyfinLogin && <Choice checked={mode === "same"} onChange={() => setMode("same")} label={t("With the same Jellyfin account ({name})", { name: jellyfinLogin.username })} />}
          <Choice checked={mode === "other"} onChange={() => setMode("other")} label={t("With another Jellyfin account")} />
          <Choice checked={mode === "key"} onChange={() => setMode("key")} label={t("With Seerr's API key")} />
        </fieldset>
        {mode === "other" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="seerr-user">{t("Username")}</Label>
              <Input id="seerr-user" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="seerr-pass">{t("Password")}</Label>
              <Input id="seerr-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </>
        )}
        {mode === "key" && (
          <div className="space-y-2">
            <Label htmlFor="seerr-key">{t("API key")}</Label>
            <Input id="seerr-key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
            <p className="text-muted-foreground text-sm">{t("Seerr: Settings > General > API Key.")}</p>
          </div>
        )}
        <div className="flex justify-between gap-2">
          {onBack ? (
            <Button type="button" variant="ghost" onClick={onBack}>
              {t("Back")}
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" disabled={busy}>
            {busy ? t("Connecting...") : t("Connect")}
          </Button>
        </div>
      </form>
    </StepCard>
  )
}

function Choice({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className={cn("flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm", checked && "border-primary bg-primary/5")}>
      <input type="radio" className="accent-[var(--ctp-accent)]" checked={checked} onChange={onChange} />
      {label}
    </label>
  )
}

export function DiscordStep({ onBack, onDone, initial = null }: { onBack?: () => void; onDone: (result: { unchanged?: boolean }) => void; initial?: DiscordSetup | null }) {
  const { t } = useT()
  const [token, setToken] = useState("")
  const [bot, setBot] = useState<DiscordSetup | null>(initial)
  const [picking, setPicking] = useState<string | null>(null)
  const { busy, error, run } = useSubmit()

  async function submitToken(e: FormEvent) {
    e.preventDefault()
    const result = await run(() => api.post<DiscordSetup>("/setup/discord", { token }))
    if (result) setBot({ ...result, configured: true })
  }
  async function refreshServers() {
    const result = await run(() => api.get<DiscordSetup>("/setup/discord?refresh=1"))
    if (result) setBot(result)
  }
  async function pickServer(guildId: string) {
    setPicking(guildId)
    const result = await run(() => api.post<{ unchanged?: boolean }>("/setup/discord/server", { guildId }))
    setPicking(null)
    if (result) {
      setBot((current) => (current ? { ...current, guildId, botRunning: true } : current))
      onDone(result)
    }
  }

  if (!bot) {
    return (
      <StepCard title={t("Connect Discord")} description={t("Create a bot for your server and paste its token.")}>
        <ol className="text-muted-foreground mb-5 list-decimal space-y-1.5 pl-5 text-sm">
          <li>
            {t("Open the")}{" "}
            <a className="text-foreground inline-flex items-center gap-1 underline underline-offset-4" href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">
              Discord Developer Portal <ExternalLink className="size-3" />
            </a>{" "}
            {t("and create a New Application.")}
          </li>
          <li>{t("Under Bot, select Reset Token and copy the token.")}</li>
          <li>{t("Under Bot, turn on Server Members Intent (used to link Discord users to Seerr).")}</li>
        </ol>
        <form onSubmit={submitToken} className="space-y-4">
          <ErrorAlert message={error} />
          <div className="space-y-2">
            <Label htmlFor="dc-token">{t("Bot token")}</Label>
            <Input id="dc-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required autoFocus />
          </div>
          <div className="flex justify-between gap-2">
            {onBack ? (
              <Button type="button" variant="ghost" onClick={onBack}>
                {t("Back")}
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={busy}>
              {busy ? t("Checking...") : t("Continue")}
            </Button>
          </div>
        </form>
      </StepCard>
    )
  }

  return (
    <StepCard title={t("Add {name} to your server", { name: bot.botName ?? "Anchorr" })} description={t("Invite the bot, then pick the server it should work in.")}>
      <div className="space-y-4">
        <ErrorAlert message={error} />
        {bot.membersIntent === false && (
          <Alert>
            <AlertDescription>{t("Server Members Intent is off. Turn it on under Bot in the Developer Portal so Anchorr can list your members for user linking.")}</AlertDescription>
          </Alert>
        )}
        <Button asChild className="w-full">
          <a href={bot.inviteUrl} target="_blank" rel="noreferrer">
            {t("Invite the bot")} <ExternalLink />
          </a>
        </Button>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">{t("Servers the bot has joined")}</p>
            <Button variant="ghost" size="sm" onClick={refreshServers} disabled={busy}>
              <RefreshCw /> {t("Refresh")}
            </Button>
          </div>
          {bot.guilds?.length ? (
            <div className="space-y-2">
              {bot.guilds.map((guild) => {
                const current = guild.id === bot.guildId
                return (
                  <button
                    key={guild.id}
                    disabled={busy}
                    onClick={() => pickServer(guild.id)}
                    aria-current={current || undefined}
                    className={cn(
                      "hover:border-primary flex w-full items-center justify-between rounded-md border px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-60",
                      current && "border-primary bg-primary/5"
                    )}
                  >
                    {guild.name}
                    <span className="text-muted-foreground text-xs">
                      {picking === guild.id ? t("Starting the bot...") : current ? t("Current server") : t("Use this server")}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">{t("No servers yet. Invite the bot, then select Refresh.")}</p>
          )}
        </div>
        <div className="flex justify-between gap-2">
          {onBack ? (
            <Button variant="ghost" onClick={onBack}>
              {t("Back")}
            </Button>
          ) : (
            <span />
          )}
          <Button variant="ghost" onClick={() => setBot(null)} disabled={busy}>
            {t("Use a different bot token")}
          </Button>
        </div>
      </div>
    </StepCard>
  )
}

function DoneStep() {
  const { t } = useT()
  const optional = [
    { to: "/notifications", label: t("Choose where new movies and episodes are announced") },
    { to: "/users", label: t("Link Discord members to their Seerr accounts") },
    { to: "/requests", label: t("Decide who may request and what is auto-approved") },
    { to: "/system", label: t("Add a local sign-in, pick the bot language and theme") },
  ]
  return (
    <StepCard title={t("You are set")} description={t("The bot is online. /search, /request and /trending work in your server, and new items in Jellyfin are announced.")}>
      <p className="mb-3 text-sm font-medium">{t("Optional next steps")}</p>
      <ul className="mb-6 space-y-2">
        {optional.map((item) => (
          <li key={item.to}>
            <Link to={item.to} className="hover:border-primary flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <Check className="text-muted-foreground size-4" /> {item.label}
            </Link>
          </li>
        ))}
      </ul>
      <Button asChild className="w-full">
        <Link to="/">{t("Open the dashboard")}</Link>
      </Button>
    </StepCard>
  )
}
