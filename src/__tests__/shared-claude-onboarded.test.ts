import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureSharedClaudeOnboarded } from '../web/agent-process.js'

// 2026-07-15 bootcamp: ~/.claude.json lost hasCompletedOnboarding, so every
// fresh (re)spawn on the shared config root parked on the first-run
// "Select login method" picker while the on-disk credential was valid.
// ensureSharedClaudeOnboarded is the idempotent pre-launch re-seed.
describe('ensureSharedClaudeOnboarded', () => {
  let dir: string
  let dotClaude: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'onboarded-'))
    dotClaude = join(dir, '.claude.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('creates a minimal file with the flag when ~/.claude.json is missing', () => {
    expect(ensureSharedClaudeOnboarded(dotClaude)).toBe(true)
    const parsed = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(parsed.hasCompletedOnboarding).toBe(true)
  })

  it('re-seeds a clobbered flag while PRESERVING every other key (the bootcamp case)', () => {
    writeFileSync(dotClaude, JSON.stringify({
      projects: { '/root/marveen': { hasTrustDialogAccepted: true } },
      mcpServers: { fs: { command: 'x' } },
    }))
    expect(ensureSharedClaudeOnboarded(dotClaude)).toBe(true)
    const parsed = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(parsed.hasCompletedOnboarding).toBe(true)
    expect(parsed.projects['/root/marveen'].hasTrustDialogAccepted).toBe(true)
    expect(parsed.mcpServers.fs.command).toBe('x')
  })

  it('is a no-op (returns false) when the flag is already true', () => {
    const original = JSON.stringify({ hasCompletedOnboarding: true, other: 1 }, null, 2) + '\n'
    writeFileSync(dotClaude, original)
    expect(ensureSharedClaudeOnboarded(dotClaude)).toBe(false)
    expect(readFileSync(dotClaude, 'utf-8')).toBe(original)
  })

  it('re-seeds when the flag exists but is not exactly true', () => {
    writeFileSync(dotClaude, JSON.stringify({ hasCompletedOnboarding: false }))
    expect(ensureSharedClaudeOnboarded(dotClaude)).toBe(true)
    expect(JSON.parse(readFileSync(dotClaude, 'utf-8')).hasCompletedOnboarding).toBe(true)
  })

  it('leaves an UNPARSEABLE file alone (Claude Code owns its recovery)', () => {
    writeFileSync(dotClaude, '{ not json')
    expect(ensureSharedClaudeOnboarded(dotClaude)).toBe(false)
    expect(readFileSync(dotClaude, 'utf-8')).toBe('{ not json')
  })

  it('leaves no tmp litter next to the target (atomic write)', () => {
    writeFileSync(dotClaude, JSON.stringify({ a: 1 }))
    ensureSharedClaudeOnboarded(dotClaude)
    expect(existsSync(dotClaude)).toBe(true)
    const leftovers = readFileSync(dotClaude, 'utf-8')
    expect(() => JSON.parse(leftovers)).not.toThrow()
  })
})
