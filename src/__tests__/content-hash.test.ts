import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// MD5SUMHIANY826: the shared content-hash helper must never hand back an
// empty fingerprint. The old bare `md5sum` pipeline did exactly that on
// macOS, and the SAME root cause produced two opposite lies: the
// limit-monitor dedupe swallowed every alert (empty == empty -> "already
// sent"), while a session-stuck pane comparison called two live captures
// "unchanged" and raised a false alarm. These tests run the REAL helper in a
// real bash.

const HELPER = resolve(__dirname, '../../scripts/lib/content-hash.sh')
const NO_TOOLS = 'md5sum md5 /sbin/md5 /usr/bin/md5 shasum cksum'

function bash(script: string, env: Record<string, string> = {}): { out: string; code: number } {
  try {
    // Absolute bash: with a stripped PATH in env, a PATH-resolved spawn would
    // ENOENT before the helper under test even runs.
    const out = execFileSync('/bin/bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { out, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; status?: number }
    return { out: e.stdout ?? '', code: e.status ?? -1 }
  }
}

describe('content_hash', () => {
  it('hashes stdin with an algorithm prefix and is stable', () => {
    const a1 = bash(`. ${HELPER}; printf 'alma' | content_hash`)
    const a2 = bash(`. ${HELPER}; printf 'alma' | content_hash`)
    expect(a1.code).toBe(0)
    expect(a1.out).toMatch(/^(md5|sha1|cksum):\S+$/)
    expect(a1.out).toBe(a2.out)
  })

  it('different content yields different fingerprints (the session-stuck false-alarm case)', () => {
    const a = bash(`. ${HELPER}; printf 'pane snapshot A' | content_hash`)
    const b = bash(`. ${HELPER}; printf 'pane snapshot B' | content_hash`)
    expect(a.out).not.toBe(b.out)
  })

  it('FAILS with no output when no hashing tool exists -- never an empty string', () => {
    // The absolute-path md5 probe works regardless of PATH (that is a
    // feature), so absence is simulated via the helper's test seam.
    const r = bash(`. ${HELPER}; printf 'alma' | content_hash`, { CONTENT_HASH_DISABLE: NO_TOOLS })
    expect(r.code).toBe(127)
    expect(r.out).toBe('')
  })
})

describe('dedupe_check (limit-monitor contract)', () => {
  it('known positive: a SECOND, DIFFERENT alert in the same window must get out', () => {
    // This is the exact control the card demands: the broken empty-hash
    // dedupe passed the first alert concept and swallowed every later one.
    const dir = mkdtempSync(join(tmpdir(), 'md5fix-'))
    const state = join(dir, 'state')

    // Alert 1: new -> exit 0, caller stamps after confirmed send.
    const first = bash(`. ${HELPER}; printf 'limit signal A' | dedupe_check ${state}`)
    expect(first.code).toBe(0)
    expect(first.out).toMatch(/^(md5|sha1|cksum):/)
    writeFileSync(state, first.out)

    // Same alert again: unchanged -> exit 1 (deduped).
    const repeat = bash(`. ${HELPER}; printf 'limit signal A' | dedupe_check ${state}`)
    expect(repeat.code).toBe(1)

    // Alert 2, DIFFERENT content, same window: MUST come back as new.
    const second = bash(`. ${HELPER}; printf 'limit signal B' | dedupe_check ${state}`)
    expect(second.code).toBe(0)
    expect(second.out).not.toBe(first.out)
  })

  it('empty state file never swallows a real signal (the original bug shape)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'md5fix-'))
    const state = join(dir, 'state')
    writeFileSync(state, '') // what the broken pipeline left behind
    const r = bash(`. ${HELPER}; printf 'limit signal' | dedupe_check ${state}`)
    expect(r.code).toBe(0)
    expect(r.out).not.toBe('')
  })

  it('hashing unavailable -> exit 2 so the caller can fail OPEN', () => {
    const dir = mkdtempSync(join(tmpdir(), 'md5fix-'))
    const state = join(dir, 'state')
    const r = bash(`. ${HELPER}; printf 'x' | dedupe_check ${state}`, { CONTENT_HASH_DISABLE: NO_TOOLS })
    expect(r.code).toBe(2)
  })
})

describe('limit-monitor wiring', () => {
  it('sources the shared helper and no bare md5sum pipeline remains', () => {
    const monitor = readFileSync(resolve(__dirname, '../../scripts/limit-monitor.sh'), 'utf8')
    expect(monitor).toContain('scripts/lib/content-hash.sh')
    expect(monitor).toContain('dedupe_check')
    expect(monitor).not.toMatch(/\|\s*md5sum/)
  })
})
