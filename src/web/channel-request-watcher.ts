import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { CHANNEL_PROVIDER } from '../config.js'
import { channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { agentDir, listAgentNames, readAgentChannelProvider } from './agent-config.js'
import { upsertChannelRequest, listPendingChannelRequests, updateChannelRequestName } from '../db.js'

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

  const currentSize = readFileSync(auditPath).length
  const lastOffset = fileOffsets.get(auditPath) ?? 0
  if (currentSize <= lastOffset) return

  const content = readFileSync(auditPath, 'utf-8')
  const newContent = content.slice(lastOffset)
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

async function lookupChannelName(agent: string, channelId: string): Promise<void> {
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
    })
    const data = await resp.json() as { ok: boolean; channel?: { name: string } }
    if (data.ok && data.channel?.name) {
      const pending = listPendingChannelRequests(agent)
      const match = pending.find(r => r.channel_id === channelId && !r.channel_name)
      if (match) updateChannelRequestName(match.id, data.channel.name)
    }
  } catch (err) {
    logger.warn({ err, agent, channelId }, 'Failed to look up Slack channel name')
  }
}

function runScanTick(): void {
  for (const name of listAgentNames()) {
    const provider = resolveAgentProvider(name)
    if (provider !== 'slack') continue
    const stateDir = channelStateDir(provider, agentDir(name))
    const auditPath = join(stateDir, 'audit.jsonl')
    scanAuditLog(name, auditPath)
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
