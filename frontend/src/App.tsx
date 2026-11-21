import { Navigate, Outlet, Route, Routes, useLocation } from "react-router"

import { AppSidebar } from "@/components/app-sidebar"
import { Logo } from "@/components/logo"
import { TopBar } from "@/components/top-bar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { useAuth } from "@/lib/queries"
import { DailyPickPage } from "@/pages/daily-pick"
import { DiscordPage } from "@/pages/discord"
import { ExperimentalPage } from "@/pages/experimental"
import { EmbedsPage } from "@/pages/embeds"
import { JellyfinPage } from "@/pages/jellyfin"
import { LoginPage } from "@/pages/login"
import { LogsPage } from "@/pages/logs"
import { MokaPage } from "@/pages/moka"
import { NotificationsPage } from "@/pages/notifications"
import { OverviewPage } from "@/pages/overview"
import { RequestsPage } from "@/pages/requests"
import { RoundupPage } from "@/pages/roundup"
import { SeerrPage } from "@/pages/seerr"
import { SetupPage } from "@/pages/setup"
import { SystemPage } from "@/pages/system"
import { UsersPage } from "@/pages/users"

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route element={<RequireLogin />}>
        <Route element={<DashboardLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="discord" element={<DiscordPage />} />
          <Route path="jellyfin" element={<JellyfinPage />} />
          <Route path="seerr" element={<SeerrPage />} />
          <Route path="moka" element={<MokaPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="requests" element={<RequestsPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="embeds" element={<EmbedsPage />} />
          <Route path="daily-pick" element={<DailyPickPage />} />
          <Route path="roundup" element={<RoundupPage />} />
          <Route path="system" element={<SystemPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="experimental" element={<ExperimentalPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}

function RequireLogin() {
  const auth = useAuth()
  const location = useLocation()
  if (auth.isPending) {
    return (
      <div className="grid min-h-svh place-items-center">
        <Logo className="size-14 animate-pulse" />
      </div>
    )
  }
  if (auth.data?.needsSetup) return <Navigate to="/setup" replace />
  if (!auth.data?.isAuthenticated) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />
  }
  return <Outlet />
}

function DashboardLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <TopBar />
        <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-10 md:py-8">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
