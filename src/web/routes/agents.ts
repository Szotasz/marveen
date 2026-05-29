import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { join, extname } from 'node:path'
import { homedir, platform } from 'node:os'
import { execSync } from 'node:child_process'
import { logger } from '../../logger.js'
import { MAIN_AGENT_ID, BOT_NAME } from '../../config.js'
import { createAgentMessage, listPendingChannelRequests, updateChannelRequestStatus } from '../../db.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { getSecret, setSecret, deleteSecret, listSecrets } from '../vault.js'
import {
  agentDir,
  agentConfigRoot,
  DEFAULT_MODEL,
  readFileOr,
  extractDescriptionFromClaudeMd,
  findAvatarForAgent,
  resolveModelId,
  readAgentModel,
  writeAgentModel,
  readAgentDisplayName,
  writeAgentDisplayName,
  readAgentSecurityProfile,
  writeAgentSecurityProfile,
  listAgentNames,
  isKnownAgent,
  readAgentChannelProvider,
  writeAgentChannelProvider,
  readAgentAuthMode,
  writeAgentAuthMode,
  type AuthMode,
} from '../agent-config.js'
import {
  readAgentTeam,
  writeAgentTeam,
  sanitizeTeamConfig,
  cleanupTeamReferences,
  type TeamConfig,
} from '../agent-team.js'
import {
  readAgentTelegramConfig,
  readAgentDiscordConfig,
  readMarveenTelegramConfig,
  sendAvatarChangeMessage,
  sendWelcomeMessage,
  validateTelegramToken,
  parseTelegramToken,
} from '../telegram.js'
import {
  createInvite,
  listInvites,
  revokeInvite,
  agentChannelDir,
} from '../channel-invites.js'
import {
  getProvider,
  channelStateDir,
  readChannelToken,
  generateSlackAppManifest,
  getSlackAppSetupInstructions,
  type ChannelProviderType,
} from '../../channel-provider.js'
import {
  writeAgentSettingsFromProfile,
  scaffoldAgentDir,
  generateClaudeMd,
  generateSoulMd,
} from '../agent-scaffold.js'
import {
  isAgentRunning,
  startAgentProcess,
  stopAgentProcess,
  getAgentProcessInfo,
  agentSessionName,
  sendPromptToSession,
  capturePane,
} from '../agent-process.js'
import { attemptChannelMcpReconnect } from '../channel-mcp-reconnect.js'
import { getChannelHealth } from '../channel-health-monitor.js'
import {
  loadProfileTemplate,
  resolveProfilePlaceholders,
} from '../profiles.js'
import { sanitizeAgentName } from '../sanitize.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json, serveFile } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const VALID_PROVIDERS = new Set<ChannelProviderType>(['telegram', 'slack', 'discord'])

function parseChannelProvider(raw: string): ChannelProviderType | null {
  if (VALID_PROVIDERS.has(raw as ChannelProviderType)) return raw as ChannelProviderType
  return null
}

// Match both new /channels/:provider/ and legacy /telegram/ URL patterns.
// Returns [agentName, provider] or null. Legacy routes always resolve to 'telegram'.
function matchChannelRoute(path: string, suffix: string): [string, ChannelProviderType] | null {
  const newPattern = new RegExp(`^/api/agents/([^/]+)/channels/(telegram|slack|discord)${suffix}$`)
  const newMatch = path.match(newPattern)
  if (newMatch) {
    const provider = parseChannelProvider(newMatch[2])
    if (provider) return [decodeURIComponent(newMatch[1]), provider]
  }
  const legacyPattern = new RegExp(`^/api/agents/([^/]+)/telegram${suffix}$`)
  const legacyMatch = path.match(legacyPattern)
  if (legacyMatch) return [decodeURIComponent(legacyMatch[1]), 'telegram']
  return null
}

