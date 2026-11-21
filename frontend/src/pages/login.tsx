import { useQueryClient } from "@tanstack/react-query"
import { useState, type FormEvent } from "react"
import { Navigate, useNavigate, useSearchParams } from "react-router"

import { Logo } from "@/components/logo"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, ApiError } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { keys, useAuth } from "@/lib/queries"

type Method = "jellyfin" | "moka" | "local"

export function LoginPage() {
  const { t } = useT()
  const auth = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const client = useQueryClient()
  const [method, setMethod] = useState<Method | null>(null)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  if (auth.isPending) return null
  if (auth.data?.needsSetup) return <Navigate to="/setup" replace />
  if (auth.data?.isAuthenticated) return <Navigate to={params.get("next") || "/"} replace />

  // every way to sign in this install offers, the first one shown by default
  const methods: Method[] = [
    ...(auth.data?.jellyfinLogin ? (["jellyfin"] as const) : []),
    ...(auth.data?.mokaLogin ? (["moka"] as const) : []),
    ...(auth.data?.hasUsers || !(auth.data?.jellyfinLogin || auth.data?.mokaLogin) ? (["local"] as const) : []),
  ]
  const active = method ?? methods[0]
  const others = methods.filter((m) => m !== active)
  const descriptions: Record<Method, string> = {
    jellyfin: t("Use your Jellyfin administrator account."),
    moka: t("Use your Moka administrator account."),
    local: t("Use your Anchorr account."),
  }
  const switchLabels: Record<Method, string> = {
    jellyfin: t("Use a Jellyfin account instead"),
    moka: t("Use a Moka account instead"),
    local: t("Use the Anchorr account instead"),
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError("")
    try {
      await api.post({ jellyfin: "/auth/jellyfin", moka: "/auth/moka", local: "/auth/login" }[active], { username, password })
      await client.invalidateQueries({ queryKey: keys.auth })
      const next = params.get("next")
      navigate(next && next.startsWith("/") ? next : "/", { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? t(err.message) : t("Could not sign in"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center text-center">
          <Logo className="mb-2 size-12" />
          <CardTitle className="text-xl">{t("Sign in to Anchorr")}</CardTitle>
          <CardDescription>{descriptions[active]}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="username">{t("Username")}</Label>
              <Input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t("Password")}</Label>
              <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? t("Signing in...") : t("Sign in")}
            </Button>
            {others.map((m) => (
              <button
                key={m}
                type="button"
                className="text-muted-foreground hover:text-foreground w-full text-center text-sm underline-offset-4 hover:underline"
                onClick={() => {
                  setMethod(m)
                  setError("")
                }}
              >
                {switchLabels[m]}
              </button>
            ))}
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
