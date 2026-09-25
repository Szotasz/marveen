// Worker-side heartbeat metrics injection (HBMETRICSWIRE910).
//
// Why the WORKER runs the instrument, measured: the hourly heartbeat round
// (a Haiku agent driven by its CLAUDE.md) was instructed four separate times
// to run scripts/heartbeat-metrics.sh and copy its output verbatim, and the
// digest still shipped fabricated numbers -- 2026-09-10 19:00-22:00 every
// round reported a du-shaped DB size (488) against the instrument's apparent
// size (473.6), plus hot=0 beside a measured 1. Marveen's pre-registered
// natural experiment (card HBMETRICSWIRE910, comment 2026-09-10 22:10)
// resolved to outcome (a): the FIRST round of a fresh session (2026-09-11
// 09:01) still said 488, so the drift is not context decay -- the round
// recomposes numbers no matter how fresh it is, and some rounds (11:00 the
// same day) comply while others do not. An instruction obeyed
// probabilistically is not a mechanism (HBGATEWIRE826). So the scheduler
// process runs the instrument at prompt-build time and injects the metric
// sections PRE-RENDERED in their final report form; the round's only job is
// to wrap the block in the report header and send it.
//
// Fail-closed, carried IN THE TEXT: when the instrument cannot be run or its
// output does not open with the known sentinel, the injected block itself
// carries `muszer-hiba: <literal first line>` in every section. The digest
// then transports the failure without relying on the round's discipline --
// a sloppy copy of a failure block is still a visible failure, never a
// fabricated zero and never the previous hour's numbers.

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import {
  PROJECT_ROOT,
  WEB_PORT,
  DASHBOARD_PUBLIC_URL,
  AGENT_API_ORIGIN,
  STORE_DIR,
  APP_TZ,
} from '../config.js'
import { resolveDashboardOrigin } from './agent-scaffold.js'
import { logger } from '../logger.js'

export const HB_METRICS_SENTINEL = 'HB_METRICS_V1'

// The marker the heartbeat agent's CLAUDE.md keys on. Kept as an exported
// constant so the scaffold renderer and the tests reference the SAME string
// -- a hand-copied marker that drifts is exactly the failure class this
// module exists to close.
export const HB_METRICS_BLOCK_MARKER = '[HB-METRIKA-BLOKK'

// How long the instrument may run at prompt-build time. The script's own
// HTTP calls time out at 10s each; 30s covers the worst honest case, and a
// hung instrument must not wedge the scheduler tick.
export const HB_METRICS_TIMEOUT_MS = 30_000

interface ParsedMetrics {
  ts: string | null
  counts: Record<string, string> | null
  waitingShown: string | null
  urgentIds: string[]
  waitingIds: string[]
  calendarN: number | null
  calEvents: string[] // rendered "- <time> -- <summary>" lines
  schedulesEnabled: string | null
  taskRuns: string | null // the TASK_RUNS_1H line, verbatim
  tokenPrune: Record<string, string> | null
  errors: Map<string, string> // section -> full ERROR line
}

function parseInstrumentOutput(lines: string[]): ParsedMetrics {
  const p: ParsedMetrics = {
    ts: null,
    counts: null,
    waitingShown: null,
    urgentIds: [],
    waitingIds: [],
    calendarN: null,
    calEvents: [],
    schedulesEnabled: null,
    taskRuns: null,
    tokenPrune: null,
    errors: new Map(),
  }
  const tsMatch = lines[0]?.match(/^HB_METRICS_V1 ts=(.+)$/)
  p.ts = tsMatch ? tsMatch[1] : null
  for (const line of lines) {
    if (line.startsWith('COUNTS ')) {
      const counts: Record<string, string> = {}
      for (const m of line.slice('COUNTS '.length).matchAll(/(\w+)=(\S+)/g)) {
        counts[m[1]] = m[2]
      }
      p.counts = counts
      p.waitingShown = counts['waiting_shown'] ?? null
    } else if (line.startsWith('URGENT ')) {
      const id = line.split(/\s+/)[1]
      if (id) p.urgentIds.push(id)
    } else if (line.startsWith('WAITING ')) {
      const id = line.split(/\s+/)[1]
      if (id) p.waitingIds.push(id)
    } else if (line.startsWith('CALENDAR_EVENTS ')) {
      const m = line.match(/n=(\d+)/)
      p.calendarN = m ? Number(m[1]) : null
    } else if (line.startsWith('CAL_EVENT ')) {
      // "CAL_EVENT <HH:MM|all-day> <summary...>[ attendees=N]"
      const rest = line.slice('CAL_EVENT '.length)
      const sp = rest.indexOf(' ')
      const time = sp === -1 ? rest : rest.slice(0, sp)
      let summary = sp === -1 ? '' : rest.slice(sp + 1)
      const att = summary.match(/\s+attendees=(\d+)$/)
      if (att) summary = summary.slice(0, att.index) + ` (attendees=${att[1]})`
      p.calEvents.push(`- ${time} -- ${summary}`)
    } else if (line.startsWith('SCHEDULES ')) {
      const m = line.match(/enabled=(\d+)/)
      p.schedulesEnabled = m ? m[1] : null
    } else if (line.startsWith('TOKEN_PRUNE ')) {
      const kv: Record<string, string> = {}
      for (const m of line.slice('TOKEN_PRUNE '.length).matchAll(/(\w+)=(\S+)/g)) {
        kv[m[1]] = m[2]
      }
      p.tokenPrune = kv
    } else if (line.startsWith('TASK_RUNS_1H ')) {
      p.taskRuns = line
    } else if (line.startsWith('ERROR ')) {
      const m = line.match(/^ERROR (\S+?):/)
      if (m) p.errors.set(m[1].replace(/:$/, ''), line)
    }
  }
  return p
}

