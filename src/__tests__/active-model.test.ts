import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  projectsDirFor,
  readActiveModelFromProjectDir,
  readContextTokensFromProjectDir,
} from '../web/active-model.js'

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

describe('readActiveModelFromProjectDir', () => {
  let tmp: string

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'active-model-test-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  function setup(lines: string[]): { configDir: string; workDir: string } {
    const configDir = join(tmp, '.claude')
    const workDir = join(tmp, 'work')
    const encoded = workDir.replace(/[/.]/g, '-')
    mkdirSync(join(configDir, 'projects', encoded), { recursive: true })
    writeFileSync(join(configDir, 'projects', encoded, 'session.jsonl'), lines.join('\n'))
    return { configDir, workDir }
  }

  it('returns null when the projects dir does not exist', () => {
    expect(readActiveModelFromProjectDir(join(tmp, 'missing'), undefined, join(tmp, 'nope'))).toBeNull()
  })

  it('returns null when there are no .jsonl files', () => {
    const configDir = join(tmp, '.claude')
    const workDir = join(tmp, 'work')
    mkdirSync(join(configDir, 'projects', workDir.replace(/[/.]/g, '-')), { recursive: true })
    expect(readActiveModelFromProjectDir(workDir, undefined, configDir)).toBeNull()
  })

  it('returns the model from the last valid turn', () => {
    const { configDir, workDir } = setup([
      JSON.stringify({ message: { model: 'claude-haiku-4' }, timestamp: '2026-01-01T10:00:00Z' }),
      JSON.stringify({ message: { model: 'claude-sonnet-4-6' }, timestamp: '2026-01-01T11:00:00Z' }),
    ])
    expect(readActiveModelFromProjectDir(workDir, undefined, configDir)).toBe('claude-sonnet-4-6')
  })

  it('ignores model values that start with < (placeholder)', () => {
    const { configDir, workDir } = setup([
      JSON.stringify({ message: { model: 'claude-sonnet-4-6' }, timestamp: '2026-01-01T10:00:00Z' }),
      JSON.stringify({ message: { model: '<placeholder>' }, timestamp: '2026-01-01T11:00:00Z' }),
    ])
    expect(readActiveModelFromProjectDir(workDir, undefined, configDir)).toBe('claude-sonnet-4-6')
  })

  it('respects sinceUnixSec and skips older turns', () => {
    const since = Math.floor(new Date('2026-01-01T10:00:00Z').getTime() / 1000)
    const { configDir, workDir } = setup([
      JSON.stringify({ message: { model: 'old-model' }, timestamp: '2026-01-01T08:00:00Z' }),
      JSON.stringify({ message: { model: 'new-model' }, timestamp: '2026-01-01T12:00:00Z' }),
    ])
    expect(readActiveModelFromProjectDir(workDir, since, configDir)).toBe('new-model')
  })

  it('returns null when all turns predate sinceUnixSec', () => {
    const futureUnix = Math.floor(new Date('2030-01-01T00:00:00Z').getTime() / 1000)
    const { configDir, workDir } = setup([
      JSON.stringify({ message: { model: 'old-model' }, timestamp: '2026-01-01T08:00:00Z' }),
    ])
    expect(readActiveModelFromProjectDir(workDir, futureUnix, configDir)).toBeNull()
  })

  it('skips malformed JSON lines without throwing', () => {
    const { configDir, workDir } = setup([
      JSON.stringify({ message: { model: 'valid-model' }, timestamp: '2026-01-01T10:00:00Z' }),
      '{bad json',
      '',
    ])
    expect(readActiveModelFromProjectDir(workDir, undefined, configDir)).toBe('valid-model')
  })
})

describe('readContextTokensFromProjectDir', () => {
  let tmp: string

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'ctx-tokens-test-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  function setup(lines: string[]): { configDir: string; workDir: string } {
    const configDir = join(tmp, '.claude')
    const workDir = join(tmp, 'work')
    const encoded = workDir.replace(/[/.]/g, '-')
    mkdirSync(join(configDir, 'projects', encoded), { recursive: true })
    writeFileSync(join(configDir, 'projects', encoded, 'session.jsonl'), lines.join('\n'))
    return { configDir, workDir }
  }

  it('returns null when projects dir does not exist', () => {
    expect(readContextTokensFromProjectDir(join(tmp, 'miss'), join(tmp, 'nope'))).toBeNull()
  })

  it('returns null when no jsonl files exist', () => {
    const configDir = join(tmp, '.claude')
    const workDir = join(tmp, 'work')
    mkdirSync(join(configDir, 'projects', workDir.replace(/[/.]/g, '-')), { recursive: true })
    expect(readContextTokensFromProjectDir(workDir, configDir)).toBeNull()
  })

  it('sums input + cache_read + cache_creation tokens', () => {
    const usage = { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 }
    const { configDir, workDir } = setup([
      JSON.stringify({ message: { usage }, timestamp: '2026-01-01T10:00:00Z' }),
    ])
    expect(readContextTokensFromProjectDir(workDir, configDir)).toBe(1250)
  })

  it('returns null when usage sums to zero', () => {
    const usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const { configDir, workDir } = setup([
      JSON.stringify({ message: { usage }, timestamp: '2026-01-01T10:00:00Z' }),
    ])
    expect(readContextTokensFromProjectDir(workDir, configDir)).toBeNull()
  })
})
