// /queue and /runs collectors (CMD920 3.6, 3.7 -- read side only).
//
// /queue: what waits for the owner first (it is what stands still), what
// starts by itself last. Every block is fault-isolated, and an empty block is
// printed as "nincs": a vanished block would suggest such rows do not exist.
//
// /runs: the running round is MEASURED from the transcript, not guessed from
// pane text -- the last real prompt, the tool calls since, and every unpaired
// tool_use (no tool_result yet). A Task's sub-agent works in its own
// transcript (<session>/subagents/*.jsonl); its open calls are listed one
// level deeper.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import {
  getDb,
  listApprovals,
  listPendingTaskRetries,
  getDispatchedPendingStats,
} from '../db.js'
import { projectsDirFor } from './active-model.js'
import { configDirFor } from './main-transcript-root.js'
import { readGateConfig } from './context-restart-gate-store.js'
import { listScheduledTasks } from './scheduled-tasks-io.js'
import { computeNextRun } from './cron.js'
import { formatDayClock, formatDuration, formatSpan } from './system-status.js'
import { openQuestionIgnoringCommands } from './open-question.js'

export const MAX_LISTED_CALLS = 5

export interface QueueBlock {
  title: string
  lines: string[]
  error?: string
}

export function formatBlocks(blocks: QueueBlock[]): string {
  const out: string[] = []
  for (const b of blocks) {
    if (out.length) out.push('')
    out.push(b.title)
    if (b.error) out.push(`hiba (${b.error})`)
    else if (b.lines.length === 0) out.push('nincs')
    else out.push(...b.lines)
  }
  return out.join('\n')
}

export function collectBlock(title: string, fn: () => string[]): QueueBlock {
  try {
    return { title, lines: fn() }
  } catch (err) {
    return { title, lines: [], error: err instanceof Error ? err.message : String(err) }
  }
}

function msOf(v: number): number {
  return v > 1e12 ? v : v * 1000
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

// ---- transcript: the running round -----------------------------------------

const SECRETISH = /((?:token|secret|password|passwd|api[_-]?key|authorization)\s*[=:]\s*)(\S+)/gi

export function callPreview(name: string, input: unknown): string {
  let s = ''
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    const pick = o.command ?? o.file_path ?? o.pattern ?? o.description ?? o.prompt ?? o.url
      ?? Object.values(o).find(v => typeof v === 'string')
    if (typeof pick === 'string') s = pick
  }
  s = s.replace(SECRETISH, '$1[REDACTED]')
  return s ? `${name}: ${clip(s, 60)}` : name
}

export interface OpenCall {
  id: string
  name: string
  preview: string
  at: number | null
  /** Open calls inside this call's sub-agent transcript (Task / Agent). */
  children: OpenCall[]
}

export interface RoundSummary {
  /** true when the last turn ended and nothing is pending. */
  idle: boolean
  prompt: string | null
  promptAt: number | null
  toolCalls: number
  open: OpenCall[]
  messageSent: boolean
}

interface Entry {
  type?: string
  isMeta?: boolean
  timestamp?: string
  message?: { role?: string; content?: unknown; stop_reason?: string | null }
}

function parseLines(lines: string[]): Entry[] {
  const out: Entry[] = []
  for (const l of lines) {
    const t = l.trim()
    if (!t) continue
    try { out.push(JSON.parse(t) as Entry) } catch { /* malformed line */ }
  }
  return out
}

function blocksOf(e: Entry): Array<Record<string, unknown>> {
  const c = e.message?.content
  return Array.isArray(c) ? c.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object') : []
}

function promptTextOf(e: Entry): string | null {
  if (e.type !== 'user' || e.isMeta) return null
  const c = e.message?.content
  if (typeof c === 'string') return c
  const blocks = blocksOf(e)
  if (blocks.some(b => b.type === 'tool_result')) return null
  const text = blocks.find(b => b.type === 'text' && typeof b.text === 'string')
  return text ? String(text.text) : null
}

const SENDING_TOOLS = /(^|__)(reply|notifyChannel|send_message|sendMessage)$/

