// Linking Discord members to Seerr accounts. Linked members request as themselves;
// everyone else requests as the guest account.
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Trash2, Wand2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Combobox } from "@/components/combobox"
import { PageHeader, Section } from "@/components/settings"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { api, ApiError } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { useStatus } from "@/lib/queries"

interface Mapping {
  discordUserId: string
  seerrUserId: string | number
  discordUsername?: string | null
  discordDisplayName?: string | null
  seerrDisplayName?: string | null
}
interface Member {
  id: string
  username: string
  displayName: string
  avatar?: string
}
interface SeerrUser {
  id: number
  displayName: string
  email?: string
  avatar?: string | null
}
interface Candidate {
  seerrUserId: number
  seerrDisplayName: string
  discordId: string
  discordDisplayName?: string
}

export function UsersPage() {
  const { t } = useT()
  const client = useQueryClient()
  const botRunning = useStatus().data?.isBotRunning ?? false
  const mappings = useQuery({ queryKey: ["mappings"], queryFn: () => api.get<Mapping[]>("/user-mappings") })
  const members = useQuery({ queryKey: ["members"], enabled: botRunning, queryFn: async () => (await api.get<{ members: Member[]; warning?: string }>("/discord-members")) })
  const seerrUsers = useQuery({ queryKey: ["seerr-users"], queryFn: async () => (await api.get<{ users: SeerrUser[] }>("/seerr-users")).users })
  const [discordId, setDiscordId] = useState("")
  const [seerrId, setSeerrId] = useState("")
  const [autoMap, setAutoMap] = useState<Candidate[] | null>(null)

  const refresh = () => client.invalidateQueries({ queryKey: ["mappings"] })
  const fail = (err: unknown) => toast.error(err instanceof ApiError ? err.message : t("Something went wrong"))

  async function add() {
    const member = members.data?.members.find((m) => m.id === discordId)
    const user = seerrUsers.data?.find((u) => String(u.id) === seerrId)
    try {
      await api.post("/user-mappings", {
        discordUserId: discordId,
        seerrUserId: seerrId,
        discordUsername: member?.username ?? null,
        discordDisplayName: member?.displayName ?? null,
        seerrDisplayName: user?.displayName ?? null,
      })
      toast.success(t("Link saved"))
      setDiscordId("")
      setSeerrId("")
      refresh()
    } catch (err) {
      fail(err)
    }
  }

  async function remove(id: string) {
    try {
      await api.delete(`/user-mappings/${id}`)
      refresh()
    } catch (err) {
      fail(err)
    }
  }

  async function openAutoMap() {
    try {
      const data = await api.get<{ candidates: Candidate[] }>("/seerr/auto-map-preview")
      if (!data.candidates.length) toast.info(t("Every Seerr user with a Discord ID is already linked"))
      else setAutoMap(data.candidates)
    } catch (err) {
      fail(err)
    }
  }

  return (
    <>
      <PageHeader
        title={t("Users")}
        description={t('Link Discord members to their Seerr accounts so requests count against their own quota and permissions. Members without a link request as "Discord (Anchorr)".')}
        actions={
          <Button variant="outline" onClick={openAutoMap}>
            <Wand2 /> {t("Link from Seerr profiles")}
          </Button>
        }
      />

      <Section title={t("Add a link")}>
        {!botRunning && <p className="text-muted-foreground text-sm">{t("Start the bot to list your Discord members.")}</p>}
        {seerrUsers.isError && <p className="text-muted-foreground text-sm">{t("Could not reach Seerr.")}</p>}
        {members.data?.warning && <p className="text-warning text-sm">{t("Turn on Server Members Intent in the Discord Developer Portal to see every member.")}</p>}
        <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <div className="space-y-2">
            <Label htmlFor="pick-discord">{t("Discord member")}</Label>
            <Combobox
              id="pick-discord"
              value={discordId}
              onChange={setDiscordId}
              disabled={!members.data}
              placeholder={t("Choose a member")}
              searchPlaceholder={t("Search members...")}
              emptyText={t("No member found")}
              options={(members.data?.members ?? []).map((m) => ({ value: m.id, label: m.displayName, hint: `@${m.username}`, image: m.avatar }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pick-seerr">{t("Seerr user")}</Label>
            <Combobox
              id="pick-seerr"
              value={seerrId}
              onChange={setSeerrId}
              disabled={!seerrUsers.data}
              placeholder={t("Choose a Seerr user")}
              searchPlaceholder={t("Search Seerr users...")}
              emptyText={t("No user found")}
              options={(seerrUsers.data ?? []).map((u) => ({ value: String(u.id), label: u.displayName, hint: u.email, image: u.avatar }))}
            />
          </div>
          <Button onClick={add} disabled={!discordId || !seerrId}>
            {t("Link")}
          </Button>
        </div>
      </Section>

      <Section title={t("Linked members")}>
        {mappings.data?.length ? (
          <ul className="divide-y rounded-md border">
            {mappings.data.map((m) => (
              <li key={m.discordUserId} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="flex-1 truncate">
                  <span className="font-medium">{m.discordDisplayName || m.discordUsername || m.discordUserId}</span>
                  <span className="text-muted-foreground"> → </span>
                  {m.seerrDisplayName || t("Seerr user {id}", { id: m.seerrUserId })}
                </span>
                <Button variant="ghost" size="icon" onClick={() => remove(m.discordUserId)} aria-label={t("Remove link")}>
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">{t("No linked members yet.")}</p>
        )}
      </Section>

      {autoMap && <AutoMapDialog candidates={autoMap} onClose={() => setAutoMap(null)} onDone={refresh} />}
    </>
  )
}

function AutoMapDialog({ candidates, onClose, onDone }: { candidates: Candidate[]; onClose: () => void; onDone: () => void }) {
  const { t } = useT()
  const [chosen, setChosen] = useState(() => new Set(candidates.map((c) => c.discordId)))
  async function apply() {
    try {
      const result = await api.post<{ saved: number }>("/user-mappings/auto-map", { mappings: candidates.filter((c) => chosen.has(c.discordId)) })
      toast.success(t("{count} members linked", { count: result.saved }))
      onDone()
      onClose()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Something went wrong"))
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Link from Seerr profiles")}</DialogTitle>
          <DialogDescription>{t("These Seerr users have a Discord ID in their notification settings.")}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {candidates.map((c) => (
            <li key={c.discordId}>
              <label className="hover:bg-accent flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm">
                <Checkbox
                  checked={chosen.has(c.discordId)}
                  onCheckedChange={(on) => {
                    const next = new Set(chosen)
                    if (on) next.add(c.discordId)
                    else next.delete(c.discordId)
                    setChosen(next)
                  }}
                />
                <span className="font-medium">{c.discordDisplayName ?? c.discordId}</span>
                <span className="text-muted-foreground">→ {c.seerrDisplayName}</span>
              </label>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button onClick={apply} disabled={!chosen.size}>
            {t("Link {count}", { count: chosen.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
