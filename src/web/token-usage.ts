import { statSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { listScheduledTasks } from './scheduled-tasks-io.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// Claude Code encodes a project's absolute path into a directory name by
// replacing every non-alphanumeric/non-dash character with `-`. The main
// agent's transcripts live under that exact directory, regardless of what
// the agent calls itself.
function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9-]/g, '-')
}

interface AgentTranscriptSource {
  agent: string
  projectDir: string
}

function discoverAgentSources(): AgentTranscriptSource[] {
  const sources: AgentTranscriptSource[] = []
  if (!existsSync(PROJECTS_DIR)) return sources
  const mainDirName = encodeProjectPath(PROJECT_ROOT)
  for (const entry of readdirSync(PROJECTS_DIR)) {
    const full = join(PROJECTS_DIR, entry)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (!stat.isDirectory()) continue

    // sanitizeAgentName() allows [a-z0-9-], so the old /([a-z]+)$/ silently
    // skipped every agent with a digit or a hyphen in its name -- the whole
    // per-project worker fleet (davinci-ocura, vermeer-fressa, ...) never
    // appeared in the token monitor at all. Not zero usage: no rows.
    const agentMatch = entry.match(/-agents-([a-z0-9-]+)$/)
    if (agentMatch) {
      sources.push({ agent: agentMatch[1], projectDir: full })
    } else if (entry === mainDirName) {
      sources.push({ agent: MAIN_AGENT_ID, projectDir: full })
    }
  }
  return sources
}

function findJsonlFiles(dir: string): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files

  function scanDir(d: string) {
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const entry of entries) {
      const full = join(d, entry)
      if (entry.endsWith('.jsonl')) {
        files.push(full)
      } else {
        let stat
        try { stat = statSync(full) } catch { continue }
        if (stat.isDirectory()) {
          scanDir(full)
        }
      }
    }
  }

  scanDir(dir)
  return files
}

/**
 * The scheduled task a prompt belongs to, read off the provenance wrapper the
 * schedule runner puts around every injected prompt.
 *
 * Two markers ride along, and measurement across all 95 transcripts on
 * 2026-07-31 found them on all 1149 scheduled prompts together, never one
 * without the other: a structured `<scheduled-task source="scheduled-task:X">`
 * tag and a human-readable `[Heartbeat: X]` / `[Utemezett feladat: X]` prefix.
 * We anchor on the structured tag -- it is machine-intended, quoted, and cannot
 * be confused with a user quoting the bracket form in prose.
 *
 * Neither marker sits at the start of the message: the safety wrapper's
 * preamble comes first, so this searches rather than matching from the head.
 */
const SCHEDULED_TASK_TAG = /<scheduled-task source="scheduled-task:([^"]+)"/

/** Schedule name for a prompt, or null if this is not a scheduled run. */
export function parseScheduledTaskMarker(text: string): string | null {
  const m = SCHEDULED_TASK_TAG.exec(text)
  return m ? m[1] : null
}

/**
 * A `user` line the harness injected, which nobody typed.
 *
 * The label ends when a PERSON takes over, and that is what an unmarked user
 * turn is supposed to mean. But `<system-reminder>` and `<task-notification>`
 * blocks arrive as user lines too, mid-run, and cleared the label for the rest
 * of the scheduled task -- measured 2026-08-09: 44 rows in the 30-day window
 * lost an otherwise exact attribution this way, silently, because a dropped
 * label logs nothing and reads exactly like interactive work.
 *
 * Anchored at the start on purpose: these blocks are also APPENDED to real
 * user messages, and such a turn is a person taking over and must still clear.
 * A slash command (`<command-name>`) is likewise a person, so it is not here.
 */
const HARNESS_INJECTED_TURN = /^\s*<(system-reminder|task-notification)>/

export function isHarnessInjectedTurn(text: string): boolean {
  return HARNESS_INJECTED_TURN.test(text)
}

