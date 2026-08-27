import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../../config.js'
import { getSecret } from '../vault.js'
import {
  agentDir,
  agentConfigRoot,
  readFileOr,
  extractDescriptionFromClaudeMd,
  findAvatarForAgent,
  readAgentModel,
  resolveAgentModelDetailed,
  readAgentDisplayName,
  readAgentSecurityProfile,
  readAgentAuthMode,
  readAgentClaudePlan,
  readAgentMemoryIsolation,
  readAgentRemoteConfig,
  readAgentMcpScopeRaw,
  listAgentNames,
  type AuthMode,
} from '../agent-config.js'
import { parseMcpScope, type McpScope } from '../mcp-tool-registry.js'
import { resolveAgentConfigDir } from '../claude-plans.js'
import { readAgentTeam, type TeamConfig } from '../agent-team.js'
import {
  readAgentTelegramConfig,
  readAgentDiscordConfig,
  readAgentGooglechatConfig,
  readAgentTeamsConfig,
} from '../telegram.js'
import {
  channelStateDir,
  readChannelToken,
  type ChannelProviderType,
} from '../../channel-provider.js'
import {
  agentRunState,
  getAgentRunningSince,
  agentSessionName,
  capturePane,
} from '../agent-process.js'
import { RemoteStatusCache } from '../remote-status-cache.js'
import type { AgentRunState } from '../ssh-tmux.js'
import { readActiveModelFromProjectDir, readContextTokensFromProjectDir } from '../active-model.js'
import { detectReauthNeeded } from '../reauth-detect.js'
import { readAutoRestartConfig } from '../auto-restart-store.js'
import { readContextGuardConfig } from '../context-guard-store.js'
import type { AutoRestartConfig } from '../../auto-restart.js'
import type { ContextGuardConfig } from '../../context-guard.js'
import { json } from '../http-helpers.js'
import type http from 'node:http'

export const VALID_PROVIDERS = new Set<ChannelProviderType>(['telegram', 'slack', 'discord', 'googlechat', 'teams'])

// Short-TTL caches so the synchronous, frequently-polled status endpoints
// (`/api/agents` on load, `/api/agents/activity` every 3s) don't issue a fresh
// blocking ssh call per remote agent per request. Only remote agents are cached;
// local agents fetch fresh (sub-ms tmux). See remote-status-cache.ts.
export const remoteRunStateCache = new RemoteStatusCache<AgentRunState>(5000)
export const remotePaneCache = new RemoteStatusCache<string | null>(3000)

// Resolve an agent's run state, cached for remote agents to avoid blocking on
// ssh. `isRemote` is passed by the caller (it already read the remote config).
export function agentRunStateCached(name: string, isRemote: boolean): AgentRunState {
  if (!isRemote) return agentRunState(name)
  return remoteRunStateCache.getOrRefresh(name, Date.now(), () => agentRunState(name), 'unreachable')
}

// Discord channel ids are snowflakes — base-10 numeric ids, 17 to 20 digits
// long in practice (current Discord scheme is 64-bit, with the leading bit
// always 0). Rejects empty, whitespace-only, non-numeric, or wrong-length
// values before any state write so a typo in the dashboard cannot bounce the
// live Marveen session through hardRestartMarveenChannels().
export function validateDiscordChannelId(cid: string | undefined): { ok: boolean; error?: string; field?: string; hint?: string } {
  const trimmed = cid?.trim()
  if (!trimmed || !/^[0-9]{17,20}$/.test(trimmed)) {
    return { ok: false, error: 'invalid_value', field: 'channelId', hint: 'Discord channelId is required and must be a numeric snowflake (17-20 digits).' }
  }
  return { ok: true }
}

export function parseChannelProvider(raw: string): ChannelProviderType | null {
  if (VALID_PROVIDERS.has(raw as ChannelProviderType)) return raw as ChannelProviderType
  return null
}

// Match /channels/:provider/ URL patterns. Returns [agentName, provider] or null.
export function matchChannelRoute(path: string, suffix: string): [string, ChannelProviderType] | null {
  const pattern = new RegExp(`^/api/agents/([^/]+)/channels/(telegram|slack|discord|googlechat|teams)${suffix}$`)
  const match = path.match(pattern)
  if (match) {
    const provider = parseChannelProvider(match[2])
    if (provider) return [decodeURIComponent(match[1]), provider]
  }
  return null
}

