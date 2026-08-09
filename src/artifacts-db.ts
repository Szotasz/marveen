import { getDb, generateEmbedding } from './db.js'
import { logger } from './logger.js'

// At this row count the HNSW graph may benefit from a periodic re-index.
const VEC_REBUILD_THRESHOLD = 10_000

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
  cloud_url: string | null
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
  cloud_url: string | null
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
  cloud_url?: string
}

const DEFAULT_MIME: Record<ArtifactKind, string> = {
  html:     'text/html; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  json:     'application/json; charset=utf-8',
  text:     'text/plain; charset=utf-8',
  binary:   'application/octet-stream',
}

export function createArtifact(params: CreateArtifactParams): { id: string; updated: boolean } {
  const db = getDb()
  const mime = params.mime ?? DEFAULT_MIME[params.kind]
  const meta = JSON.stringify(params.meta ?? {})

  if (params.cloud_url) {
    // UPSERT path: dedup on cloud_url; only updates rows that are already
    // cloud-sourced (WHERE source = 'cloud:artifact') to prevent accidental
    // overwrites of locally-created artifacts that happen to share a URL.
    const existing = db.prepare('SELECT id FROM artifacts WHERE cloud_url = ?')
      .get(params.cloud_url) as { id: string } | undefined
    const source = params.source ?? 'cloud:artifact'
    const row = db.prepare(`
      INSERT INTO artifacts (agent_id, title, kind, mime, content, meta, source, cloud_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cloud_url) DO UPDATE SET
        content    = excluded.content,
        title      = excluded.title,
        updated_at = unixepoch()
      WHERE source = 'cloud:artifact'
      RETURNING id
    `).get(
      params.agent_id, params.title, params.kind, mime, params.content, meta, source, params.cloud_url,
    ) as { id: string }
    storeArtifactEmbedding(row.id, params.title, meta).catch(() => { /* non-critical */ })
    return { id: row.id, updated: !!existing }
  }

  // Standard insert path (no cloud_url)
  const row = db.prepare(`
    INSERT INTO artifacts (agent_id, title, kind, mime, content, meta, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(params.agent_id, params.title, params.kind, mime, params.content, meta, params.source ?? null) as { id: string }
  // Fire-and-forget: index title+meta embedding for semantic search
  storeArtifactEmbedding(row.id, params.title, meta).catch(() => { /* non-critical */ })
  return { id: row.id, updated: false }
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
    const { c } = db.prepare('SELECT COUNT(*) as c FROM vec_artifacts').get() as { c: number }
    if (c >= VEC_REBUILD_THRESHOLD) {
      logger.warn({ vec_count: c }, 'vec_artifacts index approaching rebuild threshold; consider running a periodic VACUUM or re-index')
    }
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
      SELECT a.id, a.agent_id, a.title, a.kind, a.mime, a.meta, a.source, a.cloud_url, a.created_at, a.updated_at
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
    SELECT id, agent_id, title, kind, mime, meta, source, cloud_url, created_at, updated_at
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

export const ARTIFACT_TITLE_MAX_LENGTH = 250

/**
 * Rename an artifact's title. Returns true on success, false when the id is
 * not found. The FTS index is updated automatically via the artifacts_fts_au
 * trigger defined in migration 0010.
 */
export function renameArtifact(id: string, title: string): boolean {
  const result = getDb()
    .prepare('UPDATE artifacts SET title = ? WHERE id = ?')
    .run(title, id)
  if (result.changes === 0) return false
  // Re-index embedding so semantic search reflects the new title (fire-and-forget)
  const row = getDb().prepare('SELECT meta FROM artifacts WHERE id = ?').get(id) as { meta: string } | undefined
  if (row) storeArtifactEmbedding(id, title, row.meta).catch(() => { /* non-critical */ })
  return true
}

export interface ArtifactStats {
  artifact_count: number
  /** Number of rows in vec_artifacts (ANN index). -1 when sqlite-vec is unavailable. */
  vec_count: number
  /** True when vec_count exceeds the rebuild-consideration threshold. */
  vec_rebuild_suggested: boolean
}

export function getArtifactStats(): ArtifactStats {
  const db = getDb()
  const { c: artifact_count } = db.prepare('SELECT COUNT(*) as c FROM artifacts').get() as { c: number }
  let vec_count = -1
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM vec_artifacts').get() as { c: number } | undefined
    if (row) vec_count = row.c
  } catch {
    // sqlite-vec extension unavailable -- graceful no-op
  }
  return {
    artifact_count,
    vec_count,
    vec_rebuild_suggested: vec_count >= VEC_REBUILD_THRESHOLD,
  }
}