/**
 * Text carried by a transcript `user` line, or null when the line is not a
 * real user turn.
 *
 * Tool results arrive as `user` lines too -- 8270 of 10579 across the fleet's
 * transcripts -- and they must be distinguished from a person typing. If a
 * tool result counted as a user turn, the label would be cleared on the very
 * first tool call of a scheduled run, which is to say almost immediately, and
 * the task would appear to cost a single API call.
 */
export function userTurnText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  let text = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; text?: string }
    if (b.type === 'tool_result') return null // a tool result, not a person
    if (b.type === 'text' && typeof b.text === 'string') text += b.text
  }
  return text
}

interface ParsedCall {
  agent: string
  sessionId: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Tokens in thinking content blocks (estimated from char length / 4). */
  thinkingTokens: number
  /** Model identifier from the API response, e.g. "claude-sonnet-4-6". */
  model: string | null
  /** Scheduled task this turn belongs to, or null for interactive work. Only
   *  the schedule NAME is stored: its kind (task vs heartbeat) already lives in
   *  the schedule's own task-config.json and would go stale if duplicated here. */
  taskTitle: string | null
  contentPreview: string
  toolName: string | null
  /** The API message id (msg_...). One assistant turn that calls a tool is
   *  written to the transcript as SEVERAL `assistant` lines sharing this id --
   *  a text block (tool_name=null) plus one line per tool_use block -- and EACH
   *  carries the SAME cumulative `usage`. Counting each line would double (or
   *  triple) the turn's tokens, which is exactly the dashboard-inflation bug.
   *  Used only to collapse those lines back into one row; not persisted. */
  messageId?: string | null
}

/**
 * Collapse transcript rows that belong to the same assistant turn (same
 * message id) into a single row, so a tool-calling turn is counted ONCE.
 *
 * Usage is identical across a turn's lines, so we take the max per field
 * (defensive against a partial/streaming line) rather than summing. The tool
 * name and preview are filled from whichever line carries them. Rows without a
 * message id (older transcripts) pass through untouched. Pure + order-stable
 * for unit testing.
 */
export function collapseByMessageId(calls: ParsedCall[]): ParsedCall[] {
  const byId = new Map<string, ParsedCall>()
  const out: ParsedCall[] = []
  for (const c of calls) {
    if (!c.messageId) { out.push(c); continue }
    const ex = byId.get(c.messageId)
    if (!ex) {
      const copy = { ...c }
      byId.set(c.messageId, copy)
      out.push(copy)
      continue
    }
    ex.inputTokens = Math.max(ex.inputTokens, c.inputTokens)
    ex.outputTokens = Math.max(ex.outputTokens, c.outputTokens)
    ex.cacheReadTokens = Math.max(ex.cacheReadTokens, c.cacheReadTokens)
    ex.cacheCreationTokens = Math.max(ex.cacheCreationTokens, c.cacheCreationTokens)
    ex.thinkingTokens = Math.max(ex.thinkingTokens, c.thinkingTokens)
    if (!ex.model && c.model) ex.model = c.model
    if (!ex.taskTitle && c.taskTitle) ex.taskTitle = c.taskTitle
    if (!ex.toolName && c.toolName) ex.toolName = c.toolName
    if (!ex.contentPreview && c.contentPreview) ex.contentPreview = c.contentPreview
  }
  return out
}

