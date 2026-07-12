import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { CHANNEL_PROVIDER } from '../config.js'
import { channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { agentDir, listAgentNames, readAgentChannelProvider } from './agent-config.js'
import { upsertChannelRequest, listPendingChannelRequests, updateChannelRequestName } from '../db.js'
import { TOOL_TIMEOUTS } from '../tool-timeouts.js'

function resolveAgentProvider(name: string): ChannelProviderType {
  const perAgent = readAgentChannelProvider(name)
  if (perAgent === 'slack' || perAgent === 'telegram') return perAgent
  return CHANNEL_PROVIDER
}

interface AuditEntry {
  type?: string
  reason?: string
  channel?: string
  user?: string
  ts?: string
  botMentioned?: boolean
}

const fileOffsets = new Map<string, number>()

function scanAuditLog(agent: string, auditPath: string): void {
  if (!existsSync(auditPath)) return

  const buf = readFileSync(auditPath)
  const currentSize = buf.length
  const lastOffset = fileOffsets.get(auditPath) ?? 0
  if (currentSize <= lastOffset) return

  const newContent = buf.subarray(lastOffset).toString('utf-8')
  fileOffsets.set(auditPath, currentSize)

  for (const line of newContent.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as AuditEntry
      if (entry.type === 'gate.inbound.drop' && entry.reason === 'channel-not-allowed' && entry.botMentioned && entry.channel) {
        const inserted = upsertChannelRequest(agent, entry.channel, entry.user)
        if (inserted) {
          logger.info({ agent, channel: entry.channel, user: entry.user }, 'New channel request from audit log')
          lookupChannelName(agent, entry.channel).catch(() => {})
        }
      }
    } catch {
      // malformed line
    }
  }
}

const channelNameCache = new Map<string, { name: string | null; ts: number }>()
const CHANNEL_CACHE_TTL = 300_000
const NEGATIVE_CACHE_TTL = 60_000

async function lookupChannelName(agent: string, channelId: string): Promise<void> {
  const cached = channelNameCache.get(channelId)
  if (cached) {
    const ttl = cached.name ? CHANNEL_CACHE_TTL : NEGATIVE_CACHE_TTL
    if (Date.now() - cached.ts < ttl) return
  }

  const provider = resolveAgentProvider(agent)
  if (provider !== 'slack') return
  const stateDir = channelStateDir(provider, agentDir(agent))
  const token = readChannelToken(provider, join(stateDir, '.env'))
  if (!token) return

  try {
    const resp = await fetch('https://slack.com/api/conversations.info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${token}`,
      },
      body: `channel=${encodeURIComponent(channelId)}`,
      signal: AbortSignal.timeout(TOOL_TIMEOUTS['slack']),
    })
    const data = await resp.json() as { ok: boolean; channel?: { name: string } }
    if (data.ok && data.channel?.name) {
      channelNameCache.set(channelId, { name: data.channel.name, ts: Date.now() })
      const pending = listPendingChannelRequests(agent)
      const match = pending.find(r => r.channel_id === channelId && !r.channel_name)
      if (match) updateChannelRequestName(match.id, data.channel.name)
    }
  } catch (err) {
    channelNameCache.set(channelId, { name: null, ts: Date.now() })
    logger.warn({ err, agent, channelId }, 'Failed to look up Slack channel name')
  }
}

function runScanTick(): void {
  const activeAgents = new Set<string>()
  for (const name of listAgentNames()) {
    const provider = resolveAgentProvider(name)
    if (provider !== 'slack') continue
    const stateDir = channelStateDir(provider, agentDir(name))
    const auditPath = join(stateDir, 'audit.jsonl')
    activeAgents.add(auditPath)
    scanAuditLog(name, auditPath)
    for (const req of listPendingChannelRequests(name)) {
      if (!req.channel_name) lookupChannelName(name, req.channel_id).catch(() => {})
    }
  }
  for (const key of fileOffsets.keys()) {
    if (!activeAgents.has(key)) fileOffsets.delete(key)
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null

export function startChannelRequestWatcher(intervalMs = 10_000): void {
  if (intervalId) return
  runScanTick()
  intervalId = setInterval(runScanTick, intervalMs)
  logger.info({ intervalMs }, 'Channel request watcher started')
}

export function stopChannelRequestWatcher(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
