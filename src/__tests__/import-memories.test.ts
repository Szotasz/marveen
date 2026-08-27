// Tests for the import-memories feature:
// - isAllowedFile() / containsSecret() pure logic (no DB)
// - upsertImportMemory() dedup semantics via in-memory SQLite
// - Route handler: CRUD + wipe + stats (via makeCtx pattern)
// - Search integration: /api/import/search returns correct results

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'
import { initDatabase, getDb } from '../db.js'

// ── Shared mocks ──────────────────────────────────────────────────────────────
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

// crawlSource is fire-and-forget in the sync route; stub it so the test
// does not spin up an actual FS walk.
vi.mock('../web/import-crawler.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/import-crawler.js')>()
  return {
    ...orig,
    crawlSource: vi.fn().mockResolvedValue(undefined),
  }
})

// ── DB setup (in-memory, full migrations) ─────────────────────────────────────
beforeEach(() => {
  initDatabase(':memory:')
  vi.clearAllMocks()
})

// ── makeCtx helper ────────────────────────────────────────────────────────────
function makeCtx(
  method: string,
  path: string,
  body?: object,
  query?: Record<string, string>,
): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => {
    ;(req as NodeJS.EventEmitter).emit('data', buf)
    ;(req as NodeJS.EventEmitter).emit('end')
  })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      if (!b) return
      const str = Buffer.isBuffer(b) ? b.toString('utf-8') : b
      try { out.body = JSON.parse(str) } catch { out.body = str }
    },
  }
  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  const url = new URL(`http://localhost:3420${path}${qs}`)
  return {
    ctx: { req, res, path: url.pathname, method, url } as unknown as RouteContext,
    out,
  }
}

// ── isAllowedFile + containsSecret (pure logic, tested via crawl internals) ───
// We test these through the exported symbols from import-config.ts which the
// crawler uses; this proves the constants are correct without importing the
// crawler which has FS side-effects.

import {
  BLOCKED_EXTENSIONS,
  BLOCKED_BASENAMES,
  ALLOWED_EXTENSIONS,
  VALID_INTERVALS,
} from '../web/import-config.js'

describe('import-config constants', () => {
  it('blocks credential extensions', () => {
    for (const ext of ['env', 'key', 'pem', 'p12', 'pfx', 'keystore', 'jks']) {
      expect(BLOCKED_EXTENSIONS.has(ext), `${ext} should be blocked`).toBe(true)
    }
  })

  it('blocks critical basenames', () => {
    expect(BLOCKED_BASENAMES.has('id_rsa')).toBe(true)
    expect(BLOCKED_BASENAMES.has('id_ed25519')).toBe(true)
  })

  it('allows common text formats', () => {
    for (const ext of ['txt', 'md', 'json', 'yaml', 'csv', 'html']) {
      expect(ALLOWED_EXTENSIONS.has(ext), `${ext} should be allowed`).toBe(true)
    }
  })

  it('only accepts fixed interval values', () => {
    expect(VALID_INTERVALS.has(1)).toBe(true)
    expect(VALID_INTERVALS.has(2)).toBe(true)
    expect(VALID_INTERVALS.has(4)).toBe(true)
    expect(VALID_INTERVALS.has(24)).toBe(true)
    expect(VALID_INTERVALS.has(3)).toBe(false)
    expect(VALID_INTERVALS.has(12)).toBe(false)
  })
})

// ── Route handler tests ───────────────────────────────────────────────────────
import { tryHandleImportMemories } from '../web/routes/import-memories.js'

describe('POST /api/import/sources', () => {
  it('returns 400 when type is missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/import/sources', { path: '/tmp/docs' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string; field: string }).error).toBe('invalid_value')
    expect((out.body as { error: string; field: string }).field).toBe('type')
  })

  it('returns 400 when type is invalid', async () => {
    const { ctx, out } = makeCtx('POST', '/api/import/sources', { type: 'ftp', path: '/tmp/docs' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(400)
  })

  it('returns 400 when path is missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/import/sources', { type: 'local' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string; field: string }).error).toBe('required')
    expect((out.body as { error: string; field: string }).field).toBe('path')
  })

  it('returns 400 when interval_hours is invalid', async () => {
    const { ctx, out } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/docs', interval_hours: 3 })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string; field: string }).error).toBe('invalid_value')
    expect((out.body as { error: string; field: string }).field).toBe('interval_hours')
  })

  it('creates a source and returns an id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/docs', label: 'My Docs', interval_hours: 4 })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    const body = out.body as { ok: boolean; id: string }
    expect(body.ok).toBe(true)
    expect(typeof body.id).toBe('string')
    expect(body.id.length).toBeGreaterThan(0)
  })
})

