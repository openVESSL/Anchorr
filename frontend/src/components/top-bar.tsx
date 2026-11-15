import { useQueryClient } from "@tanstack/react-query"
import { Check, Languages, LogOut, Palette } from "lucide-react"
import { useNavigate } from "react-router"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { api } from "@/lib/api"
import { LANGUAGES, useT } from "@/lib/i18n"
import { useStatus } from "@/lib/queries"
import { ThemePicker } from "@/components/theme-picker"
import { cn } from "@/lib/utils"

export function TopBar() {
  const { t, language, setLanguage } = useT()
  const status = useStatus().data
  const navigate = useNavigate()
  const client = useQueryClient()

  async function logout() {
    await api.post("/auth/logout").catch(() => {})
    client.clear()
    navigate("/login")
  }

  return (
    <header className="bg-background/80 sticky top-0 z-20 flex h-14 items-center gap-2 border-b px-4 backdrop-blur md:px-6">
      <SidebarTrigger />
      <div className="ml-1 flex items-center gap-2">
        <Badge variant="outline" className="gap-1.5 font-normal">
          <span className={cn("size-2 rounded-full", status?.isBotRunning ? "bg-success" : "bg-muted-foreground")} />
          {status?.isBotRunning ? t("Bot online") : t("Bot offline")}
        </Badge>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("Language")}>
              <Languages />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-44 p-1">
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                className="hover:bg-accent flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm"
                onClick={() => setLanguage(lang.code)}
              >
                {lang.name}
                {language === lang.code && <Check className="size-4" />}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("Theme")}>
              <Palette />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <ThemePicker />
          </PopoverContent>
        </Popover>
        <Button variant="ghost" size="icon" onClick={logout} aria-label={t("Sign out")}>
          <LogOut />
        </Button>
      </div>
    </header>
  )
}
