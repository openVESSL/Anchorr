import {
  Bell,
  Bot,
  CalendarDays,
  CheckCircle2,
  Circle,
  Clapperboard,
  Dices,
  Inbox,
  LayoutDashboard,
  Palette,
  ScrollText,
  Send,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react"
import { Link, useLocation } from "react-router"

import { Logo } from "@/components/logo"
import {
  Sidebar,
  SidebarContent,
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
import { useSetupState } from "@/lib/queries"

interface Item {
  to: string
  label: string
  icon: LucideIcon
  done?: boolean
}

export function AppSidebar() {
  const { t } = useT()
  const { pathname } = useLocation()
  const { setOpenMobile } = useSidebar()
  const setup = useSetupState().data

  const groups: { label?: string; items: Item[] }[] = [
    { items: [{ to: "/", label: t("Overview"), icon: LayoutDashboard }] },
    {
      label: t("Connections"),
      items: [
        { to: "/jellyfin", label: "Jellyfin", icon: Clapperboard, done: setup?.jellyfin },
        { to: "/seerr", label: "Seerr", icon: Inbox, done: setup?.seerr },
        { to: "/discord", label: "Discord", icon: Bot, done: setup?.discord && setup?.discordServer },
      ],
    },
    {
      label: t("Bot"),
      items: [
        { to: "/notifications", label: t("Notifications"), icon: Bell },
        { to: "/requests", label: t("Requests"), icon: Send },
        { to: "/users", label: t("Users"), icon: Users },
        { to: "/embeds", label: t("Appearance"), icon: Palette },
        { to: "/daily-pick", label: t("Daily pick"), icon: Dices },
        { to: "/roundup", label: t("Weekly roundup"), icon: CalendarDays },
      ],
    },
    {
      label: t("System"),
      items: [
        { to: "/system", label: t("Settings"), icon: Settings },
        { to: "/logs", label: t("Logs"), icon: ScrollText },
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
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={pathname === item.to}>
                      <Link to={item.to} onClick={() => setOpenMobile(false)}>
                        <item.icon />
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
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  )
}