export async function parseJsonlFile(
  filePath: string,
  agent: string,
  fromLine: number,
  carriedTask: string | null = null,
): Promise<{ calls: ParsedCall[]; linesRead: number; endTask: string | null }> {
  const calls: ParsedCall[] = []
  let lineNum = 0
  let sessionId = ''
  // Survives across resumes via the cursor -- see the token_usage_cursors
  // migration in db.ts for why dropping it would corrupt attribution quietly.
  let currentTask: string | null = carriedTask

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    lineNum++
    if (lineNum <= fromLine) continue
    if (!line.trim()) continue

    let obj: any
    try { obj = JSON.parse(line) } catch { continue }

    if (obj.sessionId) {
      sessionId = obj.sessionId
    }

    // A real user turn either starts a scheduled run or ends one. An
    // unmarked turn means a person took over, so the previous task's label
    // must stop here rather than bleeding onto unrelated later work.
    // Harness-injected lines are not a person and must not end the run.
    if (obj.type === 'user') {
      const text = userTurnText(obj.message?.content)
      if (text !== null && !isHarnessInjectedTurn(text)) currentTask = parseScheduledTaskMarker(text)
      continue
    }

    if (obj.type !== 'assistant' || !obj.message?.usage) continue

    const u = obj.message.usage
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0
    if (!ts) continue

    let preview = ''
    const content = obj.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          preview = block.text.slice(0, 200)
          break
        }
      }
    } else if (typeof content === 'string') {
      preview = content.slice(0, 200)
    }

    let toolName: string | null = null
    let thinkingTokens = 0
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use' && block.name && !toolName) {
          toolName = block.name
        }
        // Estimate thinking tokens from char length (no per-block count in API)
        if (block.type === 'thinking' && typeof block.thinking === 'string') {
          thinkingTokens += Math.ceil(block.thinking.length / 4)
        }
      }
    }

    calls.push({
      agent,
      sessionId: sessionId || basename(filePath, '.jsonl'),
      timestamp: Math.floor(ts / 1000),
      inputTokens: (u.input_tokens || 0),
      outputTokens: (u.output_tokens || 0),
      cacheReadTokens: (u.cache_read_input_tokens || 0),
      cacheCreationTokens: (u.cache_creation_input_tokens || 0),
      thinkingTokens,
      model: obj.message?.model || null,
      taskTitle: currentTask,
      contentPreview: preview,
      toolName,
      messageId: obj.message?.id || null,
    })
  }

  // Collapse the multi-line tool-turn rows (same message id, repeated usage)
  // before they reach the DB -- this is the fix for the ~2x token inflation.
  return { calls: collapseByMessageId(calls), linesRead: lineNum, endTask: currentTask }
}

export async function collectTokenUsage(): Promise<{ inserted: number; files: number }> {
  const db = getDb()
  const sources = discoverAgentSources()
  let totalInserted = 0
  let totalFiles = 0

  const getCursor = db.prepare('SELECT last_line, last_size, last_task_title FROM token_usage_cursors WHERE file_path = ?')
  const setCursor = db.prepare('INSERT OR REPLACE INTO token_usage_cursors (file_path, last_line, last_size, last_task_title) VALUES (?, ?, ?, ?)')
  const insertCall = db.prepare(`
    INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, thinking_tokens, model, content_preview, tool_name, task_title, task_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, session_id, timestamp, input_tokens, output_tokens) DO UPDATE SET
      model = CASE WHEN token_usage.model IS NULL AND excluded.model IS NOT NULL THEN excluded.model ELSE token_usage.model END,
      -- Fills in on a re-scan but never overwrites an existing label, so a
      -- deliberate backfill can label history without rewriting good rows.
      task_title = CASE WHEN token_usage.task_title IS NULL AND excluded.task_title IS NOT NULL THEN excluded.task_title ELSE token_usage.task_title END,
      -- Fills provenance on a rescan for rows labelled before this column
      -- existed, without ever relabelling a row that already has a source.
      task_source = CASE WHEN token_usage.task_source IS NULL AND excluded.task_source IS NOT NULL THEN excluded.task_source ELSE token_usage.task_source END,
      thinking_tokens = CASE WHEN (token_usage.thinking_tokens IS NULL OR token_usage.thinking_tokens = 0) AND excluded.thinking_tokens > 0 THEN excluded.thinking_tokens ELSE token_usage.thinking_tokens END
  `)

  for (const source of sources) {
    const files = findJsonlFiles(source.projectDir)
    for (const file of files) {
      let fileSize: number
      try { fileSize = statSync(file).size } catch { continue }

      const cursor = getCursor.get(file) as { last_line: number; last_size: number; last_task_title: string | null } | undefined
      if (cursor && cursor.last_size === fileSize) continue

      const fromLine = (cursor && cursor.last_size <= fileSize) ? cursor.last_line : 0

      try {
        // Resuming mid-file means the marker naming the current task may be
        // behind us; the cursor carries it forward. A full re-read (fromLine 0)
        // starts clean so a stale label cannot survive a deliberate rescan.
        const { calls, linesRead, endTask } = await parseJsonlFile(
          file, source.agent, fromLine, fromLine > 0 ? (cursor?.last_task_title ?? null) : null,
        )

        if (calls.length > 0) {
          const tx = db.transaction(() => {
            for (const c of calls) {
              insertCall.run(
                c.agent, c.sessionId, c.timestamp,
                c.inputTokens, c.outputTokens,
                c.cacheReadTokens, c.cacheCreationTokens,
                c.thinkingTokens, c.model,
                c.contentPreview || null, c.toolName, c.taskTitle,
                c.taskTitle ? 'schedule_marker' : null,
              )
            }
            setCursor.run(file, linesRead, fileSize, endTask)
          })
          tx()
          totalInserted += calls.length
        } else {
          setCursor.run(file, linesRead, fileSize, endTask)
        }
        totalFiles++
      } catch (err) {
        logger.warn({ err, file }, 'Token usage parse failed')
      }
    }
  }

  return { inserted: totalInserted, files: totalFiles }
}

