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
}

export const useAuth = () => useQuery({ queryKey: keys.auth, queryFn: () => api.get<AuthCheck>("/auth/check") })
export const useSetupState = () => useQuery({ queryKey: keys.setup, queryFn: () => api.get<SetupState>("/setup/state") })
export const useStatus = () =>
  useQuery({ queryKey: keys.status, queryFn: () => api.get<Status>("/status"), refetchInterval: 15_000 })
export const useConfig = () => useQuery({ queryKey: keys.config, queryFn: () => api.get<Config>("/config") })
export const useDiscordSetup = () =>
  useQuery({ queryKey: keys.discord, queryFn: () => api.get<DiscordSetup & { success: boolean }>("/setup/discord") })

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
