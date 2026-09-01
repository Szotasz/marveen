import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID, currentBotName } from '../../config.js'
import { getDb, countTaskRunsBetween } from '../../db.js'
import {
  agentDir, listAgentNames, readAgentDisplayName,
} from '../agent-config.js'
import { readAgentTeam } from '../agent-team.js'
import { isAgentRunning } from '../agent-process.js'
import { jsonMaybeGzip } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Count "real" user turns (operator prompts, Telegram messages) in every
// Claude Code session JSONL under ~/.claude/projects/. Filters out
// tool_result, local-command, and synthetic system events so a task-heavy
// hour doesn't inflate the counter.
function countUserTurns(fromMs: number, toMs: number = Number.POSITIVE_INFINITY): number {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return 0
  let total = 0
  try {
    for (const projectDir of readdirSync(root)) {
      const absDir = join(root, projectDir)
      let stat: ReturnType<typeof statSync>
      try { stat = statSync(absDir) } catch { continue }
      if (!stat.isDirectory()) continue
      for (const fname of readdirSync(absDir)) {
        if (!fname.endsWith('.jsonl')) continue
        const absFile = join(absDir, fname)
        let fstat: ReturnType<typeof statSync>
        try { fstat = statSync(absFile) } catch { continue }
        if (fstat.mtimeMs < fromMs) continue
        try {
          const data = readFileSync(absFile, 'utf-8')
          for (const line of data.split('\n')) {
            if (!line) continue
            let e: any
            try { e = JSON.parse(line) } catch { continue }
            if (e.type !== 'user' || e.isMeta) continue
            const ts = e.timestamp ? Date.parse(e.timestamp) : 0
            if (!ts || ts < fromMs || ts >= toMs) continue
            const content = e.message?.content
            if (typeof content === 'string') {
              if (content.startsWith('<local-command') || content.startsWith('<command-name>')) continue
              total++
            } else if (Array.isArray(content)) {
              const hasToolResult = content.some((b: any) => b && b.type === 'tool_result')
              if (hasToolResult) continue
              total++
            }
          }
        } catch { /* skip unreadable file */ }
      }
    }
  } catch { /* ignore */ }
  return total
}

// Estimate AI token cost in USD from token counts and model name.
// Uses approximate Anthropic public pricing; returns 0 for unknown models.
function estimateTokenCostUsd(inputTokens: number, outputTokens: number, model: string | null): number {
  const m = (model ?? '').toLowerCase()
  let inRate: number
  let outRate: number
  if (m.includes('opus')) {
    inRate = 15 / 1_000_000; outRate = 75 / 1_000_000
  } else if (m.includes('haiku')) {
    inRate = 0.25 / 1_000_000; outRate = 1.25 / 1_000_000
  } else {
    // sonnet and unknown models
    inRate = 3 / 1_000_000; outRate = 15 / 1_000_000
  }
  return inputTokens * inRate + outputTokens * outRate
}