export function resolveAccessPath(name: string, provider: ChannelProviderType): string {
  const dir = name === MAIN_AGENT_ID
    ? channelStateDir(provider)
    : channelStateDir(provider, agentDir(name))
  return join(dir, 'access.json')
}

export function extractBotId(token: string): string | null {
  const colon = token.indexOf(':')
  if (colon < 1) return null
  const id = token.slice(0, colon)
  return /^\d+$/.test(id) ? id : null
}

export function findBotTokenDuplicate(
  provider: ChannelProviderType,
  token: string,
  excludeAgent: string,
): string | null {
  const botId = extractBotId(token)
  if (!botId) return null

  const candidates: Array<{ name: string; envPath: string }> = []

  // Main agent's channel .env
  if (excludeAgent !== MAIN_AGENT_ID) {
    const mainEnv = join(channelStateDir(provider), '.env')
    candidates.push({ name: MAIN_AGENT_ID, envPath: mainEnv })
  }

  // All sub-agents
  for (const agentName of listAgentNames()) {
    if (agentName === excludeAgent) continue
    const envPath = join(channelStateDir(provider, agentDir(agentName)), '.env')
    candidates.push({ name: agentName, envPath })
  }

  for (const { name, envPath } of candidates) {
    const existing = readChannelToken(provider, envPath)
    if (!existing) continue
    const existingBotId = extractBotId(existing)
    if (existingBotId === botId) return name
  }

  return null
}

export interface AgentSummary {
  name: string
  displayName: string
  description: string
  /** The concrete model id this agent resolves to. Unchanged meaning: for a
   *  config that names a `model`, this is exactly what it always was. */
  model: string
  /** Card c755f4b2 Block B: how `model` was arrived at. Metadata only -- it
   *  reports the existing resolution, it does not change it. */
  modelProfile: string | null
  modelSource: 'explicit_model' | 'model_profile' | 'default'
  modelProfileError: string | null
  activeModel: string | null
  runningSince: number | null
  authMode: AuthMode
  securityProfile: string
  /** Named Claude subscription plan id (see claude-plans.ts), or null when the
   *  agent uses the raw claudeConfigDir / default resolution. */
  claudePlan: string | null
  team: TeamConfig
  hasTelegram: boolean
  telegramBotUsername?: string
  hasDiscord: boolean
  hasGooglechat: boolean
  hasTeams: boolean
  status: 'configured' | 'draft'
  running: boolean
  /** Tri-state: 'running' | 'stopped' | 'unreachable' (remote ssh failure). */
  runState: AgentRunState
  /** Remote ssh destination + workdir, or null for a local agent. */
  remoteHost: string | null
  remoteWorkdir: string | null
  session?: string
  hasAvatar: boolean
  autoRestart: AutoRestartConfig
  /** Per-agent context-guard config, carried here for the same reason as
   *  autoRestart: the settings pane renders both from one detail fetch. */
  contextGuard: ContextGuardConfig
  /** Live context size in tokens (input+cache_read+cache_creation of the last
   *  turn), or null when not running / no transcript yet. */
  contextTokens: number | null
  /** True when the running session's pane shows a login/401 auth failure --
   *  drives the dashboard "reauth needed" badge + one-click /login button. */
  needsReauth: boolean
  reauthReason?: string
}

export interface AgentDetail extends AgentSummary {
  memoryIsolation: boolean
  claudeMd: string
  soulMd: string
  mcpJson: string
  mcpScope: McpScope
  skills: { name: string; hasSkillMd: boolean }[]
  hasAvatar: boolean
  hasApiKey: boolean
}