export interface TokenSummaryModelRow {
  model: string | null
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
}

export interface TokenSummary {
  agent: string
  totalCalls: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
  totalSessions: number
  firstSeen: number
  lastSeen: number
  perModel: TokenSummaryModelRow[]
}

export function getTokenSummary(from?: number, to?: number): TokenSummary[] {
  const db = getDb()
  const conditions: string[] = []
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''

  const rows = db.prepare(`
    SELECT agent,
      COUNT(*) as totalCalls,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation,
      COUNT(DISTINCT session_id) as totalSessions,
      MIN(timestamp) as firstSeen,
      MAX(timestamp) as lastSeen
    FROM token_usage
    ${where}
    GROUP BY agent ORDER BY totalInput DESC
  `).all(...params) as Omit<TokenSummary, 'perModel'>[]

  const modelRows = db.prepare(`
    SELECT agent, model,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation
    FROM token_usage
    ${where}
    GROUP BY agent, model
  `).all(...params) as (TokenSummaryModelRow & { agent: string })[]

  const byAgent = new Map<string, TokenSummaryModelRow[]>()
  for (const mr of modelRows) {
    const { agent, ...rest } = mr as { agent: string } & TokenSummaryModelRow
    if (!byAgent.has(agent)) byAgent.set(agent, [])
    byAgent.get(agent)!.push(rest)
  }

  return rows.map(r => ({ ...r, perModel: byAgent.get(r.agent) ?? [] }))
}

export interface ModelDistEntry {
  model: string
  count: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
}

export function getModelDistribution(from?: number, to?: number, agent?: string): ModelDistEntry[] {
  const db = getDb()
  const hasModelCol = db.prepare("SELECT COUNT(*) as n FROM pragma_table_info('token_usage') WHERE name='model'").get() as { n: number }
  if (!hasModelCol.n) return []

  let sql = `
    SELECT model,
      COUNT(*) as count,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation
    FROM token_usage
  `
  const conditions: string[] = [
    "model IS NOT NULL",
    "model != ''",
    "model != '<synthetic>'",
  ]
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  if (agent) { conditions.push('agent = ?'); params.push(agent) }
  sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' GROUP BY model ORDER BY count DESC'

  return db.prepare(sql).all(...params) as ModelDistEntry[]
}

export interface ToolStatEntry {
  tool_name: string
  model: string | null
  count: number
  agents: string
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
}

