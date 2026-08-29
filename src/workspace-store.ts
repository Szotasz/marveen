// workspace-store.ts — DB helpers for workspace_docs.
//
// App-level vec sync follows the vec_memories pattern (db.ts:2798):
// NO database triggers. Vec operations are fire-and-forget when the extension
// is available; missing extension = silent skip.
//
// Size limits (enforced at the route layer, not here):
//   text   ≤ 2 MB
//   code   ≤ 4 MB
//   binary ≤ 16 MB

import { randomBytes } from 'node:crypto'
import { getDb } from './db.js'

export const WORKSPACE_DOC_SIZE_LIMITS: Record<string, number> = {
  text:   2 * 1024 * 1024,
  code:   4 * 1024 * 1024,
  binary: 16 * 1024 * 1024,
}

export type WorkspaceDocType = 'plan' | 'brief' | 'report' | 'notes'
export type WorkspaceContentType = 'text' | 'code' | 'binary'

export interface WorkspaceDoc {
  id: string
  agent_id: string
  tenant_id: string
  doc_key: string | null
  title: string
  content: string | null
  content_type: WorkspaceContentType
  type: WorkspaceDocType
  task_ref: string | null
  size_bytes: number
  last_accessed_at: number | null
  created_at: number
  updated_at: number
}

type DbRow = WorkspaceDoc & { content_blob: Buffer | null; embedding_blob: Buffer | null }

function rowToDoc(r: DbRow): WorkspaceDoc {
  return {
    id: r.id, agent_id: r.agent_id, tenant_id: r.tenant_id,
    doc_key: r.doc_key, title: r.title, content: r.content,
    content_type: r.content_type, type: r.type, task_ref: r.task_ref,
    size_bytes: r.size_bytes, last_accessed_at: r.last_accessed_at,
    created_at: r.created_at, updated_at: r.updated_at,
  }
}

function nanoid12(): string {
  return randomBytes(9).toString('base64url').slice(0, 12)
}

// ── Vec sync helpers (no-op when vec extension not loaded) ───────────────────

let _vecSupported: boolean | null = null

function vecEnabled(): boolean {
  if (_vecSupported !== null) return _vecSupported
  try {
    // Probe: if the virtual table exists, the extension is loaded.
    getDb().prepare("SELECT 1 FROM vec_workspace_docs LIMIT 1").raw(true).all()
    _vecSupported = true
  } catch {
    _vecSupported = false
  }
  return _vecSupported
}

function syncVecDelete(docId: string): void {
  if (!vecEnabled()) return
  try { getDb().prepare('DELETE FROM vec_workspace_docs WHERE doc_id = ?').run(docId) } catch { /* no-op */ }
}