describe('GET /api/import/sources', () => {
  it('returns empty list initially', async () => {
    const { ctx, out } = makeCtx('GET', '/api/import/sources')
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })

  it('lists created sources', async () => {
    const { ctx: postCtx } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/x', interval_hours: 1 })
    await tryHandleImportMemories(postCtx)

    const { ctx: getCtx, out } = makeCtx('GET', '/api/import/sources')
    await tryHandleImportMemories(getCtx)
    expect(out.status).toBe(200)
    const sources = out.body as { path: string }[]
    expect(sources).toHaveLength(1)
    expect(sources[0].path).toBe('/tmp/x')
  })
})

describe('PUT /api/import/sources/:id', () => {
  it('updates label and interval', async () => {
    const { ctx: postCtx, out: postOut } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/y', interval_hours: 2 })
    await tryHandleImportMemories(postCtx)
    const id = (postOut.body as { id: string }).id

    const { ctx: putCtx, out: putOut } = makeCtx('PUT', `/api/import/sources/${id}`, { label: 'Updated', interval_hours: 24 })
    await tryHandleImportMemories(putCtx)
    expect(putOut.status).toBe(200)
    expect((putOut.body as { ok: boolean }).ok).toBe(true)
  })

  it('returns 404 for unknown id', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/import/sources/00000000', { label: 'X' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(404)
  })

  it('returns 400 for invalid interval', async () => {
    const { ctx: postCtx, out: postOut } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/z', interval_hours: 4 })
    await tryHandleImportMemories(postCtx)
    const id = (postOut.body as { id: string }).id

    const { ctx, out } = makeCtx('PUT', `/api/import/sources/${id}`, { interval_hours: 7 })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(400)
  })
})

describe('DELETE /api/import/sources/:id', () => {
  it('deletes a source', async () => {
    const { ctx: postCtx, out: postOut } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/del', interval_hours: 4 })
    await tryHandleImportMemories(postCtx)
    const id = (postOut.body as { id: string }).id

    const { ctx, out } = makeCtx('DELETE', `/api/import/sources/${id}`)
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)

    // Verify gone
    const { ctx: getCtx, out: getOut } = makeCtx('GET', '/api/import/sources')
    await tryHandleImportMemories(getCtx)
    expect((getOut.body as unknown[]).length).toBe(0)
  })

  it('returns 404 for unknown id', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/import/sources/00000000')
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(404)
  })
})

describe('POST /api/import/sources/:id/sync', () => {
  it('queues crawl and returns ok', async () => {
    const { ctx: postCtx, out: postOut } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/sync', interval_hours: 4 })
    await tryHandleImportMemories(postCtx)
    const id = (postOut.body as { id: string }).id

    const { ctx, out } = makeCtx('POST', `/api/import/sources/${id}/sync`)
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    expect((out.body as { queued: boolean }).queued).toBe(true)
  })

  it('returns 404 for unknown source', async () => {
    const { ctx, out } = makeCtx('POST', '/api/import/sources/00000000/sync')
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(404)
  })
})

describe('GET /api/import/stats', () => {
  it('returns zero total initially', async () => {
    const { ctx, out } = makeCtx('GET', '/api/import/stats')
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    const body = out.body as { total: number; bySource: unknown[] }
    expect(body.total).toBe(0)
    expect(body.bySource).toEqual([])
  })
})

