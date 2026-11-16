import { useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, CircleDot, ExternalLink, Info } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { api, ApiError } from "@/lib/api"
import { useT, type Translate } from "@/lib/i18n"
import { keys, type Upgrade, type UpgradeItem } from "@/lib/queries"
import { cn } from "@/lib/utils"

function texts(item: UpgradeItem, t: Translate): { title: string; text: string } {
  switch (item.id) {
    case "jellyfin_linked":
      return {
        title: t("Link Jellyfin with an API key"),
        text:
          item.state === "done"
            ? t("Jellyfin is linked. New items are announced.")
            : t("New items are not announced until Jellyfin is linked. The Webhook plugin is no longer used."),
      }
    case "auto_approve":
      return {
        title: t("Give linked members Auto-Approve in Seerr"),
        text: t("In 1.x, auto-approve applied to everyone. Now it only applies to the guest account; linked members follow their own Seerr permissions."),
      }
    case "guest_limits":
      return {
        title: t("Check the limits of the guest account"),
        text:
          item.state === "todo"
            ? t("The guest account is created when the bot starts. If the bot is running and it is still missing, check the logs.")
            : t('Members without a linked account request as "Discord (Anchorr)" in Seerr. Set its request limits there.'),
      }
    case "time_zone":
      return {
        title: t("Set the time zone"),
        text:
          item.state === "done"
            ? t("Anchorr runs on {zone}.", { zone: item.timeZone ?? "" })
            : t("Anchorr runs on {zone}, so the weekly roundup posts by that clock. Set TZ, for example TZ=Europe/Berlin.", { zone: item.timeZone ?? "" }),
      }
    case "webhook_plugin":
      return {
        title: t("Remove the Jellyfin Webhook plugin"),
        text:
          item.state === "done"
            ? t("No calls from the plugin since Anchorr started.")
            : t("Anchorr watches Jellyfin directly now. Remove Anchorr from the plugin's destinations, or uninstall the plugin."),
      }
    case "backup":
      return {
        title: t("Your 1.x configuration is backed up"),
        text: t("Saved in {path}. To go back: stop Anchorr, copy those files back into the config folder and run version 1.6.5.", { path: item.path ?? "" }),
      }
    case "removed_keys":
      return {
        title: t("TMDB and OMDb keys were removed"),
        text: t("Seerr provides all details now. If you ever shared 1.x log files, rotate the Jellyfin and Seerr API keys."),
      }
  }
}

function StateIcon({ item }: { item: UpgradeItem }) {
  const className = "mt-0.5 size-4 shrink-0"
  if (item.state === "done") return <CheckCircle2 className={cn(className, "text-success")} />
  if (item.state === "info") return <Info className={cn(className, "text-muted-foreground")} />
  if (item.state === "manual") return <CircleDot className={cn(className, "text-warning")} />
  return <AlertTriangle className={cn(className, item.severity === "critical" ? "text-destructive" : "text-warning")} />
}

function Action({ item }: { item: UpgradeItem }) {
  const { t } = useT()
  if (item.id === "jellyfin_linked" && item.state === "todo") {
    return (
      <Link to="/jellyfin" className="text-xs underline underline-offset-4">
        {t("Open Jellyfin settings")}
      </Link>
    )
  }
  if (item.link) {
    return (
      <a href={item.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline underline-offset-4">
        {t("Open in Seerr")}
        <ExternalLink className="size-3" />
      </a>
    )
  }
  return null
}

/** Shown on the Overview after an upgrade from 1.x until the admin dismisses it. */
export function UpgradeCard({ upgrade }: { upgrade: Upgrade }) {
  const { t } = useT()
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const criticalOpen = upgrade.items.some((i) => i.severity === "critical" && i.state === "todo")

  async function dismiss() {
    setBusy(true)
    try {
      await api.post("/upgrade/dismiss")
      await client.invalidateQueries({ queryKey: keys.upgrade })
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Something went wrong"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle>{t("Upgraded from Anchorr 1.x")}</CardTitle>
        <CardDescription>{t("A few things work differently in 2.0. Items tick themselves off once they are done.")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {upgrade.items.map((item) => {
            const { title, text } = texts(item, t)
            const open = item.state === "todo" && item.severity === "critical"
            return (
              <li key={item.id} className={cn("flex gap-3 rounded-md", open && "bg-destructive/10 -mx-2 p-2")}>
                <StateIcon item={item} />
                <div className="min-w-0 space-y-1">
                  <p className={cn("text-sm font-medium", item.state === "done" && "text-muted-foreground")}>{title}</p>
                  <p className="text-muted-foreground text-xs break-words">{text}</p>
                  <Action item={item} />
                </div>
              </li>
            )
          })}
        </ul>
      </CardContent>
      <CardFooter className="justify-end">
        <Button variant={criticalOpen ? "outline" : "default"} onClick={dismiss} disabled={busy}>
          {criticalOpen ? t("Hide anyway") : t("Done")}
        </Button>
      </CardFooter>
    </Card>
  )
}
