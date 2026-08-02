import { getDb, generateEmbedding } from './db.js'

export type ArtifactKind = 'html' | 'markdown' | 'json' | 'text' | 'binary'

export interface ArtifactRow {
  id: string
  agent_id: string
  title: string
  kind: ArtifactKind
  mime: string
  content: Buffer
  meta: string
  source: string | null
  created_at: number
  updated_at: number
}

export interface ArtifactSummary {
  id: string
  agent_id: string
  title: string
  kind: ArtifactKind
  mime: string
  meta: string
  source: string | null
  created_at: number
  updated_at: number
}

export const ARTIFACT_KINDS: ReadonlySet<ArtifactKind> = new Set(['html', 'markdown', 'json', 'text', 'binary'])

export interface CreateArtifactParams {
  agent_id: string
  title: string
  kind: ArtifactKind
  mime?: string
  content: Buffer
  meta?: Record<string, unknown>
  source?: string
}

const DEFAULT_MIME: Record<ArtifactKind, string> = {
  html:     'text/html; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  json:     'application/json; charset=utf-8',
  text:     'text/plain; charset=utf-8',
  binary:   'application/octet-stream',
}

export function createArtifact(params: CreateArtifactParams): { id: string } {
  const db = getDb()
  const mime = params.mime ?? DEFAULT_MIME[params.kind]
  const meta = JSON.stringify(params.meta ?? {})
  const row = db.prepare(`
    INSERT INTO artifacts (agent_id, title, kind, mime, content, meta, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(params.agent_id, params.title, params.kind, mime, params.content, meta, params.source ?? null) as { id: string }
  // Fire-and-forget: index title+meta embedding for semantic search
  storeArtifactEmbedding(row.id, params.title, meta).catch(() => { /* non-critical */ })
  return { id: row.id }
}

/**
 * Generate and store a title+meta embedding for an artifact in vec_artifacts.
 * No-op when Ollama is unavailable or sqlite-vec extension is not loaded.
 */
export async function storeArtifactEmbedding(
  id: string,
  title: string,
  meta: string
): Promise<void> {
  const text = [title, meta].filter(s => s?.trim()).join(' ')
  if (!text.trim()) return

  const embedding = await generateEmbedding(text).catch(() => null)
  if (!embedding) return

  const db = getDb()
  const rowRow = db.prepare('SELECT rowid FROM artifacts WHERE id = ?').get(id) as { rowid: number } | undefined
  if (!rowRow) return

  // Encode as little-endian Float32 buffer (same format as vec_memories)
  const buf = Buffer.allocUnsafe(embedding.length * 4)
  for (let i = 0; i < embedding.length; i++) buf.writeFloatLE(embedding[i], i * 4)

  try {
    db.prepare('INSERT OR REPLACE INTO vec_artifacts(artifact_rowid, embedding) VALUES(?, ?)').run(BigInt(rowRow.rowid), buf)
  } catch {
    // vec_artifacts is absent when sqlite-vec extension is unavailable -- graceful no-op
  }
}

export interface ListArtifactsOptions {
  agent?: string
  kind?: string
  q?: string
  limit?: number
  offset?: number
}

export function listArtifacts(opts: ListArtifactsOptions = {}): ArtifactSummary[] {
  const db = getDb()
  const limit = Math.min(opts.limit ?? 50, 200)
  const offset = opts.offset ?? 0

  const agentBind = opts.agent ? [opts.agent] : []
  const kindBind  = opts.kind && ARTIFACT_KINDS.has(opts.kind as ArtifactKind) ? [opts.kind] : []
  const q = opts.q?.trim()

  if (q) {
    // FTS5 MATCH: searches title, meta JSON, and textual body of non-binary artifacts
    const agentCond  = agentBind.length ? 'AND a.agent_id = ?' : ''
    const kindCond   = kindBind.length  ? 'AND a.kind = ?'     : ''
    return db.prepare(`
      SELECT a.id, a.agent_id, a.title, a.kind, a.mime, a.meta, a.source, a.created_at, a.updated_at
      FROM artifacts a
      WHERE a.rowid IN (SELECT rowid FROM artifacts_fts WHERE artifacts_fts MATCH ?)
      ${agentCond} ${kindCond}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `).all(ftsEscape(q), ...agentBind, ...kindBind, limit, offset) as ArtifactSummary[]
  }

  const conditions: string[] = []
  if (agentBind.length) conditions.push('agent_id = ?')
  if (kindBind.length)  conditions.push('kind = ?')
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return db.prepare(`
    SELECT id, agent_id, title, kind, mime, meta, source, created_at, updated_at
    FROM artifacts
    ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...agentBind, ...kindBind, limit, offset) as ArtifactSummary[]
}

// Escape FTS5 special characters to prevent query-syntax errors on user input.
// Wraps the term in double quotes so it is treated as a phrase, not as FTS5 operators.
function ftsEscape(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

export function getArtifact(id: string): ArtifactRow | undefined {
  return getDb()
    .prepare('SELECT * FROM artifacts WHERE id = ?')
    .get(id) as ArtifactRow | undefined
}

export function deleteArtifact(id: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM artifacts WHERE id = ?')
    .run(id)
  return result.changes > 0
}
