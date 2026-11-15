import { CheckCircle2, Circle } from "lucide-react"
import { Link, useLocation } from "react-router"

import { Logo } from "@/components/logo"
import { CatppuccinCredit } from "@/components/theme-picker"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useT } from "@/lib/i18n"
import { PAGE_ICONS } from "@/lib/nav"
import { useSetupState } from "@/lib/queries"

interface Item {
  to: string
  label: string
  done?: boolean
}

export function AppSidebar() {
  const { t } = useT()
  const { pathname } = useLocation()
  const { setOpenMobile } = useSidebar()
  const setup = useSetupState().data

  const groups: { label?: string; items: Item[] }[] = [
    { items: [{ to: "/", label: t("Overview") }] },
    {
      label: t("Connections"),
      items: [
        { to: "/jellyfin", label: "Jellyfin", done: setup?.jellyfin },
        { to: "/seerr", label: "Seerr", done: setup?.seerr },
        { to: "/discord", label: "Discord", done: setup?.discord && setup?.discordServer },
      ],
    },
    {
      label: t("Bot"),
      items: [
        { to: "/notifications", label: t("Notifications") },
        { to: "/requests", label: t("Requests") },
        { to: "/users", label: t("Users") },
        { to: "/embeds", label: t("Appearance") },
        { to: "/daily-pick", label: t("Daily pick") },
        { to: "/roundup", label: t("Weekly roundup") },
      ],
    },
    {
      label: t("System"),
      items: [
        { to: "/system", label: t("Settings") },
        { to: "/logs", label: t("Logs") },
      ],
    },
  ]

  return (
    <Sidebar>
      <SidebarHeader className="px-4 pt-5">
        <Link to="/" className="flex items-center gap-2.5" onClick={() => setOpenMobile(false)}>
          <Logo />
          <span className="text-lg font-semibold tracking-tight">Anchorr</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((group, i) => (
          <SidebarGroup key={i}>
            {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const Icon = PAGE_ICONS[item.to]
                  return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={pathname === item.to}>
                      <Link to={item.to} onClick={() => setOpenMobile(false)}>
                        <Icon />
                        <span>{item.label}</span>
                        {item.done !== undefined &&
                          (item.done ? (
                            <CheckCircle2 className="text-success ml-auto size-4" aria-label={t("Connected")} />
                          ) : (
                            <Circle className="text-muted-foreground ml-auto size-4" aria-label={t("Not connected")} />
                          ))}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="px-4 pb-4">
        <CatppuccinCredit />
      </SidebarFooter>
    </Sidebar>
  )
}
