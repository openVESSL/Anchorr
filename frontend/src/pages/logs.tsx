import { useQuery } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { useState } from "react"

import { PageHeader } from "@/components/settings"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"

interface LogEntry {
  timestamp: string
  level: string
  message: string
}

const LEVEL_COLOR: Record<string, string> = {
  error: "text-destructive",
  warn: "text-warning",
  info: "text-success",
  debug: "text-muted-foreground",
}

export function LogsPage() {
  const { t } = useT()
  const [which, setWhich] = useState<"error" | "all">("error")
  const logs = useQuery({
    queryKey: ["logs", which],
    queryFn: () => api.get<{ file: string; entries: LogEntry[]; truncated: boolean }>(`/logs/${which}`),
  })
  const entries = [...(logs.data?.entries ?? [])].reverse()

  return (
    <>
      <PageHeader
        title={t("Logs")}
        description={logs.data?.file}
        actions={
          <Button variant="outline" onClick={() => logs.refetch()} disabled={logs.isFetching}>
            <RefreshCw className={cn(logs.isFetching && "animate-spin")} /> {t("Refresh")}
          </Button>
        }
      />
      <Tabs value={which} onValueChange={(v) => setWhich(v as "error" | "all")} className="mb-4">
        <TabsList>
          <TabsTrigger value="error">{t("Errors")}</TabsTrigger>
          <TabsTrigger value="all">{t("Everything")}</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="bg-mantle overflow-x-auto rounded-lg border p-3 font-mono text-xs leading-relaxed">
        {entries.length === 0 && <p className="text-muted-foreground">{t("Nothing logged yet.")}</p>}
        {entries.map((entry, i) => (
          <div key={i} className="whitespace-pre-wrap break-words">
            <span className="text-muted-foreground">{entry.timestamp}</span>{" "}
            <span className={cn("font-semibold uppercase", LEVEL_COLOR[entry.level] ?? "")}>{entry.level}</span> {entry.message}
          </div>
        ))}
      </div>
      {logs.data?.truncated && <p className="text-muted-foreground mt-2 text-xs">{t("Showing the latest 1000 lines.")}</p>}
    </>
  )
}