function syncVecUpsert(docId: string, agentId: string, tenantId: string, embeddingBlob: Buffer): void {
  if (!vecEnabled()) return
  try {
    const db = getDb()
    db.prepare('DELETE FROM vec_workspace_docs WHERE doc_id = ?').run(docId)
    db.prepare('INSERT OR IGNORE INTO vec_workspace_docs(doc_id, agent_id, tenant_id, embedding) VALUES(?, ?, ?, ?)')
      .run(docId, agentId, tenantId, embeddingBlob)
  } catch { /* no-op */ }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export interface SaveWorkspaceDocInput {
  agent_id: string
  tenant_id: string
  doc_key?: string | null
  title: string
  content?: string | null
  content_blob?: Buffer | null
  content_type: WorkspaceContentType
  type: WorkspaceDocType
  task_ref?: string | null
  embedding_blob?: Buffer | null
}

export function saveWorkspaceDoc(input: SaveWorkspaceDocInput): WorkspaceDoc {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const content = input.content ?? null
  const contentBlob = input.content_blob ?? null
  const sizeBytes = content
    ? Buffer.byteLength(content, 'utf8')
    : (contentBlob ? contentBlob.byteLength : 0)

  if (input.doc_key) {
    // UPSERT: check if (agent_id, doc_key) already exists
    const existing = db.prepare(
      'SELECT id FROM workspace_docs WHERE agent_id = ? AND doc_key = ?'
    ).get(input.agent_id, input.doc_key) as { id: string } | undefined

    if (existing) {
      db.prepare(`
        UPDATE workspace_docs
        SET title = ?, content = ?, content_blob = ?, content_type = ?, type = ?,
            task_ref = ?, size_bytes = ?, embedding_blob = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.title, content, contentBlob, input.content_type, input.type,
        input.task_ref ?? null, sizeBytes, input.embedding_blob ?? null, now,
        existing.id
      )
      const row = db.prepare('SELECT * FROM workspace_docs WHERE id = ?').get(existing.id) as DbRow
      if (input.embedding_blob && input.content_type !== 'binary') {
        syncVecUpsert(existing.id, input.agent_id, input.tenant_id, input.embedding_blob)
      }
      return rowToDoc(row)
    }
  }

  // INSERT new
  const id = nanoid12()
  db.prepare(`
    INSERT INTO workspace_docs
      (id, agent_id, tenant_id, doc_key, title, content, content_blob, content_type,
       type, task_ref, size_bytes, embedding_blob, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.agent_id, input.tenant_id, input.doc_key ?? null,
    input.title, content, contentBlob, input.content_type,
    input.type, input.task_ref ?? null, sizeBytes,
    input.embedding_blob ?? null, now, now
  )
  const row = db.prepare('SELECT * FROM workspace_docs WHERE id = ?').get(id) as DbRow
  if (input.embedding_blob && input.content_type !== 'binary') {
    syncVecUpsert(id, input.agent_id, input.tenant_id, input.embedding_blob)
  }
  return rowToDoc(row)
}

// Lightweight auth-gate check: returns id/agent_id/tenant_id/content_type/title
// without touching last_accessed_at.  Use this before any ownership/tenant gate.
export function peekWorkspaceDoc(id: string): Pick<WorkspaceDoc, 'id' | 'agent_id' | 'tenant_id' | 'content_type' | 'title'> | null {
  const row = getDb().prepare(
    'SELECT id, agent_id, tenant_id, content_type, title FROM workspace_docs WHERE id = ?'
  ).get(id) as Pick<WorkspaceDoc, 'id' | 'agent_id' | 'tenant_id' | 'content_type' | 'title'> | undefined
  return row ?? null
}

export function getWorkspaceDoc(id: string): WorkspaceDoc | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM workspace_docs WHERE id = ?').get(id) as DbRow | undefined
  if (!row) return null
  const now = Math.floor(Date.now() / 1000)
  db.prepare('UPDATE workspace_docs SET last_accessed_at = ? WHERE id = ?').run(now, id)
  return rowToDoc(row)
}

export function getWorkspaceDocBlob(id: string): Buffer | null {
  const row = getDb().prepare('SELECT content_blob FROM workspace_docs WHERE id = ?').get(id) as { content_blob: Buffer | null } | undefined
  return row?.content_blob ?? null
}

export interface ListWorkspaceDocsFilter {
  agentId?: string
  tenantId?: string | null
  type?: WorkspaceDocType
  contentType?: WorkspaceContentType
  taskRef?: string
}

export function listWorkspaceDocs(filter: ListWorkspaceDocsFilter): WorkspaceDoc[] {
  let sql = 'SELECT * FROM workspace_docs WHERE 1=1'
  const params: unknown[] = []
  if (filter.agentId) { sql += ' AND agent_id = ?'; params.push(filter.agentId) }
  if (filter.tenantId !== null && filter.tenantId !== undefined) {
    sql += ' AND tenant_id = ?'; params.push(filter.tenantId)
  }
  if (filter.type) { sql += ' AND type = ?'; params.push(filter.type) }
  if (filter.contentType) { sql += ' AND content_type = ?'; params.push(filter.contentType) }
  if (filter.taskRef) { sql += ' AND task_ref = ?'; params.push(filter.taskRef) }
  sql += ' ORDER BY updated_at DESC'
  const rows = getDb().prepare(sql).all(...params) as DbRow[]
  return rows.map(rowToDoc)
}

export interface PatchWorkspaceDocInput {
  title?: string
  content?: string | null
  content_blob?: Buffer | null
  type?: WorkspaceDocType
  task_ref?: string | null
  embedding_blob?: Buffer | null
}

export function patchWorkspaceDoc(id: string, patch: PatchWorkspaceDocInput): WorkspaceDoc | null {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM workspace_docs WHERE id = ?').get(id) as DbRow | undefined
  if (!existing) return null

  const now = Math.floor(Date.now() / 1000)
  const newContent = 'content' in patch ? patch.content ?? null : existing.content
  const newBlob = 'content_blob' in patch ? patch.content_blob ?? null : existing.content_blob
  const sizeBytes = newContent
    ? Buffer.byteLength(newContent, 'utf8')
    : (newBlob ? newBlob.byteLength : 0)

  db.prepare(`
    UPDATE workspace_docs
    SET title = ?, content = ?, content_blob = ?, type = ?, task_ref = ?,
        size_bytes = ?, embedding_blob = ?, updated_at = ?
    WHERE id = ?
  `).run(
    patch.title ?? existing.title,
    newContent, newBlob,
    patch.type ?? existing.type,
    'task_ref' in patch ? patch.task_ref ?? null : existing.task_ref,
    sizeBytes,
    patch.embedding_blob ?? existing.embedding_blob,
    now, id
  )

  if (patch.embedding_blob && existing.content_type !== 'binary') {
    syncVecUpsert(id, existing.agent_id, existing.tenant_id, patch.embedding_blob)
  }
  const row = db.prepare('SELECT * FROM workspace_docs WHERE id = ?').get(id) as DbRow
  return rowToDoc(row)
}

export function deleteWorkspaceDoc(id: string): boolean {
  syncVecDelete(id)
  const res = getDb().prepare('DELETE FROM workspace_docs WHERE id = ?').run(id)
  return res.changes > 0
}

// ── TTL sweeper ──────────────────────────────────────────────────────────────
// Deletes docs where:
//   - task_ref IS NULL or the kanban card is 'done'
//   - content_type != 'binary' (binary has separate longer-lived policy)
//   - updated_at older than ttlDays
// Returns count of deleted rows.

export function sweepExpiredWorkspaceDocs(ttlDays: number): number {
  const db = getDb()
  const ttlSeconds = ttlDays * 86400
  const now = Math.floor(Date.now() / 1000)

  // Collect IDs to delete first (so we can clean vec index).
  const toDelete = db.prepare(`
    SELECT wd.id FROM workspace_docs wd
    LEFT JOIN kanban_cards kc ON kc.id = wd.task_ref
    WHERE
      (wd.task_ref IS NULL OR kc.status = 'done')
      AND (? - wd.updated_at) > ?
      AND wd.content_type != 'binary'
  `).all(now, ttlSeconds) as { id: string }[]

  if (!toDelete.length) return 0

  const tx = db.transaction(() => {
    for (const { id } of toDelete) syncVecDelete(id)
    db.prepare(`
      DELETE FROM workspace_docs
      WHERE id IN (
        SELECT wd.id FROM workspace_docs wd
        LEFT JOIN kanban_cards kc ON kc.id = wd.task_ref
        WHERE
          (wd.task_ref IS NULL OR kc.status = 'done')
          AND (? - wd.updated_at) > ?
          AND wd.content_type != 'binary'
      )
    `).run(now, ttlSeconds)
  })
  tx()
  return toDelete.length
}

