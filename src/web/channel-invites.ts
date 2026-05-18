// Channel invite tokens for one-click pairing.
//
// Flow:
// 1. Operator generates an invite via POST /api/agents/:name/channels/:provider/invites.
//    The token + expiry is stored in access.json under `invites`.
//    If dmPolicy was 'allowlist', it is flipped to 'pairing' so the bot will
//    actually issue codes for unknown senders during the validity window.
// 2. The invitee opens the deep-link (Telegram: t.me/?start=TOKEN, Slack: CLI pair),
//    the plugin creates a pending entry in access.json (standard pairing behaviour).
// 3. This monitor (started in src/index.ts) polls access.json files every
//    few seconds. When it sees a pending entry land while at least one
//    non-used, non-expired invite token exists for that agent, it
//    auto-approves the entry: marks the token used, moves the senderId
//    into allowFrom, drops the pending row, restores allowlist policy if
//    no other invites are still active.
//
// The invite-token is a "shared secret" that grants exactly one auto-approve.
// Tokens are 16 random bytes (base64url, ~22 chars), unguessable in practice.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { logger } from '../logger.js'
import { channelStateDir, type ChannelProviderType } from '../channel-provider.js'
import { agentDir } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'

interface InviteEntry {
  createdAt: number
  expiresAt: number
  used: boolean
  usedBy?: string
  usedAt?: number
}

interface AccessFile {
  dmPolicy?: 'pairing' | 'allowlist' | 'disabled'
  allowFrom?: string[]
  groups?: Record<string, unknown>
  pending?: Record<string, { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies?: number }>
  invites?: Record<string, InviteEntry>
}

const INVITE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export function agentChannelDir(name: string, mainAgentId: string, provider: ChannelProviderType): string {
  return name === mainAgentId
    ? channelStateDir(provider)
    : channelStateDir(provider, agentDir(name))
}

function readAccess(path: string): AccessFile {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AccessFile
  } catch {
    return {}
  }
}

function writeAccess(path: string, data: AccessFile): void {
  mkdirSync(join(path, '..'), { recursive: true })
  atomicWriteFileSync(path, JSON.stringify(data, null, 2))
}

function pruneInvites(access: AccessFile, now: number): boolean {
  if (!access.invites) return false
  let mutated = false
  for (const [token, inv] of Object.entries(access.invites)) {
    if (inv.expiresAt < now && !inv.used) {
      delete access.invites[token]
      mutated = true
    }
  }
  return mutated
}

function activeInviteCount(access: AccessFile, now: number): number {
  if (!access.invites) return 0
  let n = 0
  for (const inv of Object.values(access.invites)) {
    if (!inv.used && inv.expiresAt >= now) n++
  }
  return n
}

export interface CreateInviteResult {
  token: string
  expiresAt: number
  deepLink?: string
}

export function createInvite(
  accessPath: string,
  botUsername: string | undefined,
  provider: ChannelProviderType = 'telegram',
  ttlMs: number = INVITE_DEFAULT_TTL_MS,
): CreateInviteResult {
  const access = readAccess(accessPath)
  const now = Date.now()
  pruneInvites(access, now)

  const token = randomBytes(16).toString('base64url').slice(0, 22)
  const entry: InviteEntry = {
    createdAt: now,
    expiresAt: now + ttlMs,
    used: false,
  }
  access.invites = access.invites || {}
  access.invites[token] = entry

  if (access.dmPolicy !== 'disabled') access.dmPolicy = 'pairing'

  writeAccess(accessPath, access)

  let deepLink: string | undefined
  if (provider === 'telegram' && botUsername) {
    deepLink = `https://t.me/${botUsername}?start=invite-${token}`
  }
  return { token, expiresAt: entry.expiresAt, deepLink }
}

