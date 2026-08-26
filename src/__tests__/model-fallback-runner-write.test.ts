import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// writeMainModel() must sync both .claude/settings.json AND .env so that
// channels.sh resolve_main_model() (which prefers MAIN_AGENT_MODEL from .env)
// sees the new model on next channels.sh restart. Bug: before this fix the
// runner wrote only settings.json; the stale .env value silently reverted the
// model switch on every channels.sh restart.
//
// We test the file-mutation contract directly using a tmp dir so no production
// files are touched. The logic mirrors writeMainModel() in
// src/web/model-fallback-runner.ts exactly.

let tmpDir: string

function applyWriteMainModelLogic(projectRoot: string, model: string): void {
  const settingsPath = join(projectRoot, '.claude', 'settings.json')
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch {}
  cfg.model = model
  writeFileSync(settingsPath, JSON.stringify(cfg, null, 2))

  const envPath = join(projectRoot, '.env')
  try {
    let env = readFileSync(envPath, 'utf-8')
    env = /^MAIN_AGENT_MODEL=/m.test(env)
      ? env.replace(/^MAIN_AGENT_MODEL=.*/m, `MAIN_AGENT_MODEL=${model}`)
      : `${env.trimEnd()}\nMAIN_AGENT_MODEL=${model}\n`
    writeFileSync(envPath, env)
  } catch {}
}

describe('writeMainModel: .env and settings.json sync', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mf-runner-test-'))
    mkdirSync(join(tmpDir, '.claude'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes the model to .claude/settings.json', () => {
    writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5', other: 'preserved' }))
    writeFileSync(join(tmpDir, '.env'), 'FOO=bar\nMAIN_AGENT_MODEL=claude-opus-5\n')

    applyWriteMainModelLogic(tmpDir, 'claude-sonnet-5')

    const cfg = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'))
    expect(cfg.model).toBe('claude-sonnet-5')
    expect(cfg.other).toBe('preserved')
  })

  it('replaces MAIN_AGENT_MODEL in .env when the key already exists', () => {
    writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }))
    writeFileSync(join(tmpDir, '.env'), 'FOO=bar\nMAIN_AGENT_MODEL=claude-opus-5\nBAZ=qux\n')

    applyWriteMainModelLogic(tmpDir, 'claude-sonnet-5')

    const env = readFileSync(join(tmpDir, '.env'), 'utf-8')
    expect(env).toContain('MAIN_AGENT_MODEL=claude-sonnet-5')
    expect(env).not.toContain('MAIN_AGENT_MODEL=claude-opus-5')
    expect(env).toContain('FOO=bar')
    expect(env).toContain('BAZ=qux')
  })

  it('appends MAIN_AGENT_MODEL to .env when the key is absent', () => {
    writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }))
    writeFileSync(join(tmpDir, '.env'), 'FOO=bar\n')

    applyWriteMainModelLogic(tmpDir, 'claude-sonnet-5')

    const env = readFileSync(join(tmpDir, '.env'), 'utf-8')
    expect(env).toContain('MAIN_AGENT_MODEL=claude-sonnet-5')
    expect(env).toContain('FOO=bar')
  })

  it('handles a missing settings.json gracefully (creates it)', () => {
    writeFileSync(join(tmpDir, '.env'), 'MAIN_AGENT_MODEL=claude-opus-5\n')

    applyWriteMainModelLogic(tmpDir, 'claude-sonnet-5')

    const cfg = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'))
    expect(cfg.model).toBe('claude-sonnet-5')
  })

  it('does NOT clobber unrelated .env keys when replacing MAIN_AGENT_MODEL', () => {
    writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ model: 'old-model' }))
    writeFileSync(join(tmpDir, '.env'), 'PORT=3420\nMAIN_AGENT_MODEL=old-model\nDEBUG=1\n')

    applyWriteMainModelLogic(tmpDir, 'claude-haiku-4-5-20251001')

    const env = readFileSync(join(tmpDir, '.env'), 'utf-8')
    expect(env).toContain('PORT=3420')
    expect(env).toContain('DEBUG=1')
    expect(env).toContain('MAIN_AGENT_MODEL=claude-haiku-4-5-20251001')
    expect(env).not.toContain('MAIN_AGENT_MODEL=old-model')
  })
})
