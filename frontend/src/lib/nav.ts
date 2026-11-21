import {
  Bell,
  Bot,
  CalendarDays,
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

/** One icon per dashboard page, shared by the sidebar and the page headers. */
export const PAGE_ICONS: Record<string, LucideIcon> = {
  "/": LayoutDashboard,
  "/jellyfin": Clapperboard,
  "/seerr": Inbox,
  "/discord": Bot,
  "/notifications": Bell,
  "/requests": Send,
  "/users": Users,
  "/embeds": Palette,
  "/daily-pick": Dices,
  "/roundup": CalendarDays,
  "/system": Settings,
  "/logs": ScrollText,
}