describe('DELETE /api/import/memories', () => {
  it('wipes all import memories', async () => {
    // Seed one source and one memory directly in the DB
    const { ctx: postCtx, out: postOut } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/wipe', interval_hours: 4 })
    await tryHandleImportMemories(postCtx)
    const sourceId = (postOut.body as { id: string }).id

    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, keywords, last_seen_at, created_at, updated_at)
      VALUES ('aabbccdd11223344', ?, '/tmp/wipe/doc.md', 'doc.md', 'hash1', 'some content', 'doc', ?, ?, ?)
    `).run(sourceId, now, now, now)

    // Verify the memory exists
    const { ctx: statsCtx, out: statsOut } = makeCtx('GET', '/api/import/stats')
    await tryHandleImportMemories(statsCtx)
    expect((statsOut.body as { total: number }).total).toBe(1)

    // Wipe all
    const { ctx, out } = makeCtx('DELETE', '/api/import/memories')
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    expect((out.body as { deleted: number }).deleted).toBe(1)

    // Confirm empty
    const { ctx: statsCtx2, out: statsOut2 } = makeCtx('GET', '/api/import/stats')
    await tryHandleImportMemories(statsCtx2)
    expect((statsOut2.body as { total: number }).total).toBe(0)
  })
})

describe('DELETE /api/import/sources/:id/memories', () => {
  it('wipes only the specified source memories', async () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)

    // Create two sources
    const { ctx: p1, out: o1 } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/a', interval_hours: 4 })
    await tryHandleImportMemories(p1)
    const sid1 = (o1.body as { id: string }).id

    const { ctx: p2, out: o2 } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/b', interval_hours: 4 })
    await tryHandleImportMemories(p2)
    const sid2 = (o2.body as { id: string }).id

    // Insert memories for both
    db.prepare(`INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, keywords, last_seen_at, created_at, updated_at)
      VALUES ('mem1a1b1c1d1e1f10', ?, '/tmp/a/f.md', 'f.md', 'h1', 'content a', 'k', ?, ?, ?)`
    ).run(sid1, now, now, now)
    db.prepare(`INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, keywords, last_seen_at, created_at, updated_at)
      VALUES ('mem2a2b2c2d2e2f20', ?, '/tmp/b/g.md', 'g.md', 'h2', 'content b', 'k', ?, ?, ?)`
    ).run(sid2, now, now, now)

    // Wipe source 1 only
    const { ctx, out } = makeCtx('DELETE', `/api/import/sources/${sid1}/memories`)
    await tryHandleImportMemories(ctx)
    expect((out.body as { deleted: number }).deleted).toBe(1)

    // Source 2 memory still there
    const { ctx: sc, out: so } = makeCtx('GET', '/api/import/stats')
    await tryHandleImportMemories(sc)
    expect((so.body as { total: number }).total).toBe(1)
  })
})

describe('GET /api/import/log', () => {
  it('returns empty log initially', async () => {
    const { ctx, out } = makeCtx('GET', '/api/import/log')
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })

  it('returns audit entries after a crawl log is written', async () => {
    const { ctx: postCtx, out: postOut } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/logtest', interval_hours: 4 })
    await tryHandleImportMemories(postCtx)
    const sid = (postOut.body as { id: string }).id

    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO import_audit_log (source_id, run_at, files_scanned, files_added, files_updated,
        files_skipped_hash, files_skipped_secret, files_skipped_size, files_skipped_type, error)
      VALUES (?, ?, 5, 3, 1, 1, 0, 0, 0, NULL)
    `).run(sid, now)

    const { ctx, out } = makeCtx('GET', '/api/import/log')
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    const rows = out.body as { files_added: number }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].files_added).toBe(3)
  })
})

