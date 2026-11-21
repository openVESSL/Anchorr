import { Field, PageHeader, SaveBar, Section, SwitchRow, useSettingsForm, type SettingsForm } from "@/components/settings"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useT } from "@/lib/i18n"
import { useRoles, useSeerrOptions, useSetupState, useStatus } from "@/lib/queries"

const KINDS = [
  { key: "MOVIE", label: "Movies", service: "radarr" },
  { key: "TV", label: "Shows", service: "sonarr" },
  { key: "ANIME_MOVIE", label: "Anime movies", service: "radarr" },
  { key: "ANIME", label: "Anime shows", service: "sonarr" },
] as const

export function RequestsPage() {
  const { t } = useT()
  // With Moka, approval and quality are set per user and profile in Moka
  const moka = Boolean(useSetupState().data?.mokaMode)
  const form = useSettingsForm({
    SEERR_AUTO_APPROVE: "false",
    PRIVATE_MESSAGE_MODE: "false",
    ROLE_ALLOWLIST: [],
    ROLE_BLOCKLIST: [],
    ...Object.fromEntries(KINDS.flatMap((k) => [[`DEFAULT_SERVER_${k.key}`, ""], [`DEFAULT_QUALITY_PROFILE_${k.key}`, ""]])),
  })

  return (
    <>
      <PageHeader
        title={t("Requests")}
        description={moka ? t("Who may request from Discord. Approval, limits and quality are set in Moka.") : t("Who may request from Discord, and where requests go in Seerr.")}
      />

      <Section title={t("Approval")}>
        {!moka && (
          <SwitchRow
            form={form}
            name="SEERR_AUTO_APPROVE"
            label={t("Auto-approve requests from members without a linked account")}
            help={t('Sets the auto-approve permission of the Seerr user "Discord (Anchorr)". Linked members always follow their own Seerr permissions and quotas.')}
          />
        )}
        <SwitchRow form={form} name="PRIVATE_MESSAGE_MODE" label={t("Private replies")} help={t("Search and request results are only visible to the member who used the command.")} />
      </Section>

      <RolesSection form={form} />
      {!moka && <DefaultsSection form={form} />}
      <SaveBar form={form} />
    </>
  )
}

function RolesSection({ form }: { form: SettingsForm }) {
  const { t } = useT()
  const botRunning = useStatus().data?.isBotRunning ?? false
  const roles = useRoles(botRunning)
  const lists = [
    { name: "ROLE_ALLOWLIST", label: t("Allowed roles"), help: t("If any are selected, only members with one of these roles can use the bot.") },
    { name: "ROLE_BLOCKLIST", label: t("Blocked roles"), help: t("Members with one of these roles cannot use the bot. Wins over the allowed roles.") },
  ]
  return (
    <Section title={t("Roles")} description={t("With either list set, the bot only answers in your server, not in direct messages.")}>
      {!botRunning && <p className="text-muted-foreground text-sm">{t("Start the bot to list the server's roles.")}</p>}
      {roles.data && (
        <div className="grid gap-6 md:grid-cols-2">
          {lists.map((list) => {
            const selected = (form.values[list.name] as string[]) ?? []
            return (
              <Field key={list.name} id={list.name} label={list.label} help={list.help} error={form.errors[list.name]}>
                <div id={list.name} className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
                  {roles.data.map((role) => (
                    <label key={role.id} className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm">
                      <Checkbox
                        checked={selected.includes(role.id)}
                        onCheckedChange={(on) => form.set(list.name, on ? [...selected, role.id] : selected.filter((id) => id !== role.id))}
                      />
                      <span className="size-2.5 rounded-full" style={{ background: role.color === "#000000" ? "var(--ctp-overlay0)" : role.color }} />
                      {role.name}
                    </label>
                  ))}
                </div>
              </Field>
            )
          })}
        </div>
      )}
    </Section>
  )
}

const NONE = "__none__"

function DefaultsSection({ form }: { form: SettingsForm }) {
  const { t } = useT()
  const seerrUrl = String(form.config?.SEERR_URL ?? "")
  const apiKey = String(form.config?.SEERR_API_KEY ?? "")
  const options = useSeerrOptions(Boolean(seerrUrl && apiKey), seerrUrl, apiKey)

  return (
    <Section title={t("Default server and quality")} description={t("Used when a member does not pick a server or quality in /request. Empty uses Seerr's own default.")}>
      {options.isError && <p className="text-muted-foreground text-sm">{t("Could not load the servers from Seerr.")}</p>}
      <div className="grid gap-5 md:grid-cols-2">
        {KINDS.map((kind) => {
          const servers = options.data?.servers.filter((s) => s.type === kind.service) ?? []
          const serverField = `DEFAULT_SERVER_${kind.key}`
          const profileField = `DEFAULT_QUALITY_PROFILE_${kind.key}`
          const serverValue = String(form.values[serverField] ?? "")
          const chosenServer = serverValue.split("|")[0]
          const profiles = options.data?.profiles.filter((p) => p.type === kind.service && (!chosenServer || String(p.serverId) === chosenServer)) ?? []
          return (
            <div key={kind.key} className="space-y-3 rounded-md border p-3">
              <p className="text-sm font-medium">{t(kind.label)}</p>
              <Select value={serverValue || NONE} onValueChange={(v) => form.set(serverField, v === NONE ? "" : v)}>
                <SelectTrigger className="w-full" aria-label={t("Server for {kind}", { kind: t(kind.label) })}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("Seerr default server")}</SelectItem>
                  {servers.map((s) => (
                    <SelectItem key={s.id} value={`${s.id}|${s.type}`}>
                      {s.name}
                      {s.isDefault ? ` (${t("default")})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={String(form.values[profileField] ?? "") || NONE} onValueChange={(v) => form.set(profileField, v === NONE ? "" : v)}>
                <SelectTrigger className="w-full" aria-label={t("Quality for {kind}", { kind: t(kind.label) })}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("Seerr default quality")}</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem key={`${p.id}-${p.serverId}`} value={`${p.id}|${p.serverId}`}>
                      {p.name} ({p.serverName})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        })}
      </div>
    </Section>
  )
}
