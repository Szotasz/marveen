import { getDb, saveAgentMemory, updateMemory, forgetMemoryKeepVersion } from '../../db.js'
import { containsSuspiciousContent } from '../routes/memories.js'
import { stripControl } from './util.js'
import type { Mode } from './store.js'

export interface ToolContext { owner: string; mode: Mode; source: string }
export type ToolOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; message: string }

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false }
  write: boolean
  read: boolean
  run: (args: Record<string, unknown>, ctx: ToolContext) => ToolOutcome
}

const NOT_FOUND: ToolOutcome = { ok: false, message: 'Memory not found' }
const MAX_CONTENT = 10000

interface Row {
  id: number; content: string; topic_key: string | null; keywords: string | null; source: string | null
  created_at: number; updated_at: number | null
}

const COLS = 'm.id, m.content, m.topic_key, m.keywords, m.source, m.created_at, m.updated_at'

function toItem(r: Row): Record<string, unknown> {
  return {
    id: String(r.id),
    title: r.content.replace(/\s+/g, ' ').trim().slice(0, 80),
    text: r.content,
    metadata: { topic: r.topic_key, tags: r.keywords, source: r.source, created_at: r.created_at, updated_at: r.updated_at },
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function intIn(v: unknown, min: number, max: number, def: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def
  return Math.min(max, Math.max(min, Math.floor(v)))
}

function ownRow(idArg: unknown, owner: string): Row | undefined {
  const id = str(idArg)
  if (id === undefined || !/^\d+$/.test(id)) return undefined
  return getDb().prepare(`SELECT ${COLS} FROM memories m WHERE m.id = ? AND m.agent_id = ?`).get(Number(id), owner) as Row | undefined
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c)
}

function isSecret(content: string): boolean {
  const patterns = [
    /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bsk-ant-[A-Za-z0-9_-]{20,}/,
    /\bsk-[A-Za-z0-9_-]{20,}/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/,
  ]
  if (patterns.some((p) => p.test(content))) return true
  // A whole 13-19 digit number (spaces or dashes between groups), not a slice of a longer one.
  for (const m of content.matchAll(/(?<!\d[ -]?)\d(?:[ -]?\d){12,18}(?![ -]?\d)/g)) {
    if (luhn(m[0].replace(/[ -]/g, ''))) return true
  }
  return false
}

function luhn(digits: string): boolean {
  let sum = 0
  let dbl = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (dbl) { d *= 2; if (d > 9) d -= 9 }
    sum += d
    dbl = !dbl
  }
  return sum % 10 === 0
}

function validateContent(content: string): string | null {
  if (!content) return 'content must not be empty'
  if (content.length > MAX_CONTENT) return `content is longer than ${MAX_CONTENT} characters`
  if (isSecret(content)) return 'content looks like a secret or credential and was not saved'
  if (containsSuspiciousContent(content)) return 'content rejected by the security filter'
  return null
}

function search(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const query = str(args.query)?.trim()
  if (!query) return { ok: false, message: 'query is required' }
  const limit = intIn(args.limit, 1, 50, 10)
  const topic = str(args.topic)?.trim() || null
  const db = getDb()
  const topicSql = topic ? ' AND m.topic_key = ?' : ''
  const extra = topic ? [topic] : []
  let rows: Row[] = []
  const terms = query.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean)
  if (terms.length > 0) {
    try {
      rows = db.prepare(
        `SELECT ${COLS} FROM memories m JOIN memories_fts f ON m.id = f.rowid
          WHERE f.memories_fts MATCH ? AND m.agent_id = ?${topicSql} ORDER BY f.rank LIMIT ?`
      ).all(terms.map((t) => `${t}*`).join(' OR '), ctx.owner, ...extra, limit) as Row[]
    } catch { rows = [] }
  }
  if (rows.length === 0) {
    const like = `%${escapeLike(query)}%`
    rows = db.prepare(
      `SELECT ${COLS} FROM memories m
        WHERE m.agent_id = ? AND (m.content LIKE ? ESCAPE '\\' OR m.keywords LIKE ? ESCAPE '\\')${topicSql}
        ORDER BY COALESCE(m.updated_at, m.created_at) DESC, m.id DESC LIMIT ?`
    ).all(ctx.owner, like, like, ...extra, limit) as Row[]
  }
  return { ok: true, result: { results: rows.map(toItem) } }
}

function fetchOne(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const row = ownRow(args.id, ctx.owner)
  return row ? { ok: true, result: toItem(row) } : NOT_FOUND
}

function recent(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const limit = intIn(args.limit, 1, 100, 20)
  const conds = ['m.agent_id = ?']
  const params: unknown[] = [ctx.owner]
  if (typeof args.since_days === 'number' && Number.isFinite(args.since_days)) {
    conds.push('COALESCE(m.updated_at, m.created_at) >= ?')
    params.push(Math.floor(Date.now() / 1000 - args.since_days * 86400))
  }
  const source = str(args.source)?.trim()
  if (source) { conds.push('m.source = ?'); params.push(source) }
  const rows = getDb().prepare(
    `SELECT ${COLS} FROM memories m WHERE ${conds.join(' AND ')} ORDER BY COALESCE(m.updated_at, m.created_at) DESC, m.id DESC LIMIT ?`
  ).all(...params, limit) as Row[]
  return { ok: true, result: { results: rows.map(toItem) } }
}