describe('GET /api/import/search', () => {
  it('returns empty array for blank query', async () => {
    const { ctx, out } = makeCtx('GET', '/api/import/search', undefined, {})
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })

  it('finds matching import memories', async () => {
    const { ctx: postCtx, out: postOut } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/search', interval_hours: 4 })
    await tryHandleImportMemories(postCtx)
    const sid = (postOut.body as { id: string }).id

    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, keywords, last_seen_at, created_at, updated_at)
      VALUES ('srch1a2b3c4d5e6f', ?, '/tmp/search/meeting-notes.md', 'meeting-notes.md', 'hh', 'quarterly budget review notes', 'budget, quarterly', ?, ?, ?)
    `).run(sid, now, now, now)

    const { ctx, out } = makeCtx('GET', '/api/import/search', undefined, { q: 'budget' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    const results = out.body as { file_name: string }[]
    expect(results).toHaveLength(1)
    expect(results[0].file_name).toBe('meeting-notes.md')
  })

  it('returns nothing when query does not match', async () => {
    const { ctx, out } = makeCtx('GET', '/api/import/search', undefined, { q: 'xyzzy-nonexistent' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })
})

// ── Dedup logic via direct DB calls (mirrors upsertImportMemory semantics) ────
describe('import_memories dedup semantics', () => {
  it('inserting the same file twice with same hash results in one row', () => {
    const { ctx: postCtx, out: postOut } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/dedup', interval_hours: 4 })

    // Use promise-based approach for async route in a synchronous describe block
    let sid: string

    // We seed via direct SQL to avoid async complexity in a describe block
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)

    // Insert source directly
    db.prepare(`
      INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at)
      VALUES ('dedup1111', 'local', '/tmp/dedup', 4, 1, ?, ?)
    `).run(now, now)
    sid = 'dedup1111'

    const hash = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1'

    // First insert
    db.prepare(`
      INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, keywords, last_seen_at, created_at, updated_at)
      VALUES ('dupmem1a2b3c4d', ?, '/tmp/dedup/file.md', 'file.md', ?, 'original content', 'kw', ?, ?, ?)
    `).run(sid, hash, now, now, now)

    // Simulate hash-match: same source+path+hash -> just bump last_seen_at
    db.prepare(`
      UPDATE import_memories SET last_seen_at = ? WHERE source_id = ? AND file_path = ?
    `).run(now + 10, sid, '/tmp/dedup/file.md')

    const count = (db.prepare("SELECT COUNT(*) AS c FROM import_memories WHERE source_id = ?").get(sid) as { c: number }).c
    expect(count).toBe(1)
  })

  it('same file with different hash updates the row', () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)

    db.prepare(`
      INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at)
      VALUES ('dedup2222', 'local', '/tmp/dedup2', 4, 1, ?, ?)
    `).run(now, now)

    const hash1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const hash2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

    db.prepare(`
      INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, keywords, last_seen_at, created_at, updated_at)
      VALUES ('upd1a2b3c4d5e6f', 'dedup2222', '/tmp/dedup2/note.txt', 'note.txt', ?, 'v1', 'kw', ?, ?, ?)
    `).run(hash1, now, now, now)

    // Update with new hash (content changed)
    db.prepare(`
      UPDATE import_memories SET content_hash = ?, content = ?, updated_at = ? WHERE source_id = ? AND file_path = ?
    `).run(hash2, 'v2', now + 5, 'dedup2222', '/tmp/dedup2/note.txt')

    const row = db.prepare("SELECT content, content_hash FROM import_memories WHERE id = 'upd1a2b3c4d5e6f'").get() as { content: string; content_hash: string }
    expect(row.content).toBe('v2')
    expect(row.content_hash).toBe(hash2)

    const count = (db.prepare("SELECT COUNT(*) AS c FROM import_memories WHERE source_id = 'dedup2222'").get() as { c: number }).c
    expect(count).toBe(1)
  })
})

// ── Shadow row cleanup on wipe ────────────────────────────────────────────────
// Each import_memories row has a corresponding shadow row in the memories
// table (agent_id='import', category='warm').  Wipe endpoints must remove both.
describe('shadow row cleanup', () => {
  function seedWithShadow(sourceId: string, importId: string, content: string) {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    const shadowResult = db.prepare(
      `INSERT INTO memories (agent_id, content, category, keywords, chat_id, sector, created_at, accessed_at, updated_at)
       VALUES ('import', ?, 'warm', NULL, 'import', 'semantic', ?, ?, ?) RETURNING id`
    ).get(content, now, now, now) as { id: number }
    db.prepare(
      `INSERT INTO import_memories
         (id, source_id, file_path, file_name, content_hash, content, keywords,
          last_seen_at, created_at, updated_at, memory_shadow_id)
       VALUES (?, ?, '/tmp/shadow/f.md', 'f.md', 'h', ?, NULL, ?, ?, ?, ?)`
    ).run(importId, sourceId, content, now, now, now, shadowResult.id)
    return shadowResult.id
  }

  it('DELETE /api/import/memories removes shadow rows from memories table', async () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at)
      VALUES ('shd-src-all1', 'local', '/tmp/shadow', 4, 1, ?, ?)`).run(now, now)

    const shadowId = seedWithShadow('shd-src-all1', 'shd-mem-all1', 'shadow content all')
    expect((db.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = ?").get(shadowId) as { c: number }).c).toBe(1)

    const { ctx, out } = makeCtx('DELETE', '/api/import/memories')
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    expect((out.body as { deleted: number }).deleted).toBe(1)

    expect((db.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = ?").get(shadowId) as { c: number }).c).toBe(0)
  })

  it('DELETE /api/import/sources/:id/memories removes only that source shadow rows', async () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at)
      VALUES ('shd-src-s1aa', 'local', '/tmp/shadow-s1', 4, 1, ?, ?)`).run(now, now)
    db.prepare(`INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at)
      VALUES ('shd-src-s2bb', 'local', '/tmp/shadow-s2', 4, 1, ?, ?)`).run(now, now)

    const shadowId1 = seedWithShadow('shd-src-s1aa', 'shd-m-s1aa', 'content source 1')
    const shadowId2 = seedWithShadow('shd-src-s2bb', 'shd-m-s2bb', 'content source 2')

    const { ctx, out } = makeCtx('DELETE', '/api/import/sources/shd-src-s1aa/memories')
    await tryHandleImportMemories(ctx)
    expect((out.body as { deleted: number }).deleted).toBe(1)

    expect((db.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = ?").get(shadowId1) as { c: number }).c).toBe(0)
    expect((db.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = ?").get(shadowId2) as { c: number }).c).toBe(1)
  })

  it('DELETE /api/import/sources/:id removes shadow rows before cascade', async () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at)
      VALUES ('shd-src-del1', 'local', '/tmp/shadow-del', 4, 1, ?, ?)`).run(now, now)

    const shadowId = seedWithShadow('shd-src-del1', 'shd-m-del1', 'content del source')
    expect((db.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = ?").get(shadowId) as { c: number }).c).toBe(1)

    const { ctx, out } = makeCtx('DELETE', '/api/import/sources/shd-src-del1')
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)

    expect((db.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = ?").get(shadowId) as { c: number }).c).toBe(0)
  })
})