export function listInvites(accessPath: string): Array<{ token: string; createdAt: number; expiresAt: number; used: boolean; usedBy?: string; deepLink?: string }> {
  const access = readAccess(accessPath)
  const now = Date.now()
  if (pruneInvites(access, now)) writeAccess(accessPath, access)
  if (!access.invites) return []
  return Object.entries(access.invites).map(([token, inv]) => ({
    token,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    used: inv.used,
    usedBy: inv.usedBy,
  }))
}

export function revokeInvite(accessPath: string, token: string): boolean {
  const access = readAccess(accessPath)
  if (!access.invites?.[token]) return false
  delete access.invites[token]
  if (activeInviteCount(access, Date.now()) === 0) {
    access.dmPolicy = 'allowlist'
  }
  writeAccess(accessPath, access)
  return true
}

export function runInviteMonitorTick(mainAgentId: string, agentsRoot: string): void {
  const providerTypes: ChannelProviderType[] = ['telegram', 'slack']

  for (const provider of providerTypes) {
    const targets: Array<{ name: string; accessPath: string }> = []
    const mainAccess = join(channelStateDir(provider), 'access.json')
    if (existsSync(mainAccess)) targets.push({ name: mainAgentId, accessPath: mainAccess })
    if (existsSync(agentsRoot)) {
      let entries: string[]
      try { entries = readdirSync(agentsRoot) } catch { entries = [] }
      for (const e of entries) {
        const p = join(channelStateDir(provider, join(agentsRoot, e)), 'access.json')
        if (existsSync(p)) targets.push({ name: e, accessPath: p })
      }
    }

    for (const { name, accessPath } of targets) {
      const access = readAccess(accessPath)
      if (!access.invites || !access.pending) continue

      const now = Date.now()
      const expiredOrUsed = pruneInvites(access, now)

      const live = Object.entries(access.invites)
        .filter(([, inv]) => !inv.used && inv.expiresAt >= now)
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
      if (live.length === 0) {
        if (expiredOrUsed && activeInviteCount(access, now) === 0 && access.dmPolicy === 'pairing') {
          access.dmPolicy = 'allowlist'
          writeAccess(accessPath, access)
        }
        continue
      }

      const pendingEntries = Object.entries(access.pending)
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
      if (pendingEntries.length === 0) continue

      const [pCode, pEntry] = pendingEntries[0]
      const [tToken, tEntry] = live[0]

      if (!access.allowFrom) access.allowFrom = []
      if (!access.allowFrom.includes(pEntry.senderId)) access.allowFrom.push(pEntry.senderId)
      delete access.pending[pCode]

      tEntry.used = true
      tEntry.usedBy = pEntry.senderId
      tEntry.usedAt = now

      if (activeInviteCount(access, now) === 0) access.dmPolicy = 'allowlist'

      try {
        const approvedDir = join(accessPath, '..', 'approved')
        mkdirSync(approvedDir, { recursive: true })
        writeFileSync(join(approvedDir, pEntry.senderId), '')
      } catch (err) {
        logger.warn({ err, name, senderId: pEntry.senderId }, 'invite-monitor: failed to write approved marker')
      }

      writeAccess(accessPath, access)
      logger.info({ name, provider, senderId: pEntry.senderId, token: tToken }, 'Channel invite auto-approved')
    }
  }
}

let inviteMonitorInterval: NodeJS.Timeout | null = null

export function startInviteMonitor(mainAgentId: string, agentsRoot: string, intervalMs = 3000): void {
  if (inviteMonitorInterval) return
  try { runInviteMonitorTick(mainAgentId, agentsRoot) } catch (err) {
    logger.error({ err }, 'invite-monitor first tick failed')
  }
  inviteMonitorInterval = setInterval(() => {
    try {
      runInviteMonitorTick(mainAgentId, agentsRoot)
    } catch (err) {
      logger.error({ err }, 'invite-monitor tick failed')
    }
  }, intervalMs)
  logger.info({ intervalMs }, 'Channel invite monitor started')
}

export function stopInviteMonitor(): void {
  if (inviteMonitorInterval) {
    clearInterval(inviteMonitorInterval)
    inviteMonitorInterval = null
  }
}