export function getAgentSummary(name: string): AgentSummary {
  const dir = agentDir(name)
  const configRoot = agentConfigRoot(name)
  const claudeMd = readFileOr(join(configRoot, 'CLAUDE.md'), '')
  const soulMd = readFileOr(join(dir, 'SOUL.md'), '')
  const tg = readAgentTelegramConfig(name)
  const dc = readAgentDiscordConfig(name)
  const gc = readAgentGooglechatConfig(name)
  const tc = readAgentTeamsConfig(name)
  const hasClaudeMd = claudeMd.trim().length > 0
  const hasSoulMd = soulMd.trim().length > 0

  // Resolve run state through the cache (remote agents) so listing the fleet
  // never blocks on a sleeping laptop's ssh timeout. `running` is derived from
  // it; `unreachable` reads as not-running but is surfaced distinctly so the UI
  // does not show a still-alive remote agent as "stopped".
  const remote = readAgentRemoteConfig(name)
  const runState = agentRunStateCached(name, remote.host != null)
  const running = runState === 'running'
  const session = running ? agentSessionName(name) : undefined
  const runningSince = running ? getAgentRunningSince(name) : null

  // Reauth badge: only meaningful for a running session (a stopped agent has
  // no pane to inspect). One capture-pane per running agent on the list poll.
  const reauth = running ? detectReauthNeeded(capturePane(agentSessionName(name))) : { needsReauth: false }

  // Card c755f4b2 Block B: resolve once and report both the answer and how it
  // was reached, so "configured" and "resolved" are never conflated in the API.
  let agentModelConfig: { model?: unknown; modelProfile?: unknown } = {}
  try { agentModelConfig = JSON.parse(readFileOr(join(dir, 'agent-config.json'), '{}')) } catch { /* defaults */ }
  const modelResolution = resolveAgentModelDetailed(name)

  return {
    name,
    displayName: readAgentDisplayName(name),
    description: extractDescriptionFromClaudeMd(claudeMd),
    model: modelResolution.model,
    modelProfile: typeof agentModelConfig.modelProfile === 'string' ? agentModelConfig.modelProfile : null,
    modelSource: modelResolution.source,
    modelProfileError: modelResolution.error ?? null,
    activeModel: running ? readActiveModelFromProjectDir(dir, runningSince ?? undefined, resolveAgentConfigDir(name).configDir ?? undefined) : null,
    runningSince,
    authMode: readAgentAuthMode(name),
    securityProfile: readAgentSecurityProfile(name),
    claudePlan: readAgentClaudePlan(name),
    team: readAgentTeam(name),
    hasTelegram: tg.hasTelegram,
    telegramBotUsername: tg.botUsername,
    hasDiscord: dc.hasDiscord,
    hasGooglechat: gc.hasGooglechat,
    hasTeams: tc.hasTeams,
    status: hasClaudeMd && hasSoulMd ? 'configured' : 'draft',
    running,
    runState,
    remoteHost: remote.host,
    remoteWorkdir: remote.workdir,
    session,
    hasAvatar: findAvatarForAgent(name) !== null,
    autoRestart: readAutoRestartConfig(name),
    contextGuard: readContextGuardConfig(name),
    contextTokens: running ? readContextTokensFromProjectDir(dir, resolveAgentConfigDir(name).configDir ?? undefined) : null,
    needsReauth: reauth.needsReauth,
    reauthReason: reauth.reason,
  }
}

export function getAgentDetail(name: string): AgentDetail {
  const dir = agentDir(name)
  const configRoot = agentConfigRoot(name)
  const summary = getAgentSummary(name)
  const claudeMd = readFileOr(join(configRoot, 'CLAUDE.md'), '')
  const soulMd = readFileOr(join(dir, 'SOUL.md'), '')
  const mcpJson = readFileOr(join(dir, '.mcp.json'), '{}')

  const skillsDir = join(dir, '.claude', 'skills')
  let skills: { name: string; hasSkillMd: boolean }[] = []
  if (existsSync(skillsDir)) {
    skills = readdirSync(skillsDir)
      .filter((f) => {
        try { return statSync(join(skillsDir, f)).isDirectory() } catch { return false }
      })
      .map((f) => ({
        name: f,
        hasSkillMd: existsSync(join(skillsDir, f, 'SKILL.md')),
      }))
  }

  return {
    ...summary,
    memoryIsolation: readAgentMemoryIsolation(name),
    claudeMd,
    soulMd,
    mcpJson,
    mcpScope: parseMcpScope(readAgentMcpScopeRaw(name)),
    skills,
    hasAvatar: findAvatarForAgent(name) !== null,
    hasApiKey: getSecret(`agent-${name}-api-key`) !== null,
  }
}

export function listAgentSummaries(): AgentSummary[] {
  return listAgentNames().map(getAgentSummary)
}

// Shared guard: returns true when the agent exists, false (+ 404 response) when
// it does not. Usage: `if (!assertAgentExists(name, res)) return true`
// Replaces the ~15 inline `if (!existsSync(agentDir(name))) { json(res, …, 404); return true }` copies.
export function assertAgentExists(name: string, res: http.ServerResponse): boolean {
  if (existsSync(agentDir(name))) return true
  json(res, { error: 'not_found', hint: 'Agent not found' }, 404)
  return false
}
