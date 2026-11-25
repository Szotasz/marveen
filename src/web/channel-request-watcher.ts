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

/**
 * The channel request one audit line asks for, or null.
 *
 * The slack-channel plugin's journal record (audit.jsonl, SLACK_AUDIT_LOG) is
 * `{"kind":"gate.inbound.drop","reason":...,"input":{"channel","user","botMentioned"}}`;
 * the plugin writes `reason` and `botMentioned` since DROPREASON1124
 * (Szotasz/claude-code-slack-channel#13). Before that a drop carried neither, so
 * this watcher, which only knew a flat `{"type":...,"channel":...}` shape that the
 * plugin never wrote, matched nothing (measured 2026-11-24: the Channel Requests
 * list stayed empty). The flat shape is still accepted.
 */
export function channelRequestFromAuditLine(line: string): { channel: string; user?: string } | null {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  const input = e.input && typeof e.input === 'object' ? (e.input as Record<string, unknown>) : {}
  const kind = e.kind ?? e.type
  const channel = input.channel ?? e.channel
  const user = input.user ?? e.user
  const botMentioned = input.botMentioned ?? e.botMentioned
  if (kind !== 'gate.inbound.drop' || e.reason !== 'channel-not-allowed' || botMentioned !== true) return null
  if (typeof channel !== 'string' || !channel) return null
  return { channel, user: typeof user === 'string' ? user : undefined }
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
    const req = channelRequestFromAuditLine(line)
    if (!req) continue
    try {
      const inserted = upsertChannelRequest(agent, req.channel, req.user)
      if (inserted) {
        logger.info({ agent, channel: req.channel, user: req.user }, 'New channel request from audit log')
        lookupChannelName(agent, req.channel).catch(() => {})
      }
    } catch (err) {
      logger.warn({ err, agent, channel: req.channel }, 'Channel request from audit log not stored')
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