// Pure: summarize the current (last) round of a transcript.
export function summarizeRound(lines: string[], subagentLines: Record<string, string[]> = {}): RoundSummary {
  const entries = parseLines(lines)
  let start = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (promptTextOf(entries[i]) !== null) { start = i; break }
  }
  const round = start >= 0 ? entries.slice(start) : entries
  const uses = new Map<string, { name: string; input: unknown; at: number | null }>()
  const results = new Set<string>()
  let toolCalls = 0
  let messageSent = false
  for (const e of round) {
    for (const b of blocksOf(e)) {
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        toolCalls++
        const name = typeof b.name === 'string' ? b.name : '?'
        if (SENDING_TOOLS.test(name)) messageSent = true
        const at = e.timestamp ? Date.parse(e.timestamp) : NaN
        uses.set(b.id, { name, input: b.input, at: Number.isFinite(at) ? at : null })
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        results.add(b.tool_use_id)
      }
    }
  }
  const open: OpenCall[] = []
  for (const [id, u] of uses) {
    if (results.has(id)) continue
    const children: OpenCall[] = []
    if (u.name === 'Task' || u.name === 'Agent') {
      for (const sub of Object.values(subagentLines)) {
        children.push(...summarizeRound(sub).open)
      }
    }
    open.push({ id, name: u.name, preview: callPreview(u.name, u.input), at: u.at, children })
  }
  const last = [...entries].reverse().find(e => e.type === 'assistant')
  const lastStop = last?.message?.stop_reason ?? null
  const idle = open.length === 0 && (lastStop === 'end_turn' || lastStop === 'stop_sequence' || start < 0)
  const promptAt = start >= 0 && entries[start].timestamp ? Date.parse(entries[start].timestamp!) : NaN
  return {
    idle,
    prompt: start >= 0 ? promptTextOf(entries[start]) : null,
    promptAt: Number.isFinite(promptAt) ? promptAt : null,
    toolCalls,
    open,
    messageSent,
  }
}

export function formatOpenCalls(calls: OpenCall[], now: number, indent = ''): string[] {
  const out: string[] = []
  for (const c of calls.slice(0, MAX_LISTED_CALLS)) {
    const age = c.at !== null ? ` (${formatDuration(Math.floor((now - c.at) / 1000))})` : ''
    out.push(`${indent}- ${c.preview}${age}`)
    if (c.children.length) out.push(...formatOpenCalls(c.children, now, `${indent}  `))
  }
  if (calls.length > MAX_LISTED_CALLS) out.push(`${indent}+${calls.length - MAX_LISTED_CALLS} további`)
  return out
}

function mainTranscript(): { file: string; subagents: Record<string, string[]> } | null {
  const dir = projectsDirFor(PROJECT_ROOT, configDirFor(MAIN_AGENT_ID))
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  if (!files.length) return null
  const file = join(dir, files[0].f)
  const subDir = join(dir, basename(files[0].f, '.jsonl'), 'subagents')
  const subagents: Record<string, string[]> = {}
  if (existsSync(subDir)) {
    const cutoff = Date.now() - 6 * 3600_000
    for (const f of readdirSync(subDir)) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(subDir, f)
      if (statSync(p).mtimeMs < cutoff) continue
      subagents[f] = readFileSync(p, 'utf-8').split('\n')
    }
  }
  return { file, subagents }
}

export function readMainRound(): RoundSummary | null {
  const t = mainTranscript()
  if (!t) return null
  return summarizeRound(readFileSync(t.file, 'utf-8').split('\n'), t.subagents)
}

export interface InFlightTaskRun {
  name: string
  agent: string
  ts: number
}

export function listInFlightTaskRuns(now = Date.now()): InFlightTaskRun[] {
  return getDb().prepare(
    `SELECT name, agent, ts FROM task_runs
      WHERE completed_at IS NULL AND status IN ('fired','fired_late') AND ts >= ?
      ORDER BY ts DESC`,
  ).all(now - 24 * 3600_000) as InFlightTaskRun[]
}

export interface RunsView {
  main: RoundSummary | null
  tasks: InFlightTaskRun[]
}

export function collectRuns(now = Date.now()): RunsView {
  return { main: readMainRound(), tasks: listInFlightTaskRuns(now) }
}

function mainRoundLine(r: RoundSummary | null, now: number): string {
  if (!r) return 'fő session: nem mérhető (nincs transzkript)'
  if (r.idle) return 'fő session: tétlen, nincs futó kör'
  const since = r.promptAt !== null ? `, ${formatDuration(Math.floor((now - r.promptAt) / 1000))}` : ''
  return `fő session: fut${since} · ${r.toolCalls} hívás · ${r.open.length} nyitott · üzenet ${r.messageSent ? 'ment ki' : 'még nem ment ki'} · „${clip(r.prompt ?? '', 50)}”`
}