export async function tryHandleOverview(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/overview' && method === 'GET') {
    const isAdmin = ctx.role === 'admin'
    // Admin: global view by default, optional ?tenant=<id> to narrow to one tenant.
    // Non-admin: always scoped to their own tenant.
    const effectiveTenantId: string | null = isAdmin
      ? (url.searchParams.get('tenant') ?? null)
      : (ctx.tenantId ?? 'default')
    const tc = effectiveTenantId ? ' AND tenant_id = ?' : ''
    const tp: string[] = effectiveTenantId ? [effectiveTenantId] : []

    const subAgents = listAgentNames()
    const running = subAgents.filter(n => isAgentRunning(n)).length + 1
    const total = subAgents.length + 1

    const db0 = getDb()
    const memStats = db0.prepare(`SELECT COUNT(*) as c FROM memories WHERE 1=1${tc}`).get(...tp) as { c: number }
    const memCats = db0.prepare(`SELECT COUNT(DISTINCT category) as c FROM memories WHERE 1=1${tc}`).get(...tp) as { c: number }
    let artifactCount = 0
    try {
      const aRow = db0.prepare(`SELECT COUNT(*) as c FROM artifacts WHERE 1=1${tc}`).get(...tp) as { c: number }
      artifactCount = aRow.c
    } catch { /* artifacts table absent on fresh installs before migration */ }

    const nowMs = Date.now()
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startTs = startOfDay.getTime()
    const yesterday = startTs - 24 * 60 * 60 * 1000
    const fourHoursAgo = nowMs - 4 * 60 * 60 * 1000

    const schedToday = countTaskRunsBetween(startTs)
    const schedYesterday = countTaskRunsBetween(yesterday, startTs)
    const userTurns = countUserTurns(startTs)
    const userTurnsPrev = countUserTurns(yesterday, startTs)
    const tasksToday = schedToday + userTurns
    const tasksYesterday = schedYesterday + userTurnsPrev

    let skillCount = 0
    let skillsToday = 0
    const skillsDir = join(homedir(), '.claude', 'skills')
    if (existsSync(skillsDir)) {
      for (const entry of readdirSync(skillsDir)) {
        const skillFile = join(skillsDir, entry, 'SKILL.md')
        if (existsSync(skillFile)) {
          skillCount++
          try {
            const mtime = statSync(skillFile).mtimeMs
            if (mtime >= startTs) skillsToday++
          } catch { /* ignore */ }
        }
      }
    }

    // Per-agent last-active timestamp from token_usage (ms epoch)
    const lastActiveMap = new Map<string, number>()
    try {
      const rows = db0.prepare(
        "SELECT agent, MAX(timestamp) as last_active FROM token_usage GROUP BY agent"
      ).all() as { agent: string; last_active: number }[]
      for (const r of rows) lastActiveMap.set(r.agent, r.last_active)
    } catch { /* ignore */ }

    // Daily token count and estimated USD cost from token_usage
    let tokensToday = 0
    let costTodayUsd = 0
    try {
      const startSec = Math.floor(startTs / 1000)
      const tokenRows = db0.prepare(
        "SELECT input_tokens, output_tokens, model FROM token_usage WHERE timestamp >= ?"
      ).all(startSec) as { input_tokens: number; output_tokens: number; model: string | null }[]
      for (const r of tokenRows) {
        tokensToday += r.input_tokens + r.output_tokens
        costTodayUsd += estimateTokenCostUsd(r.input_tokens, r.output_tokens, r.model)
      }
    } catch { /* ignore */ }

    // Pending approvals count
    let pendingApprovals = 0
    try {
      const pa = db0.prepare("SELECT COUNT(*) as c FROM approvals WHERE status='pending'").get() as { c: number }
      pendingApprovals = pa.c
    } catch { /* ignore */ }

    // Error/timeout spans in last 4h (start_ms is in milliseconds)
    let errors4h = 0
    try {
      const errRow = db0.prepare(
        "SELECT COUNT(*) as c FROM otel_spans WHERE status IN ('error','timeout') AND start_ms >= ?"
      ).get(fourHoursAgo) as { c: number }
      errors4h = errRow.c
    } catch { /* ignore */ }

    // Undelivered inter-agent messages (pending = not yet delivered to recipient session)
    let unreadMessages = 0
    try {
      const umRow = db0.prepare(`SELECT COUNT(*) as c FROM agent_messages WHERE status='pending'${tc}`).get(...tp) as { c: number }
      unreadMessages = umRow.c
    } catch { /* ignore */ }

    // Stuck scheduled tasks: active tasks whose next_run was more than 10 minutes ago
    let stuckTasks = 0
    try {
      const tenMinAgo = Math.floor((nowMs - 10 * 60 * 1000) / 1000)
      const stRow = db0.prepare(
        "SELECT COUNT(*) as c FROM scheduled_tasks WHERE status='active' AND next_run < ?"
      ).get(tenMinAgo) as { c: number }
      stuckTasks = stRow.c
    } catch { /* ignore */ }

    // Activity feed: last 4h, include agent_id for frontend filtering
    const activity: Array<{ icon: string; text: string; at: number; agent: string }> = []
    try {
      const fourHAgoSec = Math.floor(fourHoursAgo / 1000)
      const memRows = db0.prepare(
        `SELECT content, created_at, agent_id FROM memories WHERE created_at >= ?${tc} ORDER BY created_at DESC LIMIT 20`
      ).all(fourHAgoSec, ...tp) as { content: string; created_at: number; agent_id: string }[]
      for (const r of memRows) {
        activity.push({
          icon: 'memory',
          text: `${r.content.slice(0, 80)}${r.content.length > 80 ? '…' : ''}`,
          at: r.created_at * 1000,
          agent: r.agent_id,
        })
      }
    } catch { /* ignore */ }
    try {
      const fourHAgoSec = Math.floor(fourHoursAgo / 1000)
      const msgRows = db0.prepare(
        `SELECT from_agent, to_agent, content, created_at FROM agent_messages WHERE created_at >= ?${tc} ORDER BY created_at DESC LIMIT 15`
      ).all(fourHAgoSec, ...tp) as { from_agent: string; to_agent: string; content: string; created_at: number }[]
      for (const r of msgRows) {
        activity.push({
          icon: 'delegate',
          text: `→ ${r.to_agent}: ${r.content.slice(0, 60)}${r.content.length > 60 ? '…' : ''}`,
          at: r.created_at * 1000,
          agent: r.from_agent,
        })
      }
    } catch { /* ignore */ }
    try {
      const fourHAgoSec = Math.floor(fourHoursAgo / 1000)
      const aprRows = db0.prepare(
        `SELECT agent_id, action_description, status, created_at FROM approvals WHERE created_at >= ?${tc} ORDER BY created_at DESC LIMIT 10`
      ).all(fourHAgoSec, ...tp) as { agent_id: string; action_description: string; status: string; created_at: number }[]
      for (const r of aprRows) {
        activity.push({
          icon: 'approval',
          text: `[${r.status}] ${r.action_description.slice(0, 60)}${r.action_description.length > 60 ? '…' : ''}`,
          at: r.created_at * 1000,
          agent: r.agent_id,
        })
      }
    } catch { /* ignore */ }
    activity.sort((a, b) => b.at - a.at)

    // Build agents list with last_active timestamp
    const agentsForGrid: Array<{
      id: string; label: string; role: string; running: boolean;
      hasAvatar: boolean; avatarUrl: string; lastActive: number | null
    }> = []
    const mainHasAvatar = [
      join(STORE_DIR, 'marveen-avatar.png'),
      join(STORE_DIR, 'marveen-avatar.jpg'),
    ].some(existsSync)
    agentsForGrid.push({
      id: MAIN_AGENT_ID,
      label: currentBotName(),
      role: 'main',
      running: true,
      hasAvatar: mainHasAvatar,
      avatarUrl: `/api/marveen/avatar`,
      lastActive: lastActiveMap.get(MAIN_AGENT_ID) ?? null,
    })
    for (const a of subAgents) {
      const team = readAgentTeam(a)
      agentsForGrid.push({
        id: a,
        label: readAgentDisplayName(a),
        role: team.role,
        running: isAgentRunning(a),
        hasAvatar: existsSync(join(agentDir(a), 'avatar.png')),
        avatarUrl: `/api/agents/${encodeURIComponent(a)}/avatar`,
        lastActive: lastActiveMap.get(a) ?? null,
      })
    }

    jsonMaybeGzip(req, res, {
      // Tenant-scoped: visible to all authenticated callers.
      memories: { count: memStats.c, categories: memCats.c },
      unreadMessages,
      activity: activity.slice(0, 30),
      // Fleet-level: omitted entirely for non-admin callers.
      // A non-admin caller must not learn the fleet's internal structure
      // (agent list, token cost, task counts, etc.).
      ...(isAdmin && {
        agents: { total, running, list: agentsForGrid },
        tasksToday,
        tasksYesterday,
        artifacts: { count: artifactCount },
        skills: { count: skillCount, today: skillsToday },
        tokensToday,
        costTodayUsd: Math.round(costTodayUsd * 10000) / 10000,
        pendingApprovals,
        errors4h,
        stuckTasks,
      }),
    })
    return true
  }

  return false
}
