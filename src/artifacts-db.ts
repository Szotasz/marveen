import { getDb } from './db.js'

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
  return { id: row.id }
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
  const conditions: string[] = []
  const bindings: unknown[] = []

  if (opts.agent) {
    conditions.push('agent_id = ?')
    bindings.push(opts.agent)
  }
  if (opts.kind && ARTIFACT_KINDS.has(opts.kind as ArtifactKind)) {
    conditions.push('kind = ?')
    bindings.push(opts.kind)
  }
  if (opts.q?.trim()) {
    conditions.push("(title LIKE ? OR source LIKE ? OR meta LIKE ?)")
    const term = `%${opts.q.trim()}%`
    bindings.push(term, term, term)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.min(opts.limit ?? 50, 200)
  const offset = opts.offset ?? 0
  bindings.push(limit, offset)

  return db.prepare(`
    SELECT id, agent_id, title, kind, mime, meta, source, created_at, updated_at
    FROM artifacts
    ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...bindings) as ArtifactSummary[]
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
