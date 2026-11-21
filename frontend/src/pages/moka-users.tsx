// With Moka connected, people live in Moka: their Discord link, messages, limits and
// rights for films and shows are set here and saved in Moka.
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { PageHeader, Section } from "@/components/settings"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { api, ApiError } from "@/lib/api"
import { useT } from "@/lib/i18n"

interface Quota {
  limit: number
  days: number
}
interface MokaUser {
  id: number
  username: string
  permissions: number
  discord_id: string | null
  discord_notify: boolean
  movie_quota: Quota | null
  show_quota: Quota | null
}

// Moka's permission bits
const ADMIN = 1
const REQUEST = 4
const AUTO_APPROVE = 8
const REQUEST_MOVIES = 128
const REQUEST_SHOWS = 256
const AUTO_MOVIES = 512
const AUTO_SHOWS = 1024

const has = (p: number, all: number, one: number) => (p & (ADMIN | all)) !== 0 || (p & one) !== 0

type Draft = {
  discord_id: string
  discord_notify: boolean
  request_movies: boolean
  request_shows: boolean
  auto_approve_movies: boolean
  auto_approve_shows: boolean
  movie: { limit: string; days: string }
  show: { limit: string; days: string }
}

const quotaField = (q: Quota | null) => ({ limit: q ? String(q.limit) : "", days: String(q?.days ?? 7) })

function draftOf(u: MokaUser): Draft {
  const p = u.permissions
  return {
    discord_id: u.discord_id ?? "",
    discord_notify: u.discord_notify,
    request_movies: has(p, REQUEST, REQUEST_MOVIES),
    request_shows: has(p, REQUEST, REQUEST_SHOWS),
    auto_approve_movies: has(p, AUTO_APPROVE, AUTO_MOVIES),
    auto_approve_shows: has(p, AUTO_APPROVE, AUTO_SHOWS),
    movie: quotaField(u.movie_quota),
    show: quotaField(u.show_quota),
  }
}

function Limit({ label, value, onChange }: { label: string; value: { limit: string; days: string }; onChange: (v: { limit: string; days: string }) => void }) {
  const { t } = useT()
  const digits = (v: string) => v.replace(/\D/g, "")
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground w-20">{label}</span>
      <Input className="h-8 w-16" inputMode="numeric" placeholder={t("global")} value={value.limit} onChange={(e) => onChange({ ...value, limit: digits(e.target.value) })} aria-label={`${label}: ${t("requests")}`} />
      <span className="text-muted-foreground">{t("every")}</span>
      <Input className="h-8 w-14" inputMode="numeric" value={value.days} onChange={(e) => onChange({ ...value, days: digits(e.target.value) })} aria-label={`${label}: ${t("days")}`} />
      <span className="text-muted-foreground">{t("days")}</span>
    </div>
  )
}

function Person({ user, guest, onSaved }: { user: MokaUser; guest: boolean; onSaved: () => void }) {
  const { t } = useT()
  const [d, setD] = useState(() => draftOf(user))
  const [busy, setBusy] = useState(false)
  useEffect(() => setD(draftOf(user)), [user])
  const admin = (user.permissions & ADMIN) !== 0
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }))
  const quota = (f: { limit: string; days: string }) => ({ limit: Number(f.limit), days: Number(f.days) || 7 })

  async function save() {
    setBusy(true)
    try {
      await api.put(`/moka/users/${user.id}`, {
        ...(guest ? {} : { discord_id: d.discord_id, discord_notify: d.discord_notify }),
        ...(admin
          ? {}
          : { request_movies: d.request_movies, request_shows: d.request_shows, auto_approve_movies: d.auto_approve_movies, auto_approve_shows: d.auto_approve_shows }),
        ...(d.movie.limit === "" ? { clear_movie_quota: true } : { movie_quota: quota(d.movie) }),
        ...(d.show.limit === "" ? { clear_show_quota: true } : { show_quota: quota(d.show) }),
      })
      toast.success(t("Saved in Moka"))
      onSaved()
    } catch (err) {
      toast.error(err instanceof ApiError ? t(err.message) : t("Could not save in Moka"))
    } finally {
      setBusy(false)
    }
  }

  const check = (key: keyof Draft, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={Boolean(d[key])} disabled={admin} onCheckedChange={(v) => set({ [key]: v === true } as Partial<Draft>)} />
      {label}
    </label>
  )

  return (
    <li className="space-y-3 border-b py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{user.username}</span>
        {guest && <span className="text-muted-foreground text-sm">{t("everyone without a linked account")}</span>}
        {admin && <span className="text-muted-foreground text-sm">{t("admin: may request everything")}</span>}
        {!guest && (
          <Input
            className="ml-auto h-8 w-52"
            inputMode="numeric"
            placeholder={t("Discord ID")}
            value={d.discord_id}
            onChange={(e) => set({ discord_id: e.target.value.trim() })}
            aria-label={t("Discord ID")}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {check("request_movies", t("Request films"))}
        {check("auto_approve_movies", t("Auto-approve films"))}
        {check("request_shows", t("Request shows"))}
        {check("auto_approve_shows", t("Auto-approve shows"))}
        {!guest && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={d.discord_notify} onCheckedChange={(v) => set({ discord_notify: v === true })} />
            {t("Discord message when ready")}
          </label>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Limit label={t("Films")} value={d.movie} onChange={(movie) => set({ movie })} />
        <Limit label={t("Shows")} value={d.show} onChange={(show) => set({ show })} />
        <Button size="sm" className="ml-auto" onClick={save} disabled={busy}>
          {busy ? t("Saving...") : t("Save")}
        </Button>
      </div>
    </li>
  )
}

export function MokaUsersPage() {
  const { t } = useT()
  const client = useQueryClient()
  const users = useQuery({ queryKey: ["moka", "users"], queryFn: () => api.get<{ users: MokaUser[]; guestUserId: number | null }>("/moka/users") })
  const data = users.data
  const list = data ? [...data.users].sort((a, b) => Number(b.id === data.guestUserId) - Number(a.id === data.guestUserId)) : []

  return (
    <>
      <PageHeader
        title={t("Users")}
        description={t("People come from Moka. Set each one's Discord ID so they request in their own name, what they may request, their limits and whether the bot messages them. Saved in Moka.")}
      />
      <Section title={t("People in Moka")} description={t("An empty limit uses Moka's global limit; 0 means no limit.")}>
        {users.isError && <p className="text-muted-foreground text-sm">{t("Could not reach Moka.")}</p>}
        <ul>
          {list.map((u) => (
            <Person key={u.id} user={u} guest={u.id === data?.guestUserId} onSaved={() => client.invalidateQueries({ queryKey: ["moka", "users"] })} />
          ))}
        </ul>
      </Section>
    </>
  )
}
