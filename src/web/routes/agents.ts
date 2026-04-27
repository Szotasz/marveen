import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'
import { logger } from '../../logger.js'
import { MAIN_AGENT_ID, BOT_NAME } from '../../config.js'
import { createAgentMessage } from '../../db.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import {
  agentDir,
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
  sendAvatarChangeMessage,
  sendWelcomeMessage,
  validateTelegramToken,
  parseTelegramToken,
} from '../telegram.js'
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
} from '../agent-process.js'
import {
  loadProfileTemplate,
  resolveProfilePlaceholders,
} from '../profiles.js'
import { sanitizeAgentName } from '../sanitize.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json, serveFile } from '../http-helpers.js'
import type { RouteContext } from './types.js'

interface AgentSummary {
  name: string
  displayName: string
  description: string
  model: string
  securityProfile: string
  team: TeamConfig
  hasTelegram: boolean
  telegramBotUsername?: string
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
}

function getAgentSummary(name: string): AgentSummary {
  const dir = agentDir(name)
  const claudeMd = readFileOr(join(dir, 'CLAUDE.md'), '')
  const soulMd = readFileOr(join(dir, 'SOUL.md'), '')
  const tg = readAgentTelegramConfig(name)
  const hasClaudeMd = claudeMd.trim().length > 0
  const hasSoulMd = soulMd.trim().length > 0

  const proc = getAgentProcessInfo(name)

  return {
    name,
    displayName: readAgentDisplayName(name),
    description: extractDescriptionFromClaudeMd(claudeMd),
    model: readAgentModel(name),
    securityProfile: readAgentSecurityProfile(name),
    team: readAgentTeam(name),
    hasTelegram: tg.hasTelegram,
    telegramBotUsername: tg.botUsername,
    status: hasClaudeMd && hasSoulMd ? 'configured' : 'draft',
    running: proc.running,
    session: proc.session,
    hasAvatar: findAvatarForAgent(name) !== null,
  }
}

function getAgentDetail(name: string): AgentDetail {
  const dir = agentDir(name)
  const summary = getAgentSummary(name)
  const claudeMd = readFileOr(join(dir, 'CLAUDE.md'), '')
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
  }
}

function listAgentSummaries(): AgentSummary[] {
  return listAgentNames().map(getAgentSummary)
}

export async function tryHandleAgents(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path, method } = ctx

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

  const tgTestMatch = path.match(/^\/api\/agents\/([^/]+)\/telegram\/test$/)
  if (tgTestMatch && method === 'POST') {
    const name = decodeURIComponent(tgTestMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const token = parseTelegramToken(name)
    if (!token) { json(res, { error: 'Telegram not configured for this agent' }, 404); return true }
    const result = await validateTelegramToken(token)
    if (result.ok) { json(res, { ok: true, botUsername: result.botUsername, botId: result.botId }); return true }
    json(res, { error: result.error }, 400)
    return true
  }

  const tgSetupMatch = path.match(/^\/api\/agents\/([^/]+)\/telegram$/)
  if (tgSetupMatch && method === 'POST') {
    const name = decodeURIComponent(tgSetupMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }

    const body = await readBody(req)
    const { botToken } = JSON.parse(body.toString()) as { botToken: string }
    if (!botToken?.trim()) { json(res, { error: 'botToken is required' }, 400); return true }

    const validation = await validateTelegramToken(botToken.trim())
    if (!validation.ok) { json(res, { error: validation.error || 'Invalid bot token' }, 400); return true }

    const tgDir = join(agentDir(name), '.claude', 'channels', 'telegram')
    mkdirSync(tgDir, { recursive: true })
    atomicWriteFileSync(join(tgDir, '.env'), `TELEGRAM_BOT_TOKEN=${botToken.trim()}\n`, { mode: 0o600 })
    atomicWriteFileSync(join(tgDir, 'access.json'), JSON.stringify({
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: {},
      pending: {},
    }, null, 2))

    sendWelcomeMessage(name, botToken.trim()).catch(() => {})

    // If the agent is running, the already-started bun poller is still using
    // the OLD token. Restart it so the new token actually goes live.
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

    json(res, { ok: true, botUsername: validation.botUsername, botId: validation.botId, restarted, wasRunning })
    return true
  }

  if (tgSetupMatch && method === 'DELETE') {
    const name = decodeURIComponent(tgSetupMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const tgDir = join(agentDir(name), '.claude', 'channels', 'telegram')
    const envFile = join(tgDir, '.env')
    const accessFile = join(tgDir, 'access.json')
    if (existsSync(envFile)) unlinkSync(envFile)
    if (existsSync(accessFile)) unlinkSync(accessFile)
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

  const tgPendingMatch = path.match(/^\/api\/agents\/([^/]+)\/telegram\/pending$/)
  if (tgPendingMatch && method === 'GET') {
    const name = decodeURIComponent(tgPendingMatch[1])
    const accessPath = name === MAIN_AGENT_ID
      ? join(homedir(), '.claude', 'channels', 'telegram', 'access.json')
      : join(agentDir(name), '.claude', 'channels', 'telegram', 'access.json')
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }
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

  const tgApproveMatch = path.match(/^\/api\/agents\/([^/]+)\/telegram\/approve$/)
  if (tgApproveMatch && method === 'POST') {
    const name = decodeURIComponent(tgApproveMatch[1])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }

    const body = await readBody(req)
    const { code } = JSON.parse(body.toString()) as { code: string }
    if (!code?.trim()) { json(res, { error: 'Code is required' }, 400); return true }

    const tgDir = name === MAIN_AGENT_ID
      ? join(homedir(), '.claude', 'channels', 'telegram')
      : join(agentDir(name), '.claude', 'channels', 'telegram')
    const accessPath = join(tgDir, 'access.json')
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

      // Pairing is one-shot; lock the channel down to allowlist mode now that
      // we have the sender's id. Matches what install.sh does for the main
      // agent after the first pairing completes.
      access.dmPolicy = 'allowlist'

      atomicWriteFileSync(accessPath, JSON.stringify(access, null, 2))

      const approvedDir = join(tgDir, 'approved')
      mkdirSync(approvedDir, { recursive: true })
      writeFileSync(join(approvedDir, entry.senderId), '')

      logger.info({ name, senderId: entry.senderId, code }, 'Telegram pairing approved')
      json(res, { ok: true, senderId: entry.senderId })
    } catch (err) {
      logger.error({ err }, 'Failed to approve pairing')
      json(res, { error: 'Failed to approve pairing' }, 500)
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
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    json(res, getAgentDetail(name))
    return true
  }

  if (agentMatch && method === 'PUT') {
    const name = decodeURIComponent(agentMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { claudeMd?: string; soulMd?: string; mcpJson?: string; model?: string }
    if (data.claudeMd !== undefined) atomicWriteFileSync(join(agentDir(name), 'CLAUDE.md'), data.claudeMd)
    if (data.soulMd !== undefined) atomicWriteFileSync(join(agentDir(name), 'SOUL.md'), data.soulMd)
    if (data.mcpJson !== undefined) atomicWriteFileSync(join(agentDir(name), '.mcp.json'), data.mcpJson)
    if (data.model !== undefined) writeAgentModel(name, data.model)
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
