import { existsSync, readFileSync, mkdirSync, unlinkSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { platform } from 'node:os'
import { execSync } from 'node:child_process'
import { logger } from '../../logger.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { listPendingChannelRequests, updateChannelRequestStatus } from '../../db.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { CHANNEL_PLUGIN_IDS } from '../plugin-ids.js'
import {
  agentDir,
  readFileOr,
  readAgentChannelProvider,
  writeAgentChannelProvider,
  readAgentDisplayName,
  readAgentRemoteHost,
} from '../agent-config.js'
import {
  createInvite,
  listInvites,
  revokeInvite,
} from '../channel-invites.js'
import { hardRestartMarveenChannels } from '../channel-monitor.js'
import { isMainChannelsAgent } from '../main-agent.js'
import {
  getProvider,
  channelStateDir,
  readChannelToken,
  generateSlackAppManifest,
  getSlackAppSetupInstructions,
  type ChannelProviderType,
} from '../../channel-provider.js'
import {
  readAgentTelegramConfig,
  readMarveenTelegramConfig,
  sendWelcomeMessage,
  parseTelegramToken,
} from '../telegram.js'
import {
  isAgentRunning,
  startAgentProcess,
  stopAgentProcess,
  agentSessionName,
  sendPromptToSession,
  capturePane,
} from '../agent-process.js'
import { attemptChannelMcpReconnect } from '../channel-mcp-reconnect.js'
import { getChannelHealth } from '../channel-health-monitor.js'
import { safeJoin } from '../sanitize.js'
import { readBody, readJsonBody, json } from '../http-helpers.js'
import {
  matchChannelRoute,
  resolveAccessPath,
  validateDiscordChannelId,
  findBotTokenDuplicate,
  assertAgentExists,
} from './agents-helpers.js'
import type { RouteContext } from './types.js'

function managedSettingsPath(): string {
  switch (platform()) {
    case 'darwin':
      return '/Library/Application Support/ClaudeCode/managed-settings.json'
    case 'win32':
      return join(process.env.ProgramData || 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json')
    default:
      return '/etc/claude-code/managed-settings.json'
  }
}
const MANAGED_SETTINGS_PATH = managedSettingsPath()
const SLACK_ALLOWLIST_ENTRY = { plugin: 'slack-channel', marketplace: 'marveen-marketplace' }

export function isManagedSettingsReady(): boolean {
  if (!existsSync(MANAGED_SETTINGS_PATH)) return false
  try {
    const data = JSON.parse(readFileSync(MANAGED_SETTINGS_PATH, 'utf-8')) as {
      channelsEnabled?: boolean
      allowedChannelPlugins?: Array<{ plugin: string; marketplace: string }>
    }
    if (!data.channelsEnabled) return false
    const plugins = data.allowedChannelPlugins ?? []
    return plugins.some(
      p => p.plugin === SLACK_ALLOWLIST_ENTRY.plugin && p.marketplace === SLACK_ALLOWLIST_ENTRY.marketplace
    )
  } catch {
    return false
  }
}

export function getManagedSettingsSudoCommand(): string {
  const mergeScript = [
    'import json, sys',
    'new_data = json.loads(sys.stdin.read())',
    'try:\n  with open(' + JSON.stringify(MANAGED_SETTINGS_PATH) + ') as f: data = json.load(f)',
    'except:\n  data = {}',
    'data["channelsEnabled"] = True',
    'existing = data.get("allowedChannelPlugins", [])',
    'for e in new_data["allowedChannelPlugins"]:\n  if not any(p.get("plugin")==e["plugin"] and p.get("marketplace")==e["marketplace"] for p in existing):\n    existing.append(e)',
    'data["allowedChannelPlugins"] = existing',
    'print(json.dumps(data, indent=2))',
  ].join('\n')
  const payload = JSON.stringify({
    allowedChannelPlugins: [
      SLACK_ALLOWLIST_ENTRY,
      { plugin: 'telegram', marketplace: 'claude-plugins-official' },
    ],
  })
  if (platform() === 'win32') {
    const dir = dirname(MANAGED_SETTINGS_PATH)
    return `New-Item -ItemType Directory -Force -Path '${dir}' | Out-Null; '${payload}' | python -c '${mergeScript}' | Set-Content -LiteralPath '${MANAGED_SETTINGS_PATH}' -Encoding utf8`
  }
  const escapedScript = mergeScript.replace(/'/g, "'\\''")
  return `echo '${payload}' | sudo python3 -c '${escapedScript}' | sudo tee "${MANAGED_SETTINGS_PATH}" > /dev/null`
}

export function setAgentEnabledPlugins(name: string, provider: ChannelProviderType): void {
  const settingsDir = join(agentDir(name), '.claude')
  const settingsPath = join(settingsDir, 'settings.json')
  mkdirSync(settingsDir, { recursive: true })
  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* overwrite */ }
  }
  const plugins = (existing.enabledPlugins ?? {}) as Record<string, boolean>
  for (const [p, pluginKey] of Object.entries(CHANNEL_PLUGIN_IDS)) {
    plugins[pluginKey] = p === provider
  }
  existing.enabledPlugins = plugins
  atomicWriteFileSync(settingsPath, JSON.stringify(existing, null, 2))
}

export function resetAgentEnabledPlugins(name: string): void {
  const settingsPath = join(agentDir(name), '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return
  try {
    const existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    delete existing.enabledPlugins
    atomicWriteFileSync(settingsPath, JSON.stringify(existing, null, 2))
  } catch { /* settings corrupt, nothing to reset */ }
}

export async function tryHandleAgentsChannels(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // GET /api/agents/:name/channels/slack/manifest
  const manifestMatch = path.match(/^\/api\/agents\/([^/]+)\/channels\/slack\/manifest$/)
  if (manifestMatch && method === 'GET') {
    const name = decodeURIComponent(manifestMatch[1])
    if (!assertAgentExists(name, res)) return true
    const displayName = readAgentDisplayName(name) || name
    json(res, {
      manifest: generateSlackAppManifest(displayName),
      instructions: getSlackAppSetupInstructions(),
    })
    return true
  }

  // POST /api/agents/:name/channels/slack/smoke-test
  const smokeTestMatch = path.match(/^\/api\/agents\/([^/]+)\/channels\/slack\/smoke-test$/)
  if (smokeTestMatch && method === 'POST') {
    const name = decodeURIComponent(smokeTestMatch[1])
    if (!assertAgentExists(name, res)) return true
    const provider = readAgentChannelProvider(name) as ChannelProviderType
    if (provider !== 'slack') { json(res, { error: 'Nem Slack provider' }, 400); return true }
    const scriptPath = join(agentDir(name), '..', '..', 'scripts', 'smoke-test-slack-channel.sh')
    if (!existsSync(scriptPath)) { json(res, { error: 'Smoke-test script nem található' }, 404); return true }
    const agentEnvPath = join(channelStateDir('slack', agentDir(name)), '.env')
    let envContent = ''
    try { envContent = readFileSync(agentEnvPath, 'utf-8') } catch { /* no .env */ }
    if (!/SLACK_SMOKE_TEST_ALLOWED=true/.test(envContent)) {
      json(res, { error: 'SLACK_SMOKE_TEST_ALLOWED=true nincs beállítva az agent .env-jében' }, 403)
      return true
    }
    try {
      const output = execSync(`bash "${scriptPath}" "${name}"`, {
        timeout: 60000,
        encoding: 'utf-8',
        env: { ...process.env, SLACK_SMOKE_TEST_ALLOWED: 'true' },
      })
      json(res, { ok: true, output })
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string }
      json(res, { ok: false, output: (execErr.stdout || '') + (execErr.stderr || '') }, 200)
    }
    return true
  }

  // POST /api/agents/:name/channel/reconnect
  const reconnectMatch = path.match(/^\/api\/agents\/([^/]+)\/channel\/reconnect$/)
  if (reconnectMatch && method === 'POST') {
    const name = decodeURIComponent(reconnectMatch[1])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404); return true
    }
    if (name !== MAIN_AGENT_ID && !isAgentRunning(name)) {
      json(res, { error: 'Agent is not running' }, 400); return true
    }
    const result = attemptChannelMcpReconnect(name)
    json(res, result)
    return true
  }

  // GET /api/agents/:name/channel/health
  const healthMatch = path.match(/^\/api\/agents\/([^/]+)\/channel\/health$/)
  if (healthMatch && method === 'GET') {
    const name = decodeURIComponent(healthMatch[1])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404); return true
    }
    json(res, getChannelHealth(name))
    return true
  }

  // POST /api/agents/:name/channels/:provider/test (legacy: /telegram/test)
  const testMatch = matchChannelRoute(path, '/test')
  if (testMatch && method === 'POST') {
    const [name, provider] = testMatch
    if (!assertAgentExists(name, res)) return true
    const stateDir = channelStateDir(provider, agentDir(name))
    const envPath = join(stateDir, '.env')
    const token = readChannelToken(provider, envPath) || (provider === 'telegram' ? parseTelegramToken(name) : null)
    if (!token) { json(res, { error: `${provider} not configured for this agent` }, 404); return true }
    const channelProvider = getProvider(provider)
    const result = await channelProvider.validateToken(token)
    if (result.ok) { json(res, { ok: true, botName: result.botName }); return true }
    json(res, { error: result.error }, 400)
    return true
  }

  // POST /api/agents/:name/channels/:provider (legacy: /telegram) -- setup
  const setupMatch = matchChannelRoute(path, '')
  if (setupMatch && method === 'POST') {
    const [name, provider] = setupMatch
    const isMain = name === MAIN_AGENT_ID
    // Marveen lives at PROJECT_ROOT, not under agents/marveen/ -- skip the
    // dir check for the main agent and route writes to ~/.claude/channels/.
    if (!isMain && !existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }

    const body = await readBody(req)

    // Google Chat is creds-based (service-account key + Pub/Sub), not a bot
    // token. Handle it on its own path: write the channel .env + identity
    // access.json, enable the plugin, and restart.
    if (provider === 'googlechat') {
      const { saKeyPath, projectId, subscription, owner, allowDomain } =
        JSON.parse(body.toString()) as { saKeyPath?: string; projectId?: string; subscription?: string; owner?: string; allowDomain?: string }
      if (!saKeyPath?.trim() || !projectId?.trim() || !subscription?.trim() || !owner?.trim()) {
        json(res, { error: 'Google Chat: saKeyPath, projectId, subscription és owner kötelező' }, 400); return true
      }
      const gcDir = isMain ? channelStateDir(provider) : channelStateDir(provider, agentDir(name))
      mkdirSync(gcDir, { recursive: true })
      const gcEnv =
        `GOOGLE_APPLICATION_CREDENTIALS=${saKeyPath.trim()}\n` +
        `GOOGLECHAT_PROJECT_ID=${projectId.trim()}\n` +
        `GOOGLECHAT_SUBSCRIPTION=${subscription.trim()}\n`
      atomicWriteFileSync(join(gcDir, '.env'), gcEnv, { mode: 0o600 })
      atomicWriteFileSync(join(gcDir, 'access.json'), JSON.stringify({
        policy: allowDomain?.trim() ? 'domain' : 'allowlist',
        owner: owner.trim(),
        allowFrom: [],
        allowDomains: allowDomain?.trim() ? [allowDomain.trim()] : [],
        roles: {},
        spaces: {},
        flatReplies: true,
      }, null, 2))
      let gcRestarted = false
      let gcWasRunning = false
      if (isMain) {
        const r = hardRestartMarveenChannels()
        gcRestarted = r.ok
        gcWasRunning = true
      } else {
        writeAgentChannelProvider(name, provider)
        setAgentEnabledPlugins(name, provider)
        gcWasRunning = isAgentRunning(name)
        if (gcWasRunning) {
          const stopRes = stopAgentProcess(name)
          if (stopRes.ok) {
            try { execSync('sleep 2', { timeout: 4000 }) } catch {}
            gcRestarted = startAgentProcess(name).ok
          }
        }
      }
      json(res, { ok: true, botName: 'Google Chat', restarted: gcRestarted, wasRunning: gcWasRunning })
      return true
    }

    const { botToken, appToken, channelId } = JSON.parse(body.toString()) as { botToken: string; appToken?: string; channelId?: string }
    if (!botToken?.trim()) { json(res, { error: 'botToken is required' }, 400); return true }

    // Discord-specific channelId guard: the dashboard ships the channel where
    // the bot will post by default; without it the plugin spins up but cannot
    // resolve a default channel, and on the main Marveen agent the missing
    // value would still trigger hardRestartMarveenChannels and bounce the
    // live session for no useful reason. Reject before any state write.
    if (provider === 'discord') {
      const cidCheck = validateDiscordChannelId(channelId)
      if (!cidCheck.ok) { json(res, { error: cidCheck.error }, 400); return true }
    }

    const channelProvider = getProvider(provider)
    const validation = await channelProvider.validateToken(botToken.trim())
    if (!validation.ok) { json(res, { error: validation.error || 'Invalid token' }, 400); return true }

    const dupeOwner = findBotTokenDuplicate(provider, botToken.trim(), name)
    if (dupeOwner) {
      json(res, { error: `This bot token is already used by agent "${dupeOwner}". Each agent needs its own bot token to avoid getUpdates conflicts.` }, 409)
      return true
    }

    if (provider === 'slack' && !isManagedSettingsReady()) {
      const displayName = readAgentDisplayName(name) || name
      json(res, {
        error: 'managed-settings-missing',
        sudoCommand: getManagedSettingsSudoCommand(),
        slackAppManifest: generateSlackAppManifest(displayName),
        slackAppInstructions: getSlackAppSetupInstructions(),
      }, 409)
      return true
    }

    // Main agent's channel state lives under ~/.claude/channels/<provider>,
    // sub-agents under agents/<name>/.claude/channels/<provider>.
    const stateDir = isMain ? channelStateDir(provider) : channelStateDir(provider, agentDir(name))
    mkdirSync(stateDir, { recursive: true })
    const tokenKey = provider === 'slack' ? 'SLACK_BOT_TOKEN'
      : provider === 'discord' ? 'DISCORD_BOT_TOKEN'
      : 'TELEGRAM_BOT_TOKEN'
    let envContent = `${tokenKey}=${botToken.trim()}\n`
    if (provider === 'slack' && appToken?.trim()) {
      envContent += `SLACK_APP_TOKEN=${appToken.trim()}\n`
    }
    if (provider === 'discord' && channelId?.trim()) {
      envContent += `DISCORD_CHANNEL_ID=${channelId.trim()}\n`
    }
    atomicWriteFileSync(join(stateDir, '.env'), envContent, { mode: 0o600 })
    atomicWriteFileSync(join(stateDir, 'access.json'), JSON.stringify({
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: {},
      pending: {},
    }, null, 2))

    // Main agent doesn't have an agent-config.json or enabled-plugins entry
    // (the channels session reuses the system claude install), so skip the
    // sub-agent-specific bookkeeping. Restart goes through the dedicated
    // marveen-channels helper instead of the agent process lifecycle.
    let restarted = false
    let wasRunning = false
    if (isMain) {
      const r = hardRestartMarveenChannels()
      restarted = r.ok
      wasRunning = true
    } else {
      writeAgentChannelProvider(name, provider)
      setAgentEnabledPlugins(name, provider)
      if (provider === 'telegram') sendWelcomeMessage(name, botToken.trim()).catch(() => {})
      wasRunning = isAgentRunning(name)
      if (wasRunning) {
        const stopRes = stopAgentProcess(name)
        if (stopRes.ok) {
          try { execSync('sleep 2', { timeout: 4000 }) } catch {}
          const startRes = startAgentProcess(name)
          restarted = startRes.ok
        }
      }
    }

    json(res, { ok: true, botName: validation.botName, restarted, wasRunning })
    return true
  }

  // DELETE /api/agents/:name/channels/:provider (legacy: /telegram) -- remove
  if (setupMatch && method === 'DELETE') {
    const [name, provider] = setupMatch
    if (!assertAgentExists(name, res)) return true
    const stateDir = channelStateDir(provider, agentDir(name))
    const envFile = join(stateDir, '.env')
    const accessFile = join(stateDir, 'access.json')
    if (existsSync(envFile)) unlinkSync(envFile)
    if (existsSync(accessFile)) unlinkSync(accessFile)
    writeAgentChannelProvider(name, '')
    resetAgentEnabledPlugins(name)
    json(res, { ok: true })
    return true
  }

  // GET /api/agents/:name/channels/:provider/pending (legacy: /telegram/pending)
  const pendingMatch = matchChannelRoute(path, '/pending')
  if (pendingMatch && method === 'GET') {
    const [name, provider] = pendingMatch
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }
    const accessPath = resolveAccessPath(name, provider)
    const accessContent = readFileOr(accessPath, '{}')
    try {
      const access = JSON.parse(accessContent)
      const pending = access.pending || {}
      const entries = Object.entries(pending).map(([code, entry]: [string, any]) => ({
        code,
        senderId: entry.senderId,
        chatId: entry.chatId,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      }))
      json(res, entries)
    } catch {
      json(res, [])
    }
    return true
  }

  // POST /api/agents/:name/channels/:provider/approve (legacy: /telegram/approve)
  const approveMatch = matchChannelRoute(path, '/approve')
  if (approveMatch && method === 'POST') {
    const [name, provider] = approveMatch
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }

    const { code } = await readJsonBody<{ code: string }>(req)
    if (!code?.trim()) { json(res, { error: 'Code is required' }, 400); return true }

    const chDir = name === MAIN_AGENT_ID
      ? channelStateDir(provider)
      : channelStateDir(provider, agentDir(name))
    const accessPath = join(chDir, 'access.json')
    const accessContent = readFileOr(accessPath, '{}')

    try {
      const access = JSON.parse(accessContent)
      const pending = access.pending || {}
      const entry = pending[code.trim()]

      if (!entry) { json(res, { error: 'Invalid or expired code' }, 404); return true }

      if (!access.allowFrom) access.allowFrom = []
      if (!access.allowFrom.includes(entry.senderId)) {
        access.allowFrom.push(entry.senderId)
      }

      delete access.pending[code.trim()]

      access.dmPolicy = 'allowlist'

      atomicWriteFileSync(accessPath, JSON.stringify(access, null, 2))

      const approvedDir = join(chDir, 'approved')
      mkdirSync(approvedDir, { recursive: true })
      // Marker contents = chatId, per the plugin's /telegram:access pair
      // contract (the channel server polls approved/ to send the "Paired!"
      // confirmation; current server keys off the filename, the chatId
      // contents keep us aligned with the documented format).
      writeFileSync(join(approvedDir, entry.senderId), String(entry.chatId ?? ''))

      logger.info({ name, provider, senderId: entry.senderId, code }, 'Channel pairing approved')
      json(res, { ok: true, senderId: entry.senderId })
    } catch (err) {
      logger.error({ err }, 'Failed to approve pairing')
      json(res, { error: 'Failed to approve pairing' }, 500)
    }
    return true
  }

  // GET /api/agents/:name/channels/:provider/allowed (legacy: /telegram/allowed)
  const allowedListMatch = matchChannelRoute(path, '/allowed')
  if (allowedListMatch && method === 'GET') {
    const [name, provider] = allowedListMatch
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }
    const accessPath = resolveAccessPath(name, provider)
    const accessContent = readFileOr(accessPath, '{}')
    try {
      const access = JSON.parse(accessContent)
      const users: string[] = Array.isArray(access.allowFrom) ? access.allowFrom : []
      const groups = Object.entries(access.groups || {}).map(([id, policy]) => ({ id, policy }))
      json(res, { users, groups })
    } catch {
      json(res, { users: [], groups: [] })
    }
    return true
  }

  // POST /api/agents/:name/channels/:provider/invites (legacy: /telegram/invites)
  const inviteCreateMatch = matchChannelRoute(path, '/invites')
  if (inviteCreateMatch && method === 'POST') {
    const [name, provider] = inviteCreateMatch
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }
    let botName: string | undefined
    if (provider === 'telegram') {
      botName = name === MAIN_AGENT_ID
        ? readMarveenTelegramConfig().botUsername
        : readAgentTelegramConfig(name).botUsername
      if (!botName) {
        const stateDir = name === MAIN_AGENT_ID ? channelStateDir(provider) : channelStateDir(provider, agentDir(name))
        const token = readChannelToken(provider, join(stateDir, '.env'))
        if (token) {
          const r = await getProvider(provider).validateToken(token)
          if (r.ok) botName = r.botName
        }
      }
    }
    const accessPath = resolveAccessPath(name, provider)
    try {
      const result = createInvite(accessPath, botName, provider)
      json(res, result)
    } catch (err) {
      logger.error({ err }, 'Failed to create invite')
      json(res, { error: 'Failed to create invite' }, 500)
    }
    return true
  }

  // GET /api/agents/:name/channels/:provider/invites (legacy: /telegram/invites)
  if (inviteCreateMatch && method === 'GET') {
    const [name, provider] = inviteCreateMatch
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }
    const accessPath = resolveAccessPath(name, provider)
    let botName: string | undefined
    if (provider === 'telegram') {
      botName = name === MAIN_AGENT_ID
        ? readMarveenTelegramConfig().botUsername
        : readAgentTelegramConfig(name).botUsername
    }
    const cleanBotName = botName?.replace(/^@/, '')
    const items = listInvites(accessPath).map((inv) => ({
      ...inv,
      deepLink: provider === 'telegram' && cleanBotName
        ? `https://t.me/${cleanBotName}?start=invite-${inv.token}`
        : undefined,
    }))
    json(res, items)
    return true
  }

  // DELETE /api/agents/:name/channels/:provider/invites/:token
  const inviteRevokeNewMatch = path.match(/^\/api\/agents\/([^/]+)\/channels\/(telegram|slack|discord)\/invites\/(.+)$/)
  const inviteRevokeMatch = inviteRevokeNewMatch
    ? { name: decodeURIComponent(inviteRevokeNewMatch[1]), provider: inviteRevokeNewMatch[2] as ChannelProviderType, token: decodeURIComponent(inviteRevokeNewMatch[3]) }
    : null
  if (inviteRevokeMatch && method === 'DELETE') {
    const { name, provider, token } = inviteRevokeMatch
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }
    const accessPath = resolveAccessPath(name, provider)
    const ok = revokeInvite(accessPath, token)
    if (!ok) { json(res, { error: 'Invite not found' }, 404); return true }
    json(res, { ok: true })
    return true
  }

  // DELETE /api/agents/:name/channels/:provider/allowed/:type/:id
  const allowedRemoveNewMatch = path.match(/^\/api\/agents\/([^/]+)\/channels\/(telegram|slack|discord)\/allowed\/(user|group)\/(.+)$/)
  const allowedRemoveMatch = allowedRemoveNewMatch
    ? { name: decodeURIComponent(allowedRemoveNewMatch[1]), provider: allowedRemoveNewMatch[2] as ChannelProviderType, kind: allowedRemoveNewMatch[3], id: decodeURIComponent(allowedRemoveNewMatch[4]) }
    : null
  if (allowedRemoveMatch && method === 'DELETE') {
    const { name, provider, kind, id } = allowedRemoveMatch
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }
    const chDir = name === MAIN_AGENT_ID
      ? channelStateDir(provider)
      : channelStateDir(provider, agentDir(name))
    const accessPath = join(chDir, 'access.json')
    try {
      const access = JSON.parse(readFileOr(accessPath, '{}'))
      if (kind === 'user') {
        access.allowFrom = (access.allowFrom || []).filter((s: string) => s !== id)
        // safeJoin blocks a traversal id (e.g. "..%2F..%2Ftmp%2Fvictim") from
        // escaping the approved/ dir into an arbitrary unlinkSync target.
        try {
          const approvedFile = safeJoin(join(chDir, 'approved'), id)
          if (existsSync(approvedFile)) unlinkSync(approvedFile)
        } catch { /* ignore missing file or rejected traversal */ }
      } else {
        if (access.groups) delete access.groups[id]
      }
      atomicWriteFileSync(accessPath, JSON.stringify(access, null, 2))
      logger.info({ name, provider, kind, id }, 'Channel allowlist entry removed')
      json(res, { ok: true })
    } catch (err) {
      logger.error({ err }, 'Failed to remove allowlist entry')
      json(res, { error: 'Failed to remove allowlist entry' }, 500)
    }
    return true
  }

  // --- Channel Requests (Slack channel opt-in workflow) ---

  const chReqListMatch = path.match(/^\/api\/agents\/([^/]+)\/channel-requests$/)
  if (chReqListMatch && method === 'GET') {
    const name = decodeURIComponent(chReqListMatch[1])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    json(res, listPendingChannelRequests(name))
    return true
  }

  const chReqApproveMatch = path.match(/^\/api\/agents\/([^/]+)\/channel-requests\/(\d+)\/approve$/)
  if (chReqApproveMatch && method === 'POST') {
    const name = decodeURIComponent(chReqApproveMatch[1])
    const reqId = Number(chReqApproveMatch[2])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }

    const body = await readBody(req)
    let opts: { requireMention?: boolean; allowFromAll?: boolean } = {}
    try { opts = JSON.parse(body.toString() || '{}') } catch { json(res, { error: 'Invalid JSON body' }, 400); return true }

    const pending = listPendingChannelRequests(name)
    const request = pending.find(r => r.id === reqId)
    if (!request) { json(res, { error: 'Request not found' }, 404); return true }

    const provider = readAgentChannelProvider(name) as ChannelProviderType
    if (provider !== 'slack') { json(res, { error: 'Only Slack agents support channel requests' }, 400); return true }

    const accessPath = resolveAccessPath(name, provider)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let access: any = { dmPolicy: 'allowlist', allowFrom: [], groups: {} }
      if (existsSync(accessPath)) {
        try {
          access = JSON.parse(readFileSync(accessPath, 'utf-8'))
        } catch (parseErr) {
          const backupPath = `${accessPath}.corrupt-${Math.floor(Date.now() / 1000)}`
          try { renameSync(accessPath, backupPath) } catch { /* best effort */ }
          logger.warn({ parseErr, accessPath, backupPath }, 'Corrupt access.json backed up, starting fresh')
        }
      }
      if (!access.channels) access.channels = {}

      const channelConfig: Record<string, unknown> = { requireMention: opts.requireMention !== false }
      if (!opts.allowFromAll && request.user_id) {
        channelConfig.allowFrom = [request.user_id]
      }
      access.channels[request.channel_id] = channelConfig

      atomicWriteFileSync(accessPath, JSON.stringify(access, null, 2))
      updateChannelRequestStatus(reqId, 'approved')
      logger.info({ name, channelId: request.channel_id, channelName: request.channel_name }, 'Channel request approved')
      json(res, { ok: true })
    } catch (err) {
      logger.error({ err }, 'Failed to approve channel request')
      json(res, { error: 'Failed to approve request' }, 500)
    }
    return true
  }

  const chReqDenyMatch = path.match(/^\/api\/agents\/([^/]+)\/channel-requests\/(\d+)\/deny$/)
  if (chReqDenyMatch && method === 'POST') {
    const name = decodeURIComponent(chReqDenyMatch[1])
    const reqId = Number(chReqDenyMatch[2])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    if (updateChannelRequestStatus(reqId, 'denied')) {
      json(res, { ok: true })
    } else {
      json(res, { error: 'Request not found or already resolved' }, 404)
    }
    return true
  }

  // POST /api/agents/:name/auth/init -- trigger /login in the agent's tmux,
  // wait a few seconds for the auth URL to appear, then scrape it back.
  const authInitMatch = path.match(/^\/api\/agents\/([^/]+)\/auth\/init$/)
  if (authInitMatch && method === 'POST') {
    const name = decodeURIComponent(authInitMatch[1])
    if (!assertAgentExists(name, res)) return true
    if (!isAgentRunning(name)) { json(res, { error: 'Agent is not running' }, 400); return true }
    const session = agentSessionName(name)
    const host = readAgentRemoteHost(name)
    try {
      await sendPromptToSession(session, '/login', host)
      // Wait for Claude Code to render the auth URL (typically 3-6s)
      let authUrl: string | null = null
      for (let i = 0; i < 12; i++) {
        execSync('sleep 1', { timeout: 3000 })
        const pane = capturePane(session, host)
        if (!pane) continue
        const urlMatch = pane.match(/https:\/\/console\.anthropic\.com\/[^\s"']+/)
          || pane.match(/https:\/\/auth\.anthropic\.com\/[^\s"']+/)
          || pane.match(/https:\/\/claude\.ai\/[^\s"']+login[^\s"']*/)
        if (urlMatch) {
          authUrl = urlMatch[0]
          break
        }
      }
      if (authUrl) {
        json(res, { ok: true, authUrl })
      } else {
        json(res, { ok: false, error: 'Auth URL nem jelent meg 12 masodpercen belul. Probald ujra, vagy nezd a tmux session-t.' })
      }
    } catch (err) {
      logger.error({ err, name }, 'Auth init failed')
      json(res, { error: 'Auth flow indítása sikertelen' }, 500)
    }
    return true
  }

  return false
}