export function getToolStats(from?: number, to?: number, agent?: string): ToolStatEntry[] {
  const db = getDb()
  let sql = `
    SELECT tool_name,
      model,
      COUNT(*) as count,
      GROUP_CONCAT(DISTINCT agent) as agents,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation
    FROM token_usage
    WHERE tool_name IS NOT NULL
  `
  const conditions: string[] = []
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  if (agent) { conditions.push('agent = ?'); params.push(agent) }
  if (conditions.length) sql += ' AND ' + conditions.join(' AND ')
  sql += ' GROUP BY tool_name, model ORDER BY count DESC'

  return db.prepare(sql).all(...params) as ToolStatEntry[]
}

export interface TimelineBucket {
  bucket: number
  agent: string
  calls: number
  inputTokens: number
  outputTokens: number
}

export function getTokenTimeline(
  bucketMinutes: number = 60,
  from?: number,
  to?: number,
  agent?: string,
): TimelineBucket[] {
  const db = getDb()
  const bucketSeconds = bucketMinutes * 60
  let sql = `
    SELECT
      (timestamp / ${bucketSeconds}) * ${bucketSeconds} as bucket,
      agent,
      COUNT(*) as calls,
      SUM(input_tokens + cache_read_tokens + cache_creation_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens
    FROM token_usage
  `
  const conditions: string[] = []
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  if (agent) { conditions.push('agent = ?'); params.push(agent) }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' GROUP BY bucket, agent ORDER BY bucket ASC'

  return db.prepare(sql).all(...params) as TimelineBucket[]
}

export interface TokenDetail {
  id: number
  agent: string
  sessionId: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  thinkingTokens: number
  model: string | null
  contentPreview: string | null
  toolName: string | null
  taskTitle: string | null
  project: string | null
}

