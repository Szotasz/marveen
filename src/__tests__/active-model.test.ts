import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { projectsDirFor, readActiveModelFromProjectDir, readContextTokensFromProjectDir } from '../web/active-model.js'

describe('projectsDirFor', () => {
  it('uses <home>/.claude/projects when no config dir is given', () => {
    const result = projectsDirFor('/home/u/work', undefined, '/home/u')
    expect(result).toBe(join('/home/u', '.claude', 'projects', '-home-u-work'))
  })

  it('uses the supplied config dir instead of the default home location', () => {
    const result = projectsDirFor('/home/u/work', '/home/u/.claude-coding', '/home/u')
    expect(result).toBe(join('/home/u/.claude-coding', 'projects', '-home-u-work'))
  })

  it('does not fall back to the home dir when a config dir is supplied', () => {
    const result = projectsDirFor('/home/u/work', '/var/lib/claude-coding', '/home/u')
    expect(result.startsWith('/var/lib/claude-coding')).toBe(true)
    expect(result).not.toContain('/home/u/.claude')
  })

  it('encodes slashes and dots in the working dir to dashes', () => {
    const result = projectsDirFor('/home/u/some.dir/app', '/cfg', '/home/u')
    expect(result).toBe(join('/cfg', 'projects', '-home-u-some-dir-app'))
  })

  it('produces distinct project dirs for the same working dir on different config roots', () => {
    const a = projectsDirFor('/w', '/home/u/.claude', '/home/u')
    const b = projectsDirFor('/w', '/home/u/.claude-coding', '/home/u')
    expect(a).not.toBe(b)
  })
})

// kanban api-agents-lassu17: readActiveModelFromProjectDir/readContextTokensFromProjectDir
// scan a session .jsonl from the END in a growing window (64KB, doubling) instead of
// reading+splitting the whole file, because a live session log can be tens of MB and both
// callers only ever need the LAST matching line. These tests prove the windowed scan finds
// the same result a full-file backward scan would -- including when the match sits BEFORE
// the initial 64KB window, which forces the fallback-expansion path.
describe('readActiveModelFromProjectDir / readContextTokensFromProjectDir (bounded tail scan)', () => {
  let configDir: string
  beforeEach(() => { configDir = mkdtempSync(join(tmpdir(), 'active-model-test-')) })
  afterEach(() => { rmSync(configDir, { recursive: true, force: true }) })

  function writeSession(workingDir: string, lines: unknown[]): void {
    const dir = projectsDirFor(workingDir, configDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  }

  it('finds the model from the last assistant turn in a small session', () => {
    writeSession('/case/small-model', [
      { timestamp: '2026-08-14T10:00:00Z', message: { model: 'claude-sonnet-5', usage: {} } },
      { timestamp: '2026-08-14T10:01:00Z', message: { model: 'claude-opus-5', usage: {} } },
    ])
    expect(readActiveModelFromProjectDir('/case/small-model', undefined, configDir)).toBe('claude-opus-5')
  })

  it('sums input + cache_read + cache_creation tokens from the last usage-bearing turn', () => {
    writeSession('/case/small-tokens', [
      { timestamp: '2026-08-14T10:00:00Z', message: { model: 'claude-opus-5', usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 } } },
    ])
    expect(readContextTokensFromProjectDir('/case/small-tokens', configDir)).toBe(350)
  })

  it('skips a line whose model is present but whose timestamp predates sinceUnixSec', () => {
    const oldTs = Math.floor(new Date('2026-08-14T09:00:00Z').getTime() / 1000)
    const cutoff = Math.floor(new Date('2026-08-14T10:00:00Z').getTime() / 1000)
    writeSession('/case/since-filter', [
      { timestamp: '2026-08-14T09:00:00Z', message: { model: 'claude-old', usage: {} } },
    ])
    expect(oldTs).toBeLessThan(cutoff)
    expect(readActiveModelFromProjectDir('/case/since-filter', cutoff, configDir)).toBeNull()
  })

  it('returns null for a missing project dir, and for a dir with no .jsonl files', () => {
    expect(readActiveModelFromProjectDir('/case/does-not-exist', undefined, configDir)).toBeNull()
    const dir = projectsDirFor('/case/empty-dir', configDir)
    mkdirSync(dir, { recursive: true })
    expect(readActiveModelFromProjectDir('/case/empty-dir', undefined, configDir)).toBeNull()
  })

  it('FALLBACK PATH: finds a match that sits before the initial 64KB window, by expanding it', () => {
    // Pad with user-role lines carrying no model/usage (so the tail window has nothing to
    // match), then one real assistant turn, then enough more padding to push the assistant
    // turn's line past the first 64KB counted from EOF. ~90KB of padding is comfortably
    // past the 64KB start window without needing a production-scale (multi-MB) fixture.
    const padLine = { timestamp: '2026-08-14T09:00:00Z', role: 'user', content: 'x'.repeat(200) }
    const padCount = 450 // ~200 bytes/line * 450 =~ 90KB, pushes the real line past 64KB from EOF
    const lines: unknown[] = []
    for (let i = 0; i < padCount; i++) lines.push(padLine)
    lines.push({ timestamp: '2026-08-14T10:00:00Z', message: { model: 'claude-deep-history', usage: { input_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
    for (let i = 0; i < padCount; i++) lines.push(padLine)
    writeSession('/case/fallback-expand', lines)

    expect(readActiveModelFromProjectDir('/case/fallback-expand', undefined, configDir)).toBe('claude-deep-history')
    expect(readContextTokensFromProjectDir('/case/fallback-expand', configDir)).toBe(42)
  })

  it('ignores malformed JSON lines and keeps scanning backward', () => {
    writeSession('/case/malformed', [
      { timestamp: '2026-08-14T10:00:00Z', message: { model: 'claude-real', usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    ])
    const dir = projectsDirFor('/case/malformed', configDir)
    // Append a trailing malformed line after the valid one -- must still find the real entry.
    const filePath = join(dir, 'session.jsonl')
    appendFileSync(filePath, 'not valid json\n')
    expect(readActiveModelFromProjectDir('/case/malformed', undefined, configDir)).toBe('claude-real')
  })
})
