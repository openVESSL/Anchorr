import { FlaskConical } from "lucide-react"
import { toast } from "sonner"

import { ChannelSelect, Field, PageHeader, SaveBar, Section, SwitchRow, useSettingsForm, type SettingsForm } from "@/components/settings"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { api, ApiError } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { useChannels, useLibraries } from "@/lib/queries"

type LibraryMap = Record<string, string | { channel?: string; isAnime?: boolean }>

export function NotificationsPage() {
  const { t } = useT()
  const form = useSettingsForm({
    JELLYFIN_CHANNEL_ID: "",
    JELLYFIN_NOTIFY_MOVIES: "true",
    JELLYFIN_NOTIFY_SERIES: "true",
    JELLYFIN_NOTIFY_SEASONS: "false",
    JELLYFIN_NOTIFY_EPISODES: "false",
    JELLYFIN_SEASON_CHANNEL_ID: "",
    JELLYFIN_EPISODE_CHANNEL_ID: "",
    WEBHOOK_DEBOUNCE_MS: "15000",
    NOTIFY_ON_AVAILABLE: "false",
    NOTIFY_TAG_REQUESTERS: "false",
    JELLYFIN_NOTIFICATION_LIBRARIES: {},
  })
  const seconds = Math.round(Number(form.values.WEBHOOK_DEBOUNCE_MS || 15000) / 1000)

  return (
    <>
      <PageHeader title={t("Notifications")} description={t("What Anchorr announces when something new arrives in Jellyfin, and where.")} actions={<TestMenu />} />

      <Section title={t("Channel")}>
        <ChannelSelect form={form} name="JELLYFIN_CHANNEL_ID" label={t("Announcement channel")} help={t("Used for everything unless a library or type below has its own channel.")} />
      </Section>

      <Section title={t("What to announce")}>
        <SwitchRow form={form} name="JELLYFIN_NOTIFY_MOVIES" label={t("New movies")} />
        <SwitchRow form={form} name="JELLYFIN_NOTIFY_SERIES" label={t("New shows")} />
        <SwitchRow form={form} name="JELLYFIN_NOTIFY_SEASONS" label={t("New seasons")} />
        {form.values.JELLYFIN_NOTIFY_SEASONS === "true" && (
          <ChannelSelect form={form} name="JELLYFIN_SEASON_CHANNEL_ID" label={t("Season channel")} help={t("Optional. Empty uses the library or announcement channel.")} />
        )}
        <SwitchRow form={form} name="JELLYFIN_NOTIFY_EPISODES" label={t("New episodes")} help={t("Episodes of one show that arrive together are grouped into one message.")} />
        {form.values.JELLYFIN_NOTIFY_EPISODES === "true" && (
          <ChannelSelect form={form} name="JELLYFIN_EPISODE_CHANNEL_ID" label={t("Episode channel")} help={t("Optional. Empty uses the library or announcement channel.")} />
        )}
        <Field id="debounce" label={t("Grouping window (seconds)")} help={t("How long to wait for more episodes before posting. 1 to 600 seconds.")} error={form.errors.WEBHOOK_DEBOUNCE_MS}>
          <Input
            id="debounce"
            type="number"
            min={1}
            max={600}
            className="w-32"
            value={seconds}
            onChange={(e) => form.set("WEBHOOK_DEBOUNCE_MS", String(Math.min(600, Math.max(1, Number(e.target.value) || 1)) * 1000))}
          />
        </Field>
      </Section>

      <Section title={t("Requesters")}>
        <SwitchRow
          form={form}
          name="NOTIFY_ON_AVAILABLE"
          label={t("Message the requester when it is available")}
          help={t("Sends a direct message to whoever requested it, from Discord or in Seerr with a linked account, even if the channel announcement is off.")}
        />
        <SwitchRow
          form={form}
          name="NOTIFY_TAG_REQUESTERS"
          label={t("Mention the requester in the announcement")}
          help={t("Tags whoever requested it, from Discord or in Seerr with a linked account, so everyone in the channel sees who asked for it.")}
        />
      </Section>

      <LibrariesSection form={form} />
      <SaveBar form={form} />
    </>
  )
}

function LibrariesSection({ form }: { form: SettingsForm }) {
  const { t } = useT()
  const libraries = useLibraries()
  const channels = useChannels(form.config?.GUILD_ID as string | undefined)
  const map = (form.values.JELLYFIN_NOTIFICATION_LIBRARIES ?? {}) as LibraryMap
  const entry = (id: string) => {
    const value = map[id]
    return typeof value === "object" && value !== null ? value : { channel: (value as string) ?? "" }
  }
  const update = (next: LibraryMap) => form.set("JELLYFIN_NOTIFICATION_LIBRARIES", next)
  const selected = Object.keys(map)

  return (
    <Section title={t("Libraries")} description={t("Choose which libraries are announced. Each can post to its own channel and be marked as anime (anime uses its own default quality profile).")}>
      {libraries.isError && <p className="text-muted-foreground text-sm">{t("Could not load the Jellyfin libraries.")}</p>}
      <div className="divide-y rounded-md border">
        {libraries.data?.map((lib) => {
          const on = lib.id in map
          const { channel = "", isAnime = false } = entry(lib.id)
          return (
            <div key={lib.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <Checkbox
                id={`lib-${lib.id}`}
                checked={on}
                onCheckedChange={(checked) => {
                  const { [lib.id]: _, ...rest } = map
                  update(checked ? { ...map, [lib.id]: { channel: "", isAnime: false } } : rest)
                }}
              />
              <label htmlFor={`lib-${lib.id}`} className="min-w-32 flex-1 text-sm font-medium">
                {lib.name}
              </label>
              {on && (
                <>
                  <Select value={channel || "__default__"} onValueChange={(v) => update({ ...map, [lib.id]: { channel: v === "__default__" ? "" : v, isAnime } })}>
                    <SelectTrigger className="w-52" aria-label={t("Channel for {library}", { library: lib.name })}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">{t("Announcement channel")}</SelectItem>
                      {channels.data?.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          # {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={isAnime} onCheckedChange={(v) => update({ ...map, [lib.id]: { channel, isAnime: v } })} />
                    {t("Anime")}
                  </label>
                </>
              )}
            </div>
          )
        })}
      </div>
      {selected.length === 0 && <p className="text-muted-foreground text-sm">{t("No library selected: every library is announced in the announcement channel.")}</p>}
    </Section>
  )
}

function TestMenu() {
  const { t } = useT()
  const send = async (type: string) => {
    try {
      await api.post("/test-notification", { type })
      toast.success(t("Test notification sent"))
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Something went wrong"))
    }
  }
  return (
    <Select value="" onValueChange={send}>
      <SelectTrigger className="w-48" aria-label={t("Send a test notification")}>
        <FlaskConical className="size-4" />
        <SelectValue placeholder={t("Send a test")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="movie">{t("Movie")}</SelectItem>
        <SelectItem value="series">{t("Show")}</SelectItem>
        <SelectItem value="season">{t("Season")}</SelectItem>
        <SelectItem value="batch-seasons">{t("Several seasons")}</SelectItem>
        <SelectItem value="episodes">{t("Episode")}</SelectItem>
        <SelectItem value="batch-episodes">{t("Several episodes")}</SelectItem>
      </SelectContent>
    </Select>
  )
}