export function getTokenDetails(
  opts: { agent?: string; from?: number; to?: number; limit?: number; offset?: number; minTokens?: number; q?: string },
): TokenDetail[] {
  const db = getDb()
  let sql = `SELECT * FROM token_usage`
  const conditions: string[] = []
  const params: any[] = []
  if (opts.agent) { conditions.push('agent = ?'); params.push(opts.agent) }
  if (opts.from) { conditions.push('timestamp >= ?'); params.push(opts.from) }
  if (opts.to) { conditions.push('timestamp <= ?'); params.push(opts.to) }
  if (opts.minTokens) {
    conditions.push('(input_tokens + cache_read_tokens + cache_creation_tokens) >= ?')
    params.push(opts.minTokens)
  }
  if (opts.q) {
    const like = `%${opts.q}%`
    conditions.push('(agent LIKE ? OR tool_name LIKE ? OR content_preview LIKE ? OR task_title LIKE ?)')
    params.push(like, like, like, like)
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' ORDER BY timestamp DESC'
  sql += ' LIMIT ? OFFSET ?'
  params.push(opts.limit || 100, opts.offset || 0)

  return db.prepare(sql).all(...params) as TokenDetail[]
}

/**
 * Collect the raw usage rows AND label them.
 *
 * These two used to be wired up separately: the collector ran hourly from the
 * server, while the labeller ran only from POST /api/token-usage/collect --
 * which nothing calls except the dashboard page. Measured 2026-08-09: labelling
 * stopped on 07-31 and every row since is unattributed, 76.5% of a 30-day
 * window. Nothing failed; the half that writes the labels simply was not on a
 * timer.
 *
 * One function for both callers, so the timer and the endpoint cannot drift
 * into doing different things again.
 *
 * A failing correlation never fails the collection: the rows are the data, the
 * labels are an interpretation of it, and losing the second must not cost the
 * first.
 */
export async function collectAndCorrelate(
  deps: {
    collect?: () => Promise<{ inserted: number; files: number }>
    correlate?: () => void
    labelSchedules?: () => number
  } = {},
): Promise<{ inserted: number; files: number; correlated: boolean; scheduleLabelled: number }> {
  const collect = deps.collect ?? collectTokenUsage
  const correlate = deps.correlate ?? correlateWithKanban
  const labelSchedules = deps.labelSchedules ?? labelScheduleProjects
  const result = await collect()

  // Exact first, guess second. labelScheduleProjects() states which project a
  // named schedule belongs to; correlateWithKanban() then fills what is still
  // unlabelled from a time window. Reversing them would let the guess claim
  // rows the marker already identified, so a test pins this order.
  let scheduleLabelled = 0
  try {
    scheduleLabelled = labelSchedules()
  } catch (err) {
    logger.warn({ err }, 'Schedule project labelling failed; rows collected without it')
  }
  try {
    correlate()
    return { ...result, correlated: true, scheduleLabelled }
  } catch (err) {
    logger.warn({ err }, 'Kanban correlation failed; usage rows collected but unlabelled')
    return { ...result, correlated: false, scheduleLabelled }
  }
}

/**
 * Give the project to rows a schedule marker already identified.
 *
 * The runner wraps every injected prompt with `scheduled-task:<name>`, so the
 * parser knows exactly which task a row belongs to -- but a schedule had no
 * way to declare which project its cost is. Measured on the live data
 * 2026-08-09: of the 10402 rows in the 30-day window with no project, 6542
 * carried a schedule marker naming a schedule that still exists. Fully
 * identified work, unattributed for want of one field.
 *
 * A schedule with no `project` is skipped rather than defaulted: the cost view
 * can survive a gap, but not a bucket nobody chose. Rows that already have a
 * project are never relabelled, so this cannot overwrite an operator's answer
 * or fight with the kanban correlation over the same row.
 *
 * Returns how many rows it filled -- a labeller that reports zero work is the
 * only kind whose silence is readable.
 */
export function labelScheduleProjects(
  deps: { tasks?: () => { name: string; project?: string }[] } = {},
): number {
  const db = getDb()
  const tasks = (deps.tasks ?? listScheduledTasks)()
  const upd = db.prepare(`
    UPDATE token_usage
    SET project = ?, project_source = 'schedule_config'
    WHERE task_title = ? AND project IS NULL
  `)
  let labelled = 0
  for (const task of tasks) {
    const project = (task.project ?? '').trim()
    if (!project) continue
    labelled += upd.run(project, task.name).changes
  }
  return labelled
}

export function correlateWithKanban(): void {
  const db = getDb()
  const uncorrelated = db.prepare(`
    SELECT DISTINCT agent, MIN(timestamp) as minTs, MAX(timestamp) as maxTs
    FROM token_usage
    WHERE task_title IS NULL
    GROUP BY agent
  `).all() as { agent: string; minTs: number; maxTs: number }[]

  for (const row of uncorrelated) {
    const cards = db.prepare(`
      SELECT id, title, project, assignee, updated_at
      FROM kanban_cards
      WHERE (assignee = ? OR assignee LIKE '%' || ? || '%')
        AND updated_at BETWEEN ? AND ?
      ORDER BY updated_at ASC
    `).all(row.agent, row.agent, row.minTs, row.maxTs) as any[]

    for (const card of cards) {
      const nextCard = cards.find((c: any) => c.updated_at > card.updated_at)
      const endTs = nextCard ? nextCard.updated_at : row.maxTs

      // project_source only when a project is actually written: a card with no
      // project must leave the row unattributed, not stamped as attributed-by-
      // correlation with nothing in the column.
      db.prepare(`
        UPDATE token_usage
        SET task_title = ?, project = ?, task_source = 'kanban_correlation',
            project_source = CASE WHEN ? IS NULL THEN project_source ELSE 'kanban_correlation' END
        WHERE agent = ? AND timestamp BETWEEN ? AND ? AND task_title IS NULL
      `).run(card.title, card.project || null, card.project || null, row.agent, card.updated_at, endTs)
    }
  }
}