// One muszer-hiba line for a section whose data is absent: prefer the
// section's own ERROR line, then the API-wide token error, then the literal
// first output line -- the reader always sees WHAT the instrument said, never
// a substituted value.
function hibaLine(p: ParsedMetrics, section: string, firstLine: string): string {
  const own = p.errors.get(section)
  if (own) return `- muszer-hiba: ${own}`
  const token = p.errors.get('token')
  if (token) return `- muszer-hiba: ${token}`
  return `- muszer-hiba: ${firstLine}`
}

// The prune verdict as ONE line. 'stale' is the only loud state, and it says
// what to do rather than what is broken: the daily decay sweep has not run.
function renderTokenPruneLine(p: ParsedMetrics, firstLine: string): string {
  const tp = p.tokenPrune
  if (!tp || !tp['state']) return hibaLine(p, 'token_prune', firstLine)
  if (tp['state'] === 'empty') return '- token_usage prune: nincs meg sor (uj telepites)'
  if (tp['state'] === 'stale') {
    return `- FIGYELEM, token_usage NYESES ELMARADT: ${tp['lag_hours']} ora lemaradas `
      + `(tures ${tp['tolerance_hours']} ora = ket sweep-ciklus). A napi decay-sweep nem fut -- `
      + `a token-naplo ettol korlatlanul no.`
  }
  return `- token_usage prune: rendben (${tp['lag_hours']} ora lemaradas, tures ${tp['tolerance_hours']} ora)`
}

function renderSections(p: ParsedMetrics, firstLine: string): string {
  const out: string[] = []

  out.push('### Calendar (next 2h)')
  if (p.errors.has('calendar')) {
    const reason = p.errors.get('calendar')!.replace(/^ERROR calendar:\s*/, '')
    out.push(`- calendar fetch failed: ${reason}`)
  } else if (p.calendarN === 0) {
    out.push('- no upcoming events')
  } else if (p.calEvents.length > 0) {
    out.push(...p.calEvents)
  } else {
    out.push(hibaLine(p, 'calendar', firstLine))
  }

  out.push('')
  out.push('### Kanban')
  // Counts come from the COUNTS line, never from the length of the capped
  // URGENT/WAITING lists (HBKANBANDRIFT819: counting list items once
  // reported waiting: 12 against a real 280) -- the lists only annotate.
  if (p.counts && p.counts['urgent'] != null) {
    const c = p.counts
    const urgent = p.urgentIds.length ? ` (${p.urgentIds.join(', ')})` : ''
    const shown = p.waitingShown && p.waitingIds.length
      ? ` (${p.waitingShown} legfrissebb: ${p.waitingIds.join(', ')})`
      : ''
    out.push(`- urgent: ${c['urgent']}${urgent}`)
    out.push(`- in_progress: ${c['in_progress']}`)
    out.push(`- waiting: ${c['waiting']}${shown}`)
    out.push(`- planned: ${c['planned']}`)
  } else {
    out.push(hibaLine(p, 'summary', firstLine))
  }

  out.push('')
  out.push('### Tasks')
  out.push(p.schedulesEnabled != null
    ? `- enabled schedules: ${p.schedulesEnabled}`
    : hibaLine(p, 'schedules', firstLine))
  out.push(p.taskRuns != null
    ? `- last hour: ${p.taskRuns}`
    : hibaLine(p, 'task_runs', firstLine))

  out.push('')
  out.push('### Memory / system')
  if (p.counts && p.counts['db_size_mb'] != null) {
    out.push(`- DB size: ${p.counts['db_size_mb']} MB`)
    out.push(`- new hot memories (1h): ${p.counts['new_hot_memories_1h']}`)
  } else {
    out.push(hibaLine(p, 'summary', firstLine))
  }
  // HBDBKUSZOB823: the DB size above is a bounded number (the token ledger is
  // pruned daily), so it cannot carry a health verdict on its own -- this line
  // is the verdict. Absent TOKEN_PRUNE renders as muszer-hiba, never as
  // silence: a health signal that disappears when the instrument changes shape
  // is the failure mode this whole module exists to close.
  out.push(renderTokenPruneLine(p, firstLine))

  return out.join('\n')
}

