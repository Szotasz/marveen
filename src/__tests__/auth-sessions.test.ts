import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase, getDb, createDashboardUser } from '../db.js'
import {
  createSession,
  resolveSession,
  revokeSession,
  revokeAllForUser,
  listUserSessions,
  sweepExpiredSessions,
  _clearSessionCacheForTest,
} from '../web/auth-sessions.js'

// Real on-disk temp DB (dbPathOverride pattern) so restart-rehydration can be
// exercised by re-opening the same file with a fresh handle.
const TMP = mkdtempSync(join(tmpdir(), 'auth-sessions-test-'))
const DB_PATH = join(TMP, 'test.db')

const DAY = 24 * 60 * 60 * 1000

function makeUser(name: string) {
  return createDashboardUser(name, '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
}

beforeEach(() => {
  vi.useRealTimers()
  initDatabase(DB_PATH)
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
})

afterAll(() => {
  vi.useRealTimers()
  rmSync(TMP, { recursive: true, force: true })
})

describe('createSession / resolveSession', () => {
  it('mints a token that resolves to its user', () => {
    const u = makeUser('alice')
    const token = createSession({ userId: u.id, username: u.username })
    expect(resolveSession(token)).toEqual({ userId: u.id, username: 'alice' })
  })

  it('stores only sha256(token) at rest, never the raw token', () => {
    const u = makeUser('alice')
    const token = createSession({ userId: u.id, username: u.username })
    const rows = getDb().prepare('SELECT id_hash FROM auth_sessions').all() as { id_hash: string }[]
    expect(rows.length).toBe(1)
    expect(rows[0].id_hash).not.toBe(token)
    expect(rows[0].id_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns null for an unknown/empty token', () => {
    expect(resolveSession('nope')).toBeNull()
    expect(resolveSession('')).toBeNull()
  })
})

describe('TTLs', () => {
  it('expires after 7 days idle despite a valid cookie', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const u = makeUser('idle')
    const token = createSession({ userId: u.id, username: u.username })
    vi.setSystemTime(new Date('2026-01-08T00:00:01Z')) // > 7 days later
    expect(resolveSession(token)).toBeNull()
    // expired row is cleaned up
    expect(getDb().prepare('SELECT COUNT(*) c FROM auth_sessions').get()).toEqual({ c: 0 })
  })

  it('expires after 30 days absolute even with continuous activity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const u = makeUser('active')
    const token = createSession({ userId: u.id, username: u.username })
    // Keep touching it every 5 days (within idle TTL) for 31 days.
    for (let d = 5; d <= 29; d += 5) {
      vi.setSystemTime(new Date(2026, 0, 1 + d))
      expect(resolveSession(token)).not.toBeNull()
    }
    vi.setSystemTime(new Date('2026-02-01T00:00:01Z')) // > 30 days from creation
    expect(resolveSession(token)).toBeNull()
  })

  it('debounces last_seen writes to >= 60s apart', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const u = makeUser('deb')
    const token = createSession({ userId: u.id, username: u.username })
    const initial = (getDb().prepare('SELECT last_seen_at c FROM auth_sessions').get() as { c: number }).c
    // 30s later: within debounce window -> no DB write
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'))
    resolveSession(token)
    expect((getDb().prepare('SELECT last_seen_at c FROM auth_sessions').get() as { c: number }).c).toBe(initial)
    // 61s later: past debounce -> DB write
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
    resolveSession(token)
    expect((getDb().prepare('SELECT last_seen_at c FROM auth_sessions').get() as { c: number }).c).toBeGreaterThan(initial)
  })
})

describe('revocation', () => {
  it('revokes a single session', () => {
    const u = makeUser('rev')
    const token = createSession({ userId: u.id, username: u.username })
    revokeSession(token)
    expect(resolveSession(token)).toBeNull()
  })

  it('revokes all sessions of a user', () => {
    const u = makeUser('multi')
    const a = createSession({ userId: u.id, username: u.username })
    const b = createSession({ userId: u.id, username: u.username })
    revokeAllForUser(u.id)
    expect(resolveSession(a)).toBeNull()
    expect(resolveSession(b)).toBeNull()
  })

  it('revokes all EXCEPT the caller when a token is spared', () => {
    const u = makeUser('spare')
    const keep = createSession({ userId: u.id, username: u.username })
    const drop = createSession({ userId: u.id, username: u.username })
    revokeAllForUser(u.id, keep)
    expect(resolveSession(keep)).not.toBeNull()
    expect(resolveSession(drop)).toBeNull()
  })
})

describe('restart rehydration', () => {
  it('resolves an existing session after a fresh DB handle + empty cache', () => {
    const u = makeUser('persist')
    const token = createSession({ userId: u.id, username: u.username })
    // Simulate a dashboard restart: reopen the SAME file with a new handle and
    // drop the in-memory cache. The durable row must still resolve.
    initDatabase(DB_PATH)
    _clearSessionCacheForTest()
    expect(resolveSession(token)).toEqual({ userId: u.id, username: 'persist' })
  })
})

describe('sweep + listing', () => {
  it('sweeps only expired rows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const u = makeUser('sweeper')
    const fresh = createSession({ userId: u.id, username: u.username })
    // Insert a stale row directly (created + last_seen 40 days ago).
    const stale = Math.floor(new Date('2025-11-22T00:00:00Z').getTime() / 1000)
    getDb().prepare('INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at) VALUES (?,?,?,?,?)')
      .run('f'.repeat(64), u.id, u.username, stale, stale)
    expect(sweepExpiredSessions()).toBe(1)
    expect(resolveSession(fresh)).not.toBeNull()
  })

  it('lists a user sessions with hashed prefix only', () => {
    const u = makeUser('lister')
    createSession({ userId: u.id, username: u.username }, { userAgent: 'test-agent' })
    const list = listUserSessions(u.id)
    expect(list.length).toBe(1)
    expect(list[0].idHashPrefix).toHaveLength(12)
    expect(list[0].userAgent).toBe('test-agent')
  })
})
