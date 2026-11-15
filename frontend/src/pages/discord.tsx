import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { PageHeader, Section } from "@/components/settings"
import { useT } from "@/lib/i18n"
import { keys, useDiscordSetup } from "@/lib/queries"
import { DiscordStep } from "@/pages/setup"

export function DiscordPage() {
  const { t } = useT()
  const discord = useDiscordSetup()
  const client = useQueryClient()
  const data = discord.data
  const current = data?.guilds?.find((g) => g.id === data.guildId)

  return (
    <>
      <PageHeader title="Discord" description={t("The bot, the server it works in, and its invite link.")} />
      {data?.configured && (
        <Section title={data.botName ?? t("Bot")}>
          <p className="text-sm">
            {current ? t("Working in {server}.", { server: current.name }) : t("No server chosen yet.")}{" "}
            {data.botRunning ? t("The bot is online.") : t("The bot is offline.")}
          </p>
        </Section>
      )}
      {!discord.isPending && (
        <DiscordStep
          key={data?.configured ? "configured" : "new"}
          initial={data?.configured ? data : null}
          onDone={() => {
            toast.success(t("Discord server saved"))
            for (const key of [keys.discord, keys.setup, keys.status, keys.config]) client.invalidateQueries({ queryKey: key })
          }}
        />
      )}
    </>
  )
}
