import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the 2026-06-02 14:30 hb regression after Calendar
// re-auth. Symptom: Szabi re-authed at 16:26 (live HTTP 200 verified), but
// the heartbeat kept logging `Google token refresh failed` because the
// dashboard's module-level cachedTokens still held the pre-re-auth (88-day
// expired, revoked) refresh_token. Manual dashboard restart fixed the
// immediate symptom; this PR fixes the cache so out-of-process re-auths
// propagate automatically.

const SRC = readFileSync(join(__dirname, '../google-api.ts'), 'utf-8')

describe('google-api token cache mtime invalidation', () => {
  it('cache entry carries the file mtime alongside the parsed payload', () => {
    // Without mtimeMs in the cache shape, no way to tell when the file
    // on disk has been rewritten by an out-of-process re-auth.
    expect(SRC).toMatch(/cachedTokens:\s*\{[^}]*mtimeMs:\s*number/s)
  })

  it('loadTokens re-reads when the file mtime advances', () => {
    const start = SRC.indexOf('function loadTokens')
    expect(start).toBeGreaterThan(0)
    const closeIdx = SRC.indexOf('\n}\n', start)
    const body = SRC.slice(start, closeIdx)
    expect(body).toMatch(/statSync\(TOKENS_PATH\)/)
    expect(body).toMatch(/cachedTokens\.mtimeMs !==/)
  })

  it('saveTokens populates the cache with a matching mtime (no double-read)', () => {
    // After a write, the next loadTokens() should NOT need to re-read the
    // file (the in-memory copy is the truth). Track the post-write mtime
    // so cachedTokens.mtimeMs matches the file's mtime on the next check.
    const start = SRC.indexOf('function saveTokens')
    const closeIdx = SRC.indexOf('\n}\n', start)
    const body = SRC.slice(start, closeIdx)
    expect(body).toMatch(/statSync\(TOKENS_PATH\)/)
    expect(body).toMatch(/cachedTokens\s*=\s*\{[^}]*mtimeMs/s)
  })

  it('saveTokens writes ONLY tokens.normal-shaped JSON (no cache-mtime leak)', () => {
    // The cache layer must not leak its internal mtimeMs into the on-disk
    // JSON; tokens.json schema is { normal: TokenData } and the OAuth
    // server doesn't care about our cache bookkeeping.
    const start = SRC.indexOf('function saveTokens')
    const closeIdx = SRC.indexOf('\n}\n', start)
    const body = SRC.slice(start, closeIdx)
    // JSON.stringify of an object literal with `normal:` is fine; should
    // NOT serialise mtimeMs alongside.
    expect(body).toMatch(/writeFileSync\([^)]*JSON\.stringify\(\s*\{\s*normal:\s*tokens\s*\}/)
  })

  it('handles a missing TOKENS_PATH at stat time without throwing', () => {
    // statSync throws on missing file. The cache check must be wrapped in
    // try/catch so loadTokens can still surface the readFileSync error
    // explicitly (current behaviour) rather than being short-circuited by
    // the stat.
    const start = SRC.indexOf('function loadTokens')
    const closeIdx = SRC.indexOf('\n}\n', start)
    const body = SRC.slice(start, closeIdx)
    expect(body).toMatch(/try\s*\{\s*[^}]*statSync\(TOKENS_PATH\)/s)
    expect(body).toMatch(/catch\s*\{\s*\/\*/)
  })
})