function listTopics(_args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const topics = getDb().prepare(
    `SELECT topic_key AS topic, COUNT(*) AS count FROM memories
      WHERE agent_id = ? AND topic_key IS NOT NULL AND topic_key != ''
      GROUP BY topic_key ORDER BY count DESC, topic_key`
  ).all(ctx.owner)
  return { ok: true, result: { topics } }
}

function remember(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const content = str(args.content)?.trim() ?? ''
  const bad = validateContent(content)
  if (bad) return { ok: false, message: bad }
  const topic = str(args.topic)?.trim().slice(0, 100) || null
  const tags = str(args.tags)?.trim().slice(0, 500) || undefined
  const db = getDb()
  const { id } = saveAgentMemory(ctx.owner, content, 'warm', tags)
  db.prepare('UPDATE memories SET topic_key = ?, source = ? WHERE id = ?').run(topic, ctx.source, id)
  return { ok: true, result: ctx.mode === 'w' ? { saved: true } : { id: String(id), saved: true } }
}

function updateMem(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const row = ownRow(args.id, ctx.owner)
  if (!row) return NOT_FOUND
  const content = str(args.content)?.trim()
  const topic = str(args.topic)?.trim().slice(0, 100)
  const tags = str(args.tags)?.trim().slice(0, 500)
  if (content === undefined && topic === undefined && tags === undefined) {
    return { ok: false, message: 'Provide at least one of content, topic or tags' }
  }
  if (content !== undefined) {
    const bad = validateContent(content)
    if (bad) return { ok: false, message: bad }
  }
  updateMemory(row.id, content ?? row.content, undefined, undefined, tags, ctx.source)
  if (topic !== undefined) getDb().prepare('UPDATE memories SET topic_key = ? WHERE id = ?').run(topic || null, row.id)
  return { ok: true, result: { id: String(row.id), updated: true } }
}

function forget(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const row = ownRow(args.id, ctx.owner)
  if (!row) return NOT_FOUND
  if (!forgetMemoryKeepVersion(row.id)) return NOT_FOUND
  return { ok: true, result: { id: String(row.id), forgotten: true } }
}

const str1 = (description: string) => ({ type: 'string', description })
const ann = (readOnly: boolean, destructive = false, idempotent = readOnly) =>
  ({ readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false as const })

const TOOLS: ToolDef[] = [
  {
    name: 'search', read: true, write: false, run: search, annotations: ann(true),
    description: "Search the user's long-term memory. Returns the best matching memories first.",
    inputSchema: { type: 'object', properties: { query: str1('Words to look for'), limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum results (default 10)' }, topic: str1('Only memories filed under this topic') }, required: ['query'] },
  },
  {
    name: 'fetch', read: true, write: false, run: fetchOne, annotations: ann(true),
    description: "Fetch one memory of the user's long-term memory by id.",
    inputSchema: { type: 'object', properties: { id: str1('Memory id as returned by search or recent') }, required: ['id'] },
  },
  {
    name: 'recent', read: true, write: false, run: recent, annotations: ann(true),
    description: "List the most recently saved or changed memories of the user's long-term memory.",
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum results (default 20)' }, since_days: { type: 'number', description: 'Only memories changed within this many days' }, source: str1('Only memories saved by this source') } },
  },
  {
    name: 'list_topics', read: true, write: false, run: listTopics, annotations: ann(true),
    description: "List the topics used in the user's long-term memory with the number of memories in each.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'remember', read: false, write: true, run: remember, annotations: ann(false, false, false),
    description: "Save one durable fact to the user's long-term memory. One fact per call. Never store secrets.",
    inputSchema: { type: 'object', properties: { content: str1('The fact to remember (max 10000 characters)'), topic: str1('Optional topic (max 100 characters)'), tags: str1('Optional comma-separated tags (max 500 characters)') }, required: ['content'] },
  },
  {
    name: 'update_memory', read: false, write: true, run: updateMem, annotations: ann(false, false, true),
    description: "Correct a memory in the user's long-term memory. The previous text is kept as a version.",
    inputSchema: { type: 'object', properties: { id: str1('Memory id'), content: str1('New text'), topic: str1('New topic'), tags: str1('New comma-separated tags') }, required: ['id'] },
  },
  {
    name: 'forget', read: false, write: true, run: forget, annotations: ann(false, true, true),
    description: "Forget a memory in the user's long-term memory. The last text stays recoverable by the user as a version.",
    inputSchema: { type: 'object', properties: { id: str1('Memory id'), reason: str1('Why it is forgotten') }, required: ['id'] },
  },
]

function allowed(t: ToolDef, mode: Mode): boolean {
  if (mode === 'rw') return true
  if (mode === 'r') return t.read
  return t.name === 'remember'
}

export function listTools(mode: Mode): unknown[] {
  return TOOLS.filter((t) => allowed(t, mode)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }))
}

/** undefined = the tool is unknown or not allowed for this mode. */
export function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): ToolOutcome | undefined {
  const t = TOOLS.find((x) => x.name === name)
  if (!t || !allowed(t, ctx.mode)) return undefined
  return t.run(args, ctx)
}

export function buildSource(clientName: string, label: string | null): string {
  return stripControl('mcp:' + clientName + (label ? ':' + label : '')).slice(0, 200)
}
