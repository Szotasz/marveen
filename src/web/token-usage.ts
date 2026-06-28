import { statSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'

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

    const agentMatch = entry.match(/-agents-([a-z]+)$/)
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

interface ParsedCall {
  agent: string
  sessionId: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
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
    if (!ex.toolName && c.toolName) ex.toolName = c.toolName
    if (!ex.contentPreview && c.contentPreview) ex.contentPreview = c.contentPreview
  }
  return out
}

async function parseJsonlFile(
  filePath: string,
  agent: string,
  fromLine: number,
): Promise<{ calls: ParsedCall[]; linesRead: number }> {
  const calls: ParsedCall[] = []
  let lineNum = 0
  let sessionId = ''

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
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use' && block.name) {
          toolName = block.name
          break
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
      contentPreview: preview,
      toolName,
      messageId: obj.message?.id || null,
    })
  }

  // Collapse the multi-line tool-turn rows (same message id, repeated usage)
  // before they reach the DB -- this is the fix for the ~2x token inflation.
  return { calls: collapseByMessageId(calls), linesRead: lineNum }
}

export async function collectTokenUsage(): Promise<{ inserted: number; files: number }> {
  const db = getDb()
  const sources = discoverAgentSources()
  let totalInserted = 0
  let totalFiles = 0

  const getCursor = db.prepare('SELECT last_line, last_size FROM token_usage_cursors WHERE file_path = ?')
  const setCursor = db.prepare('INSERT OR REPLACE INTO token_usage_cursors (file_path, last_line, last_size) VALUES (?, ?, ?)')
  const insertCall = db.prepare(`
    INSERT OR IGNORE INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, content_preview, tool_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const source of sources) {
    const files = findJsonlFiles(source.projectDir)
    for (const file of files) {
      let fileSize: number
      try { fileSize = statSync(file).size } catch { continue }

      const cursor = getCursor.get(file) as { last_line: number; last_size: number } | undefined
      if (cursor && cursor.last_size === fileSize) continue

      const fromLine = (cursor && cursor.last_size <= fileSize) ? cursor.last_line : 0

      try {
        const { calls, linesRead } = await parseJsonlFile(file, source.agent, fromLine)

        if (calls.length > 0) {
          const tx = db.transaction(() => {
            for (const c of calls) {
              insertCall.run(
                c.agent, c.sessionId, c.timestamp,
                c.inputTokens, c.outputTokens,
                c.cacheReadTokens, c.cacheCreationTokens,
                c.contentPreview || null, c.toolName,
              )
            }
            setCursor.run(file, linesRead, fileSize)
          })
          tx()
          totalInserted += calls.length
        } else {
          setCursor.run(file, linesRead, fileSize)
        }
        totalFiles++
      } catch (err) {
        logger.warn({ err, file }, 'Token usage parse failed')
      }
    }
  }

  return { inserted: totalInserted, files: totalFiles }
}

export interface TokenSummary {
  agent: string
  totalCalls: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
  firstSeen: number
  lastSeen: number
}

export function getTokenSummary(from?: number, to?: number): TokenSummary[] {
  const db = getDb()
  let sql = `
    SELECT agent,
      COUNT(*) as totalCalls,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation,
      MIN(timestamp) as firstSeen,
      MAX(timestamp) as lastSeen
    FROM token_usage
  `
  const conditions: string[] = []
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' GROUP BY agent ORDER BY totalInput DESC'

  return db.prepare(sql).all(...params) as TokenSummary[]
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

      db.prepare(`
        UPDATE token_usage
        SET task_title = ?, project = ?
        WHERE agent = ? AND timestamp BETWEEN ? AND ? AND task_title IS NULL
      `).run(card.title, card.project || null, row.agent, card.updated_at, endTs)
    }
  }
}
