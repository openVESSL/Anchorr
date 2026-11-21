// Talks to Anchorr's backend (/api) with the session cookie.

export class ApiError extends Error {
  status: number
  /** Per-field validation errors from save-config: field -> message */
  fields: Record<string, string>

  constructor(status: number, message: string, fields: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.fields = fields
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.success === false) {
    const fields: Record<string, string> = {}
    for (const e of Array.isArray(data?.errors) ? data.errors : []) fields[e.field] = e.message
    const message = data?.message || data?.error || response.statusText || "Request failed"
    throw new ApiError(response.ok ? 400 : response.status, message, fields)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  delete: <T>(path: string) => request<T>("DELETE", path),
}

// ----- types -----

export interface AuthCheck {
  isAuthenticated: boolean
  user?: { username: string; method?: string }
  hasUsers: boolean
  jellyfinLogin: boolean
  needsSetup: boolean
}

export interface SetupState {
  needsSetup: boolean
  jellyfin: boolean
  seerr: boolean
  discord: boolean
  discordServer: boolean
  localAccount: boolean
}

export interface Status {
  version: string
  uptimeFormatted: string
  isBotRunning: boolean
  botUsername: string | null
  botConnected: boolean
  jellyfinConnected: boolean
  legacyWebhookLastSeen: number | null
  proxyWithoutTrust: boolean
}

/** config.json as the dashboard sees it: secrets masked, values mostly strings. */
export type Config = Record<string, unknown>

export interface DiscordSetup {
  configured: boolean
  botName?: string
  membersIntent?: boolean | null
  inviteUrl?: string
  guilds?: { id: string; name: string }[]
  guildId?: string | null
  botRunning?: boolean
}

export interface Channel {
  id: string
  name: string
  type: string
}

export interface Role {
  id: string
  name: string
  color: string
  memberCount: number
}

export interface Library {
  id: string
  name: string
  type?: string
}