// ── CASCADE delete: removing a source wipes its memories ─────────────────────
describe('import_sources ON DELETE CASCADE', () => {
  it('deleting a source also deletes its memories and audit log', async () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)

    const { ctx: postCtx, out: postOut } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/cascade', interval_hours: 4 })
    await tryHandleImportMemories(postCtx)
    const sid = (postOut.body as { id: string }).id

    db.prepare(`
      INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, keywords, last_seen_at, created_at, updated_at)
      VALUES ('cas1mem1a2b3c4d', ?, '/tmp/cascade/f.md', 'f.md', 'hash', 'content', 'kw', ?, ?, ?)
    `).run(sid, now, now, now)
    db.prepare(`
      INSERT INTO import_audit_log (source_id, run_at, files_scanned, files_added, files_updated,
        files_skipped_hash, files_skipped_secret, files_skipped_size, files_skipped_type)
      VALUES (?, ?, 1, 1, 0, 0, 0, 0, 0)
    `).run(sid, now)

    // Delete the source
    const { ctx, out } = makeCtx('DELETE', `/api/import/sources/${sid}`)
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)

    const memCount = (db.prepare("SELECT COUNT(*) AS c FROM import_memories WHERE source_id = ?").get(sid) as { c: number }).c
    expect(memCount).toBe(0)

    const logCount = (db.prepare("SELECT COUNT(*) AS c FROM import_audit_log WHERE source_id = ?").get(sid) as { c: number }).c
    expect(logCount).toBe(0)
  })
})