export function formatRunsList(v: RunsView, now = Date.now()): string {
  const lines = [`1. ${mainRoundLine(v.main, now)}`]
  v.tasks.forEach((t, i) => {
    lines.push(`${i + 2}. ${t.name} (${t.agent}) · indítva ${formatDayClock(t.ts)}, ${formatDuration(Math.floor((now - t.ts) / 1000))} · nincs lezárva`)
  })
  if (v.tasks.length === 0) lines.push('ütemezett kör: nincs nyitott')
  lines.push('', 'Részletek: /runs <n>')
  return lines.join('\n')
}

export function formatRunDetail(v: RunsView, n: number, now = Date.now()): string {
  if (n === 1) {
    const r = v.main
    const head = mainRoundLine(r, now)
    if (!r || r.idle) return head
    const out = [head, '', `Prompt: ${clip(r.prompt ?? '', 300)}`, '', 'Futó hívások:']
    out.push(...(r.open.length ? formatOpenCalls(r.open, now) : ['nincs']))
    return out.join('\n')
  }
  const t = v.tasks[n - 2]
  if (!t) return `Nincs ${n}. kör. Lásd /runs.`
  return [
    `${t.name} (${t.agent})`,
    `indítva ${formatDayClock(t.ts)}, ${formatDuration(Math.floor((now - t.ts) / 1000))}`,
    'kimenet: még nincs lezárva (task_runs)',
    t.agent === MAIN_AGENT_ID ? 'a fő session futó hívásai: /runs 1' : 'az ágens transzkriptje itt nem olvasott',
  ].join('\n')
}

// ---- /queue -----------------------------------------------------------------

export function collectQueue(now = Date.now()): QueueBlock[] {
  const nowSec = Math.floor(now / 1000)
  return [
    collectBlock('VÁLASZRA VÁRÓ KÉRDÉS', () => {
      const id = openQuestionIgnoringCommands(MAIN_AGENT_ID)
      return id === null ? [] : [`nyitott bejövő kérdés (üzenet ${id})`]
    }),
    collectBlock('JÓVÁHAGYÁS', () => listApprovals({ status: 'pending', limit: 20 }).map(a => {
      const win = a.timeout_at === null ? 'ablak nélkül'
        : a.timeout_at <= nowSec ? 'LEJÁRT' : `még ${formatSpan(a.timeout_at - nowSec)}`
      return `${a.id.slice(0, 8)} · ${a.category} · ${clip(a.action_description, 60)} · ${win}`
    })),
    collectBlock('INBOX (fő ágens)', () => {
      const r = getDb().prepare(
        `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM agent_messages WHERE to_agent = ? AND status = 'pending'`,
      ).get(MAIN_AGENT_ID) as { n: number; oldest: number | null }
      return r.n > 0 ? [`${r.n} feldolgozatlan üzenet, legrégebbi ${formatDayClock(msOf(r.oldest ?? 0))}`] : []
    }),
    collectBlock('INTER-AGENT (válaszra vár)', () => {
      const gate = readGateConfig(MAIN_AGENT_ID)
      const s = getDispatchedPendingStats(MAIN_AGENT_ID, now, gate.staleCutoffMs)
      if (s.count === 0 && !s.hasStale) return []
      return [`${s.count} kiküldött üzenet válaszra vár${s.hasStale ? ' (és van elavult is)' : ''}`]
    }),
    collectBlock('FOLYAMATBAN', () => {
      const v = collectRuns(now)
      const lines: string[] = []
      if (v.main && !v.main.idle) lines.push(mainRoundLine(v.main, now))
      for (const t of v.tasks) lines.push(`${t.name} (${t.agent}) · ${formatDuration(Math.floor((now - t.ts) / 1000))}`)
      return lines
    }),
    collectBlock('ÚJRAPRÓBÁLÁS', () => listPendingTaskRetries().map(r =>
      `${r.task_name} (${r.agent_name}) · ${r.attempt_count}. próba · utolsó ${formatDayClock(msOf(r.last_attempt))}${r.last_reason ? ` · ${clip(r.last_reason, 60)}` : ''}`,
    )),
    collectBlock('ÜTEMEZETT (következő 5)', () => {
      const next: Array<{ name: string; at: number }> = []
      for (const t of listScheduledTasks()) {
        if (!t.enabled) continue
        try { next.push({ name: t.name, at: computeNextRun(t.schedule) * 1000 }) } catch { /* invalid cron */ }
      }
      return next.sort((a, b) => a.at - b.at).slice(0, 5).map(x => `${formatDayClock(x.at)} ${x.name}`)
    }),
  ]
}