const MANAGED_SETTINGS_PATH = platform() === 'darwin'
  ? '/Library/Application Support/ClaudeCode/managed-settings.json'
  : '/etc/claude-code/managed-settings.json'
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
    'try:\n  with open("' + MANAGED_SETTINGS_PATH + '") as f: data = json.load(f)',
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
  const allPlugins: Record<ChannelProviderType, string> = {
    telegram: 'telegram@claude-plugins-official',
    slack: 'slack-channel@marveen-marketplace',
    discord: 'discord@claude-plugins-official',
  }
  for (const [p, pluginKey] of Object.entries(allPlugins)) {
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

function resolveAccessPath(name: string, provider: ChannelProviderType): string {
  const dir = name === MAIN_AGENT_ID
    ? channelStateDir(provider)
    : channelStateDir(provider, agentDir(name))
  return join(dir, 'access.json')
}

function extractBotId(token: string): string | null {
  const colon = token.indexOf(':')
  if (colon < 1) return null
  const id = token.slice(0, colon)
  return /^\d+$/.test(id) ? id : null
}

function findBotTokenDuplicate(
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

interface AgentSummary {
  name: string
  displayName: string
  description: string
  model: string
  authMode: AuthMode
  securityProfile: string
  team: TeamConfig
  hasTelegram: boolean
  telegramBotUsername?: string
  hasDiscord: boolean
  status: 'configured' | 'draft'
  running: boolean
  session?: string
  hasAvatar: boolean
}

interface AgentDetail extends AgentSummary {
  claudeMd: string
  soulMd: string
  mcpJson: string
  skills: { name: string; hasSkillMd: boolean }[]
  hasAvatar: boolean
  hasApiKey: boolean
}

function getAgentSummary(name: string): AgentSummary {
  const dir = agentDir(name)
  const configRoot = agentConfigRoot(name)
  const claudeMd = readFileOr(join(configRoot, 'CLAUDE.md'), '')
  const soulMd = readFileOr(join(dir, 'SOUL.md'), '')
  const tg = readAgentTelegramConfig(name)
  const dc = readAgentDiscordConfig(name)
  const hasClaudeMd = claudeMd.trim().length > 0
  const hasSoulMd = soulMd.trim().length > 0

  const proc = getAgentProcessInfo(name)

  return {
    name,
    displayName: readAgentDisplayName(name),
    description: extractDescriptionFromClaudeMd(claudeMd),
    model: readAgentModel(name),
    authMode: readAgentAuthMode(name),
    securityProfile: readAgentSecurityProfile(name),
    team: readAgentTeam(name),
    hasTelegram: tg.hasTelegram,
    telegramBotUsername: tg.botUsername,
    hasDiscord: dc.hasDiscord,
    status: hasClaudeMd && hasSoulMd ? 'configured' : 'draft',
    running: proc.running,
    session: proc.session,
    hasAvatar: findAvatarForAgent(name) !== null,
  }
}

function getAgentDetail(name: string): AgentDetail {
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
    claudeMd,
    soulMd,
    mcpJson,
    skills,
    hasAvatar: findAvatarForAgent(name) !== null,
    hasApiKey: getSecret(`agent-${name}-api-key`) !== null,
  }
}

function listAgentSummaries(): AgentSummary[] {
  return listAgentNames().map(getAgentSummary)
}

export async function tryHandleAgents(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path, method } = ctx

  // Lists every model the dashboard is willing to serve up to an agent.
  // Claude IDs are static. DeepSeek is gated behind a vault secret because
  // the agent-process launcher reads the key from there at start time --
  // surfacing the option in the UI without the key would let the operator
  // pick a model that 401s on first prompt. The frontend renders this list
  // both in the "new agent" wizard and the agent edit panel.
  if (path === '/api/models/available' && method === 'GET') {
    const hasDeepseek = getSecret('DEEPSEEK_API_KEY') !== null
    json(res, {
      claude: [
        { id: 'claude-opus-4-8', label: 'Opus 4.8 (legújabb)' },
        { id: 'claude-opus-4-7', label: 'Opus 4.7' },
        { id: 'claude-opus-4-6', label: 'Opus 4.6' },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (alapértelmezett)' },
        { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (leggyorsabb)' },
      ],
      deepseek: hasDeepseek
        ? [
            { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro (1M kontextus, erősebb)' },
            { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash (1M kontextus, gyorsabb/olcsóbb)' },
          ]
        : [],
      deepseekConfigured: hasDeepseek,
    })
    return true
  }

  if (path === '/api/agents' && method === 'GET') {
    json(res, listAgentSummaries())
    return true
  }

  if (path === '/api/agents' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    const { description, model: rawModel, profile: rawProfile } = data as { name: string; description: string; model?: string; profile?: string }
    const rawName = typeof data.name === 'string' ? data.name.trim() : ''
    const name = sanitizeAgentName(rawName)
    const model = resolveModelId(rawModel || DEFAULT_MODEL)
    const profileId = (rawProfile || 'default').trim() || 'default'

    if (!name) { json(res, { error: 'Name is required' }, 400); return true }
    if (!description) { json(res, { error: 'Description is required' }, 400); return true }
    if (existsSync(agentDir(name))) { json(res, { error: 'Agent already exists' }, 409); return true }

    scaffoldAgentDir(name)
    writeAgentModel(name, model)
    writeAgentSecurityProfile(name, profileId)
    writeAgentSettingsFromProfile(name, loadProfileTemplate(profileId))
    if (rawName && rawName !== name) writeAgentDisplayName(name, rawName)

    logger.info({ name, description }, 'Generating agent CLAUDE.md and SOUL.md...')
    try {
      const [claudeMd, soulMd] = await Promise.all([
        generateClaudeMd(name, description, model),
        generateSoulMd(name, description),
      ])
      atomicWriteFileSync(join(agentDir(name), 'CLAUDE.md'), claudeMd)
      atomicWriteFileSync(join(agentDir(name), 'SOUL.md'), soulMd)
      logger.info({ name }, 'Agent created successfully')

      const allAgents = listAgentNames()
      const runningAgents = allAgents.filter(a => a !== name && isAgentRunning(a))
      const notifyTargets = [MAIN_AGENT_ID, ...runningAgents]
      for (const target of notifyTargets) {
        createAgentMessage('system', target, `Uj csapattag erkezett: ${name}. Leirasa: ${description}. Udv neki ha legkozelebb beszeltek!`)
      }
    } catch (err) {
      rmSync(agentDir(name), { recursive: true, force: true })
      logger.error({ err, name }, 'Failed to generate agent files')
      json(res, { error: 'Failed to generate agent files' }, 500)
      return true
    }

    json(res, { ok: true, name })
    return true
  }

  const avatarUploadMatch = path.match(/^\/api\/agents\/([^/]+)\/avatar$/)
  if (avatarUploadMatch && method === 'POST') {
    const name = decodeURIComponent(avatarUploadMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }

    const body = await readBody(req)
    const contentType = req.headers['content-type'] || ''

    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const p = join(agentDir(name), `avatar${ext}`)
      if (existsSync(p)) unlinkSync(p)
    }

    if (contentType.includes('application/json')) {
      const { galleryAvatar } = JSON.parse(body.toString()) as { galleryAvatar: string }
      if (!galleryAvatar) { json(res, { error: 'No avatar specified' }, 400); return true }
      if (galleryAvatar.includes('..') || galleryAvatar.includes('/') || galleryAvatar.includes('\\')) {
        json(res, { error: 'Invalid avatar name' }, 400); return true
      }
      const srcPath = join(webDir, 'avatars', galleryAvatar)
      if (!existsSync(srcPath)) { json(res, { error: 'Avatar not found' }, 404); return true }
      const ext = extname(galleryAvatar) || '.png'
      const destPath = join(agentDir(name), `avatar${ext}`)
      copyFileSync(srcPath, destPath)
      sendAvatarChangeMessage(name, destPath).catch(() => {})
      json(res, { ok: true })
      return true
    } else {
      const { file } = parseMultipart(body, contentType)
      if (!file) { json(res, { error: 'No file uploaded' }, 400); return true }
      const ext = extname(file.name) || '.png'
      const destPath = join(agentDir(name), `avatar${ext}`)
      writeFileSync(destPath, file.data)
      sendAvatarChangeMessage(name, destPath).catch(() => {})
      json(res, { ok: true })
      return true
    }
  }

  if (avatarUploadMatch && method === 'GET') {
    const name = decodeURIComponent(avatarUploadMatch[1])
    const avatarPath = findAvatarForAgent(name)
    if (avatarPath) { serveFile(res, avatarPath); return true }
    res.writeHead(404); res.end()
    return true
  }

  // GET /api/agents/:name/channels/slack/manifest
  const manifestMatch = path.match(/^\/api\/agents\/([^/]+)\/channels\/slack\/manifest$/)
  if (manifestMatch && method === 'GET') {
    const name = decodeURIComponent(manifestMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
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
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
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
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
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
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }

    const body = await readBody(req)
    const { botToken, appToken } = JSON.parse(body.toString()) as { botToken: string; appToken?: string }
    if (!botToken?.trim()) { json(res, { error: 'botToken is required' }, 400); return true }

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

    const stateDir = channelStateDir(provider, agentDir(name))
    mkdirSync(stateDir, { recursive: true })
    const tokenKey = provider === 'slack' ? 'SLACK_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN'
    let envContent = `${tokenKey}=${botToken.trim()}\n`
    if (provider === 'slack' && appToken?.trim()) {
      envContent += `SLACK_APP_TOKEN=${appToken.trim()}\n`
    }
    atomicWriteFileSync(join(stateDir, '.env'), envContent, { mode: 0o600 })
    atomicWriteFileSync(join(stateDir, 'access.json'), JSON.stringify({
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: {},
      pending: {},
    }, null, 2))

    writeAgentChannelProvider(name, provider)
    setAgentEnabledPlugins(name, provider)

    if (provider === 'telegram') sendWelcomeMessage(name, botToken.trim()).catch(() => {})

    const wasRunning = isAgentRunning(name)
    let restarted = false
    if (wasRunning) {
      const stopRes = stopAgentProcess(name)
      if (stopRes.ok) {
        try { execSync('sleep 2', { timeout: 4000 }) } catch {}
        const startRes = startAgentProcess(name)
        restarted = startRes.ok
      }
    }

    json(res, { ok: true, botName: validation.botName, restarted, wasRunning })
    return true
  }

  // DELETE /api/agents/:name/channels/:provider (legacy: /telegram) -- remove
  if (setupMatch && method === 'DELETE') {
    const [name, provider] = setupMatch
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
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

  const secGetMatch = path.match(/^\/api\/agents\/([^/]+)\/security$/)
  if (secGetMatch && method === 'GET') {
    const name = decodeURIComponent(secGetMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const profileId = readAgentSecurityProfile(name)
    const profile = loadProfileTemplate(profileId)
    const placeholders = { HOME: homedir(), AGENT_DIR: agentDir(name) }
    json(res, {
      profile: profileId,
      label: profile.label,
      description: profile.description,
      permissionMode: profile.permissionMode,
      allow: profile.filesystem.allow.map(p => resolveProfilePlaceholders(p, placeholders)),
      deny: profile.filesystem.deny.map(p => resolveProfilePlaceholders(p, placeholders)),
    })
    return true
  }

  if (secGetMatch && method === 'PUT') {
    const name = decodeURIComponent(secGetMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { profile?: string }
    const requested = (data.profile || '').trim()
    if (!requested) { json(res, { error: 'profile is required' }, 400); return true }
    const profile = loadProfileTemplate(requested)
    if (profile.id !== requested) { json(res, { error: `Unknown profile: ${requested}` }, 400); return true }
    writeAgentSecurityProfile(name, requested)
    writeAgentSettingsFromProfile(name, profile)
    json(res, { ok: true, requiresRestart: isAgentRunning(name) })
    return true
  }

  if (path === '/api/team/graph' && method === 'GET') {
    const nodes: Array<{
      id: string
      label: string
      role: 'main' | 'leader' | 'member'
      reportsTo: string | null
      delegatesTo: string[]
      running?: boolean
      securityProfile?: string
    }> = []
    nodes.push({
      id: MAIN_AGENT_ID,
      label: BOT_NAME,
      role: 'main',
      reportsTo: null,
      delegatesTo: [],
      running: true,
    })
    for (const agentName of listAgentNames()) {
      const team = readAgentTeam(agentName)
      nodes.push({
        id: agentName,
        label: readAgentDisplayName(agentName),
        role: team.role,
        reportsTo: team.reportsTo,
        delegatesTo: team.delegatesTo,
        running: isAgentRunning(agentName),
        securityProfile: readAgentSecurityProfile(agentName),
      })
    }
    const knownIds = new Set(nodes.map(n => n.id))
    const edges: Array<{ from: string; to: string }> = []
    for (const n of nodes) {
      const reports = n.reportsTo && knownIds.has(n.reportsTo)
        ? n.reportsTo
        : (n.id === MAIN_AGENT_ID ? null : MAIN_AGENT_ID)
      if (reports) edges.push({ from: reports, to: n.id })
    }
    json(res, { nodes, edges, mainAgentId: MAIN_AGENT_ID })
    return true
  }

  const teamMatch = path.match(/^\/api\/agents\/([^/]+)\/team$/)
  if (teamMatch && method === 'GET') {
    const name = decodeURIComponent(teamMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    json(res, readAgentTeam(name))
    return true
  }

  if (teamMatch && method === 'PUT') {
    const name = decodeURIComponent(teamMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    const current = readAgentTeam(name)
    const proposed: TeamConfig = {
      role: data.role === 'leader' ? 'leader' : (data.role === 'member' ? 'member' : current.role),
      reportsTo: typeof data.reportsTo === 'string'
        ? (data.reportsTo.trim() || null)
        : (data.reportsTo === null ? null : current.reportsTo),
      delegatesTo: Array.isArray(data.delegatesTo)
        ? data.delegatesTo.filter((x: unknown) => typeof x === 'string')
        : current.delegatesTo,
      autoDelegation: typeof data.autoDelegation === 'boolean' ? data.autoDelegation : current.autoDelegation,
      trustFrom: Array.isArray(data.trustFrom)
        ? data.trustFrom.filter((x: unknown) => typeof x === 'string')
        : (current.trustFrom ?? []),
    }
    const { team: next, warnings } = sanitizeTeamConfig(name, proposed)
    writeAgentTeam(name, next)
    json(res, { ok: true, team: next, warnings })
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

    const body = await readBody(req)
    const { code } = JSON.parse(body.toString()) as { code: string }
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
      writeFileSync(join(approvedDir, entry.senderId), '')

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
    const items = listInvites(accessPath).map((inv) => ({
      ...inv,
      deepLink: provider === 'telegram' && botName
        ? `https://t.me/${botName}?start=invite-${inv.token}`
        : undefined,
    }))
    json(res, items)
    return true
  }

  // DELETE /api/agents/:name/channels/:provider/invites/:token (legacy: /telegram/invites/:token)
  const inviteRevokeNewMatch = path.match(/^\/api\/agents\/([^/]+)\/channels\/(telegram|slack|discord)\/invites\/(.+)$/)
  const inviteRevokeLegacyMatch = path.match(/^\/api\/agents\/([^/]+)\/telegram\/invites\/(.+)$/)
  const inviteRevokeMatch = inviteRevokeNewMatch
    ? { name: decodeURIComponent(inviteRevokeNewMatch[1]), provider: inviteRevokeNewMatch[2] as ChannelProviderType, token: decodeURIComponent(inviteRevokeNewMatch[3]) }
    : inviteRevokeLegacyMatch
      ? { name: decodeURIComponent(inviteRevokeLegacyMatch[1]), provider: 'telegram' as ChannelProviderType, token: decodeURIComponent(inviteRevokeLegacyMatch[2]) }
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

  // DELETE /api/agents/:name/channels/:provider/allowed/:type/:id (legacy: /telegram/allowed/:type/:id)
  const allowedRemoveNewMatch = path.match(/^\/api\/agents\/([^/]+)\/channels\/(telegram|slack|discord)\/allowed\/(user|group)\/(.+)$/)
  const allowedRemoveLegacyMatch = path.match(/^\/api\/agents\/([^/]+)\/telegram\/allowed\/(user|group)\/(.+)$/)
  const allowedRemoveMatch = allowedRemoveNewMatch
    ? { name: decodeURIComponent(allowedRemoveNewMatch[1]), provider: allowedRemoveNewMatch[2] as ChannelProviderType, kind: allowedRemoveNewMatch[3], id: decodeURIComponent(allowedRemoveNewMatch[4]) }
    : allowedRemoveLegacyMatch
      ? { name: decodeURIComponent(allowedRemoveLegacyMatch[1]), provider: 'telegram' as ChannelProviderType, kind: allowedRemoveLegacyMatch[2], id: decodeURIComponent(allowedRemoveLegacyMatch[3]) }
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
        const approvedFile = join(chDir, 'approved', id)
        try { if (existsSync(approvedFile)) unlinkSync(approvedFile) } catch { /* ignore */ }
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
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    json(res, listPendingChannelRequests(name))
    return true
  }

  const chReqApproveMatch = path.match(/^\/api\/agents\/([^/]+)\/channel-requests\/(\d+)\/approve$/)
  if (chReqApproveMatch && method === 'POST') {
    const name = decodeURIComponent(chReqApproveMatch[1])
    const reqId = Number(chReqApproveMatch[2])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }

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
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
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
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    if (!isAgentRunning(name)) { json(res, { error: 'Agent is not running' }, 400); return true }
    const session = agentSessionName(name)
    try {
      sendPromptToSession(session, '/login')
      // Wait for Claude Code to render the auth URL (typically 3-6s)
      let authUrl: string | null = null
      for (let i = 0; i < 12; i++) {
        execSync('sleep 1', { timeout: 3000 })
        const pane = capturePane(session)
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

  const startMatch = path.match(/^\/api\/agents\/([^/]+)\/start$/)
  if (startMatch && method === 'POST') {
    const name = decodeURIComponent(startMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const result = startAgentProcess(name)
    if (result.ok) { json(res, { ok: true }); return true }
    json(res, { error: result.error }, 400)
    return true
  }

  const stopMatch = path.match(/^\/api\/agents\/([^/]+)\/stop$/)
  if (stopMatch && method === 'POST') {
    const name = decodeURIComponent(stopMatch[1])
    const result = stopAgentProcess(name)
    if (result.ok) { json(res, { ok: true }); return true }
    json(res, { error: result.error }, 400)
    return true
  }

  const statusMatch = path.match(/^\/api\/agents\/([^/]+)\/status$/)
  if (statusMatch && method === 'GET') {
    const name = decodeURIComponent(statusMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    json(res, getAgentProcessInfo(name))
    return true
  }

  const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/)
  if (agentMatch && method === 'GET') {
    const name = decodeURIComponent(agentMatch[1])
    if (!isKnownAgent(name)) { json(res, { error: 'Agent not found' }, 404); return true }
    json(res, getAgentDetail(name))
    return true
  }

  if (agentMatch && method === 'PUT') {
    const name = decodeURIComponent(agentMatch[1])
    if (!isKnownAgent(name)) { json(res, { error: 'Agent not found' }, 404); return true }
    const body = await readBody(req)
    const configRoot = agentConfigRoot(name)
    const data = JSON.parse(body.toString()) as {
      claudeMd?: string; soulMd?: string; mcpJson?: string; model?: string
      authMode?: AuthMode; apiKey?: string
    }
    if (data.claudeMd !== undefined) atomicWriteFileSync(join(configRoot, 'CLAUDE.md'), data.claudeMd)
    if (data.soulMd !== undefined) atomicWriteFileSync(join(agentDir(name), 'SOUL.md'), data.soulMd)
    if (data.mcpJson !== undefined) atomicWriteFileSync(join(agentDir(name), '.mcp.json'), data.mcpJson)
    if (data.model !== undefined) writeAgentModel(name, data.model)
    if (data.authMode !== undefined) {
      writeAgentAuthMode(name, data.authMode)
      if (data.authMode === 'api' && typeof data.apiKey === 'string' && data.apiKey.trim()) {
        setSecret(`agent-${name}-api-key`, `API key for agent ${name}`, data.apiKey.trim())
      }
      if (data.authMode !== 'api') {
        deleteSecret(`agent-${name}-api-key`)
      }
    }
    json(res, { ok: true })
    return true
  }

  if (agentMatch && method === 'DELETE') {
    const name = decodeURIComponent(agentMatch[1])
    const dir = agentDir(name)
    if (!existsSync(dir)) { json(res, { error: 'Agent not found' }, 404); return true }
    rmSync(dir, { recursive: true, force: true })
    cleanupTeamReferences(name)
    json(res, { ok: true })
    return true
  }

  return false
}