// Every section reduced to the same single failure line -- the shape a total
// instrument failure (no sentinel, spawn error, timeout) renders as.
function renderFailureSections(firstLine: string): string {
  const hiba = `- muszer-hiba: ${firstLine}`
  return [
    '### Calendar (next 2h)', hiba, '',
    '### Kanban', hiba, '',
    '### Tasks', hiba, '',
    '### Memory / system', hiba,
  ].join('\n')
}

/**
 * Pure renderer: instrument stdout (or a failure reason when it could not be
 * run) -> the final-form block injected into the heartbeat prompt. Exported
 * for unit tests; collectHeartbeatMetricsBlock() is the runtime entry.
 *
 * The sentinel rule lives HERE now (moved from the round's instructions): a
 * number enters the block only from an output whose first line starts with
 * HB_METRICS_V1. Anything else renders as muszer-hiba carrying the literal
 * first line.
 */
export function renderHeartbeatMetricsBlock(raw: string | null, failureReason?: string): string {
  const now = new Date().toLocaleString('sv-SE', { timeZone: APP_TZ }).slice(0, 16)
  let body: string
  let tsLabel = now
  if (raw == null) {
    body = renderFailureSections(failureReason ?? 'instrument did not run')
  } else {
    const lines = raw.split('\n').map(l => l.trimEnd()).filter((l, i) => l.length > 0 || i === 0)
    const firstLine = (lines[0] ?? '').trim() || '(empty instrument output)'
    if (!firstLine.startsWith(HB_METRICS_SENTINEL + ' ')) {
      body = renderFailureSections(firstLine)
    } else {
      const parsed = parseInstrumentOutput(lines)
      if (parsed.ts) tsLabel = parsed.ts
      body = renderSections(parsed, firstLine)
    }
  }
  return (
    `${HB_METRICS_BLOCK_MARKER} ts=${tsLabel} -- a worker merte prompt-osszeallitaskor]\n` +
    'Az alabbi szekciok a jelentes VEGLEGES torzse. Masold be VALTOZATLANUL,\n' +
    'szamot, cimet, sort nem irhatsz at es nem merhetsz ujra. A muszer-hiba\n' +
    'sor is VALTOZATLANUL megy tovabb -- az a mert eredmeny.\n\n' +
    body
  )
}

/**
 * Run the on-disk instrument and render the block. Never throws and never
 * returns null: a spawn error, timeout or bad output becomes a muszer-hiba
 * block, so the scheduler tick always has something to inject and the digest
 * always says what happened.
 *
 * Non-zero exit with usable stdout is NOT a failure here: the script is
 * fail-closed per section (partial output carries its own ERROR lines), so
 * stdout is rendered whenever it opens with the sentinel.
 */
export function collectHeartbeatMetricsBlock(): Promise<string> {
  const script = join(PROJECT_ROOT, 'scripts', 'heartbeat-metrics.sh')
  const origin = resolveDashboardOrigin(DASHBOARD_PUBLIC_URL, WEB_PORT, AGENT_API_ORIGIN)
  return new Promise(resolve => {
    execFile(
      'bash',
      [script],
      {
        env: {
          ...process.env,
          CLAW_STORE_DIR: STORE_DIR,
          CLAW_DASHBOARD_ORIGIN: origin,
          CLAW_TZ: APP_TZ,
        },
        timeout: HB_METRICS_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => {
        const out = typeof stdout === 'string' ? stdout : ''
        if (out.trim().length > 0) {
          // Partial-but-sentineled output is the instrument speaking; the
          // renderer decides section by section. Log the exit for the record.
          if (err) {
            logger.warn({ err: String(err) }, 'heartbeat metrics instrument exited non-zero; rendering its (fail-closed) output')
          }
          resolve(renderHeartbeatMetricsBlock(out))
        } else {
          const reason = err
            ? (err.killed ? `instrument timeout after ${HB_METRICS_TIMEOUT_MS} ms` : String(err.message ?? err).split('\n')[0])
            : '(empty instrument output)'
          logger.error({ reason }, 'heartbeat metrics instrument produced no output')
          resolve(renderHeartbeatMetricsBlock(null, reason))
        }
      },
    )
  })
}
