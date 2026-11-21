import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import {
  api,
  type AuthCheck,
  type Channel,
  type Config,
  type DiscordSetup,
  type Library,
  type Role,
  type SetupState,
  type Status,
} from "@/lib/api"

export const keys = {
  auth: ["auth"] as const,
  setup: ["setup"] as const,
  status: ["status"] as const,
  config: ["config"] as const,
  discord: ["discord"] as const,
  channels: (guildId: string) => ["channels", guildId] as const,
  roles: ["roles"] as const,
  libraries: ["libraries"] as const,
  seerrOptions: ["seerr-options"] as const,
  overview: ["overview"] as const,
  recentRequests: ["requests-recent"] as const,
  upgrade: ["upgrade"] as const,
}

export const useAuth = () => useQuery({ queryKey: keys.auth, queryFn: () => api.get<AuthCheck>("/auth/check") })
export const useSetupState = () => useQuery({ queryKey: keys.setup, queryFn: () => api.get<SetupState>("/setup/state") })
export const useStatus = () =>
  useQuery({ queryKey: keys.status, queryFn: () => api.get<Status>("/status"), refetchInterval: 15_000 })
export const useConfig = () => useQuery({ queryKey: keys.config, queryFn: () => api.get<Config>("/config") })
// Discord rate-limits these lookups; the server caches them for 30 s as well
export const useDiscordSetup = () =>
  useQuery({ queryKey: keys.discord, staleTime: 30_000, queryFn: () => api.get<DiscordSetup & { success: boolean }>("/setup/discord") })

export type ActivityType = "notification" | "request" | "daily-pick" | "roundup"

export interface Overview {
  jellyfin: { serverName: string; version: string; watching: boolean; url: string } | null
  seerr: { version: string | null; url: string } | null
  discord: { botTag: string; botAvatar: string; serverName: string | null; serverIcon: string | null; memberCount: number | null; ping: number | null } | null
  requestCounts: { total: number; movie: number; tv: number; pending: number; approved: number; declined: number; processing: number; available: number } | null
  activity: {
    recent: { at: number; type: ActivityType; title: string | null; detail: string | null; user: string | null }[]
    week: Partial<Record<ActivityType, number>>
  }
}

/** Live server info; jellyfin or seerr is null when that server does not answer. */
export const useOverview = () => useQuery({ queryKey: keys.overview, queryFn: () => api.get<Overview>("/overview"), refetchInterval: 30_000 })

export interface UpgradeItem {
  id: "jellyfin_linked" | "auto_approve" | "guest_limits" | "time_zone" | "webhook_plugin" | "backup" | "removed_keys"
  severity: "critical" | "important" | "cleanup" | "info"
  state: "done" | "todo" | "manual" | "info"
  link?: string
  path?: string
  exists?: boolean
  timeZone?: string
}

export interface Upgrade {
  show: boolean
  upgradedAt?: string
  items: UpgradeItem[]
}

/** Checklist for installs upgraded from 1.x; refreshed with the status so items tick off on their own. */
export const useUpgrade = () => useQuery({ queryKey: keys.upgrade, queryFn: () => api.get<Upgrade>("/upgrade"), refetchInterval: 15_000 })

/** Text channels and threads the bot can post in (needs the bot to be online). */
export function useChannels(guildId: string | undefined) {
  return useQuery({
    queryKey: keys.channels(guildId ?? ""),
    enabled: Boolean(guildId),
    queryFn: async () => {
      const data = await api.get<{ success: boolean; channels: Channel[] }>(`/discord/channels/${guildId}`)
      return data.channels
    },
  })
}

export function useRoles(enabled = true) {
  return useQuery({
    queryKey: keys.roles,
    enabled,
    queryFn: async () => (await api.get<{ roles: Role[] }>("/discord-roles")).roles,
  })
}

export function useLibraries() {
  return useQuery({
    queryKey: keys.libraries,
    queryFn: async () => (await api.get<{ libraries: Library[] }>("/jellyfin/libraries")).libraries,
  })
}

export interface SeerrServer {
  id: number
  name: string
  type: "radarr" | "sonarr"
  isDefault: boolean
}
export interface SeerrProfile {
  id: number
  name: string
  serverId: number
  serverName: string
  type: "radarr" | "sonarr"
}

/** Radarr/Sonarr servers and quality profiles known to the configured Seerr. */
export function useSeerrOptions(enabled: boolean, seerrUrl: string, apiKey: string) {
  return useQuery({
    queryKey: keys.seerrOptions,
    enabled,
    queryFn: async () => {
      const body = { url: seerrUrl, apiKey }
      const [servers, profiles] = await Promise.all([
        api.post<{ servers: SeerrServer[] }>("/seerr/servers", body),
        api.post<{ profiles: SeerrProfile[] }>("/seerr/quality-profiles", body),
      ])
      return { servers: servers.servers, profiles: profiles.profiles }
    },
  })
}

/** Saves a partial configuration; the server keeps everything not sent. */
export function useSaveConfig() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (values: Config) => api.post<{ message?: string }>("/save-config", values),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: keys.config })
      client.invalidateQueries({ queryKey: keys.status })
      client.invalidateQueries({ queryKey: keys.setup })
    },
  })
}
