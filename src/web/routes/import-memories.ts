import { createHash } from 'node:crypto'
import { getDb, syncVecMemoryDelete } from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { crawlSource } from '../import-crawler.js'
import { VALID_INTERVALS } from '../import-config.js'
import type { RouteContext } from './types.js'

function genId(): string {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 8)
}

type ImportSource = {
  id: string; type: string; path: string; label: string | null
  interval_hours: number; enabled: number; last_run_at: number | null
  created_at: number; updated_at: number
}

type AuditRow = {
  id: number; source_id: string; run_at: number
  files_scanned: number; files_added: number; files_updated: number
  files_skipped_hash: number; files_skipped_secret: number
  files_skipped_size: number; files_skipped_type: number
  error: string | null
}

export async function tryHandleImportMemories(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // ── GET /api/import/sources ──────────────────────────────────────────────
  if (path === '/api/import/sources' && method === 'GET') {
    const rows = getDb().prepare("SELECT * FROM import_sources ORDER BY created_at ASC").all() as ImportSource[]
    json(res, rows)
    return true
  }

  // ── POST /api/import/sources ─────────────────────────────────────────────
  if (path === '/api/import/sources' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      type?: string; path?: string; label?: string; interval_hours?: number; enabled?: boolean
    }

    if (!data.type || !['local', 'gdrive', 'sharepoint'].includes(data.type)) {
      json(res, { error: 'invalid_value', field: 'type', hint: 'type must be local | gdrive | sharepoint' }, 400); return true
    }
    if (!data.path?.trim()) {
      json(res, { error: 'required', field: 'path', hint: 'path is required' }, 400); return true
    }
    const intervalHours = data.interval_hours ?? 4
    if (!VALID_INTERVALS.has(intervalHours)) {
      json(res, { error: 'invalid_value', field: 'interval_hours', hint: `interval_hours must be one of: ${[...VALID_INTERVALS].join(', ')}` }, 400); return true
    }

    const now = Math.floor(Date.now() / 1000)
    const id = genId()
    getDb().prepare(`
      INSERT INTO import_sources (id, type, path, label, interval_hours, enabled, last_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(id, data.type, data.path.trim(), data.label?.trim() || null, intervalHours, data.enabled !== false ? 1 : 0, now, now)

    logger.info({ id, type: data.type, path: data.path }, 'Import source created')
    json(res, { ok: true, id })
    return true
  }

  // ── PUT /api/import/sources/:id ──────────────────────────────────────────
  const sourceMatch = path.match(/^\/api\/import\/sources\/([a-zA-Z0-9_-]+)$/)
  if (sourceMatch && method === 'PUT') {
    const id = sourceMatch[1]
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      label?: string; interval_hours?: number; enabled?: boolean; path?: string
    }
    const now = Math.floor(Date.now() / 1000)
    const db = getDb()
    const existing = db.prepare("SELECT id FROM import_sources WHERE id = ?").get(id)
    if (!existing) { json(res, { error: 'not_found' }, 404); return true }

    if (data.interval_hours !== undefined && !VALID_INTERVALS.has(data.interval_hours)) {
      json(res, { error: 'invalid_value', field: 'interval_hours', hint: `interval_hours must be one of: ${[...VALID_INTERVALS].join(', ')}` }, 400); return true
    }

    const fields: string[] = ['updated_at = ?']
    const values: unknown[] = [now]
    if (data.label !== undefined) { fields.push('label = ?'); values.push(data.label?.trim() || null) }
    if (data.interval_hours !== undefined) { fields.push('interval_hours = ?'); values.push(data.interval_hours) }
    if (data.enabled !== undefined) { fields.push('enabled = ?'); values.push(data.enabled ? 1 : 0) }
    if (data.path !== undefined) { fields.push('path = ?'); values.push(data.path.trim()) }
    values.push(id)

    db.prepare(`UPDATE import_sources SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    json(res, { ok: true })
    return true
  }

  // ── DELETE /api/import/sources/:id ──────────────────────────────────────
  if (sourceMatch && method === 'DELETE') {
    const id = sourceMatch[1]
    const db = getDb()
    const shadowIds = db.prepare(
      'SELECT memory_shadow_id FROM import_memories WHERE source_id = ? AND memory_shadow_id IS NOT NULL'
    ).all(id) as { memory_shadow_id: number }[]
    // NULL out FK before deleting shadow rows so the FK constraint is not violated.
    if (shadowIds.length) {
      db.prepare('UPDATE import_memories SET memory_shadow_id = NULL WHERE source_id = ?').run(id)
    }
    const changes = db.prepare("DELETE FROM import_sources WHERE id = ?").run(id).changes
    if (!changes) { json(res, { error: 'not_found' }, 404); return true }
    if (shadowIds.length) {
      const ph = shadowIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM memories WHERE id IN (${ph})`).run(...shadowIds.map(r => r.memory_shadow_id))
      for (const r of shadowIds) syncVecMemoryDelete(r.memory_shadow_id)
    }
    json(res, { ok: true })
    return true
  }

  // ── POST /api/import/sources/:id/sync ────────────────────────────────────
  const syncMatch = path.match(/^\/api\/import\/sources\/([a-zA-Z0-9_-]+)\/sync$/)
  if (syncMatch && method === 'POST') {
    const id = syncMatch[1]
    const existing = getDb().prepare("SELECT id FROM import_sources WHERE id = ?").get(id)
    if (!existing) { json(res, { error: 'not_found' }, 404); return true }
    // Fire-and-forget; the crawl runs in the background
    crawlSource(id).catch(err => logger.error({ sourceId: id, err }, 'Manual sync error'))
    json(res, { ok: true, queued: true })
    return true
  }

  // ── GET /api/import/sources/:id/log ─────────────────────────────────────
  const logMatch = path.match(/^\/api\/import\/sources\/([a-zA-Z0-9_-]+)\/log$/)
  if (logMatch && method === 'GET') {
    const id = logMatch[1]
    const rows = getDb().prepare(
      "SELECT * FROM import_audit_log WHERE source_id = ? ORDER BY run_at DESC LIMIT 20"
    ).all(id) as AuditRow[]
    json(res, rows)
    return true
  }

  // ── GET /api/import/log ──────────────────────────────────────────────────
  if (path === '/api/import/log' && method === 'GET') {
    const rows = getDb().prepare(
      "SELECT * FROM import_audit_log ORDER BY run_at DESC LIMIT 50"
    ).all() as AuditRow[]
    json(res, rows)
    return true
  }

  // ── DELETE /api/import/sources/:id/memories ──────────────────────────────
  const wipeSourceMatch = path.match(/^\/api\/import\/sources\/([a-zA-Z0-9_-]+)\/memories$/)
  if (wipeSourceMatch && method === 'DELETE') {
    const id = wipeSourceMatch[1]
    const db = getDb()
    const shadowIds = db.prepare(
      'SELECT memory_shadow_id FROM import_memories WHERE source_id = ? AND memory_shadow_id IS NOT NULL'
    ).all(id) as { memory_shadow_id: number }[]
    if (shadowIds.length) {
      db.prepare('UPDATE import_memories SET memory_shadow_id = NULL WHERE source_id = ?').run(id)
    }
    const changes = db.prepare("DELETE FROM import_memories WHERE source_id = ?").run(id).changes
    if (shadowIds.length) {
      const ph = shadowIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM memories WHERE id IN (${ph})`).run(...shadowIds.map(r => r.memory_shadow_id))
      for (const r of shadowIds) syncVecMemoryDelete(r.memory_shadow_id)
    }
    json(res, { ok: true, deleted: changes })
    return true
  }

  // ── DELETE /api/import/memories ──────────────────────────────────────────
  if (path === '/api/import/memories' && method === 'DELETE') {
    const db = getDb()
    const shadowIds = db.prepare(
      'SELECT memory_shadow_id FROM import_memories WHERE memory_shadow_id IS NOT NULL'
    ).all() as { memory_shadow_id: number }[]
    if (shadowIds.length) {
      db.prepare('UPDATE import_memories SET memory_shadow_id = NULL').run()
    }
    const changes = db.prepare("DELETE FROM import_memories").run().changes
    if (shadowIds.length) {
      const ph = shadowIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM memories WHERE id IN (${ph})`).run(...shadowIds.map(r => r.memory_shadow_id))
      for (const r of shadowIds) syncVecMemoryDelete(r.memory_shadow_id)
    }
    logger.info({ deleted: changes }, 'Import memories wiped')
    json(res, { ok: true, deleted: changes })
    return true
  }

  // ── GET /api/import/stats ─────────────────────────────────────────────────
  if (path === '/api/import/stats' && method === 'GET') {
    const db = getDb()
    const total = (db.prepare("SELECT COUNT(*) AS c FROM import_memories").get() as { c: number }).c
    const bySource = db.prepare(
      "SELECT source_id, COUNT(*) AS c FROM import_memories GROUP BY source_id"
    ).all() as { source_id: string; c: number }[]
    json(res, { total, bySource })
    return true
  }

  // ── GET /api/import/search ───────────────────────────────────────────────
  if (path === '/api/import/search' && method === 'GET') {
    const { url } = ctx
    const q = url.searchParams.get('q')?.trim() || ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
    if (!q) { json(res, []); return true }

    const rows = getDb().prepare(`
      SELECT id, source_id, file_path, file_name, keywords,
             substr(content, 1, 300) AS preview, created_at, updated_at
      FROM import_memories
      WHERE content LIKE ? OR keywords LIKE ? OR file_name LIKE ?
      ORDER BY updated_at DESC LIMIT ?
    `).all(`%${q}%`, `%${q}%`, `%${q}%`, limit)
    json(res, rows)
    return true
  }

  return false
}
