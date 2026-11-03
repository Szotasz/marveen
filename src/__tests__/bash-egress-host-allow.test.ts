// BASH_EGRESS_HOST_ALLOW (2026-10-13): the owner switch that moves curl https:// and wget from the
// name deny list to the bash-egress-parser hook. Off (default) must be byte-for-byte the old
// behaviour; on must retire the legacy rules only where the parser covers the session.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const settings: Record<string, string> = {}
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: (k: string) => settings[k] ?? '' }))

const { BASH_EGRESS_DENY, LEGACY_BASH_EGRESS_DENY, ensureBashEgressDeny, bashEgressHostAllowEnabled, ensureMainScopeBashEgressParser, bashEgressParserCovers } = await import('../web/agent-scaffold.js')
const { MAIN_AGENT_ID } = await import('../config.js')

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-hostallow-'))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
const deny = (dir: string): string[] => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8')).permissions.deny

describe('BASH_EGRESS_HOST_ALLOW', () => {
  beforeEach(() => { for (const k of Object.keys(settings)) delete settings[k] })

  it('is off unless set to exactly 1', () => {
    expect(bashEgressHostAllowEnabled()).toBe(false)
    settings.BASH_EGRESS_HOST_ALLOW = 'true'
    expect(bashEgressHostAllowEnabled()).toBe(false)
    settings.BASH_EGRESS_HOST_ALLOW = '1'
    expect(bashEgressHostAllowEnabled()).toBe(true)
  })

  it('off: the main agent keeps the legacy curl-https / wget rules', () => withDir((dir) => {
    ensureBashEgressDeny(MAIN_AGENT_ID, dir)
    expect(deny(dir)).toEqual([...BASH_EGRESS_DENY, ...LEGACY_BASH_EGRESS_DENY])
  }))

  it('on: the main agent loses exactly the legacy rules once the project-local settings carry --main-scope', () => withDir((dir) => {
    const local = join(dir, 'settings.local.json')
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(sudo:*)', ...BASH_EGRESS_DENY, ...LEGACY_BASH_EGRESS_DENY] } }))
    settings.BASH_EGRESS_HOST_ALLOW = '1'
    expect(ensureMainScopeBashEgressParser(true, local)).toBe(true)
    expect(ensureBashEgressDeny(MAIN_AGENT_ID, dir, local)).toBe(true)
    expect(deny(dir)).toEqual(['Bash(sudo:*)', ...BASH_EGRESS_DENY])
    expect(ensureBashEgressDeny(MAIN_AGENT_ID, dir, local)).toBe(false)
  }))

  it('on, but no --main-scope entry anywhere: the main agent KEEPS the legacy rules', () => withDir((dir) => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ permissions: { deny: [...BASH_EGRESS_DENY, ...LEGACY_BASH_EGRESS_DENY] } }))
    settings.BASH_EGRESS_HOST_ALLOW = '1'
    expect(ensureBashEgressDeny(MAIN_AGENT_ID, dir, join(dir, 'settings.local.json'))).toBe(false)
    expect(deny(dir)).toEqual([...BASH_EGRESS_DENY, ...LEGACY_BASH_EGRESS_DENY])
  }))

  it('switched back off: the legacy rules return on the next start', () => withDir((dir) => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ permissions: { deny: [...BASH_EGRESS_DENY] } }))
    expect(ensureBashEgressDeny(MAIN_AGENT_ID, dir)).toBe(true)
    expect(deny(dir)).toEqual([...BASH_EGRESS_DENY, ...LEGACY_BASH_EGRESS_DENY])
  }))
})

// #1931 review: the main agent's --main-scope registration exists ONLY while the switch is on, and
// never in the tracked .claude/settings.json (off must be byte-for-byte today's tree). It lives in
// the project-local settings, which may also hold the owner's own entries.
describe('ensureMainScopeBashEgressParser (project-local settings)', () => {
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf-8'))
  const owner = { permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'true' }] }] } }

  it('off and no file: writes nothing', () => withDir((dir) => {
    const p = join(dir, 'settings.local.json')
    expect(ensureMainScopeBashEgressParser(false, p)).toBe(false)
    expect(existsSync(p)).toBe(false)
  }))

  it('on: adds one --main-scope Bash entry, idempotently, and the main agent reads as covered', () => withDir((dir) => {
    const p = join(dir, 'settings.local.json')
    expect(ensureMainScopeBashEgressParser(true, p)).toBe(true)
    const ptu = read(p).hooks.PreToolUse
    expect(ptu).toHaveLength(1)
    expect(ptu[0].matcher).toBe('Bash')
    expect(ptu[0].hooks[0].command).toContain('bash-egress-parser.mjs" --main-scope')
    expect(ensureMainScopeBashEgressParser(true, p)).toBe(false)
    expect(bashEgressParserCovers(MAIN_AGENT_ID, {}, p)).toBe(true)
  }))

  it('off after on: the file it created alone is removed again', () => withDir((dir) => {
    const p = join(dir, 'settings.local.json')
    ensureMainScopeBashEgressParser(true, p)
    expect(ensureMainScopeBashEgressParser(false, p)).toBe(true)
    expect(existsSync(p)).toBe(false)
    expect(bashEgressParserCovers(MAIN_AGENT_ID, {}, p)).toBe(false)
  }))

  it('the owner\'s own entries survive both directions untouched', () => withDir((dir) => {
    const p = join(dir, 'settings.local.json')
    writeFileSync(p, JSON.stringify(owner))
    expect(ensureMainScopeBashEgressParser(true, p)).toBe(true)
    expect(read(p).permissions).toEqual(owner.permissions)
    expect(read(p).hooks.PreToolUse[0]).toEqual(owner.hooks.PreToolUse[0])
    expect(ensureMainScopeBashEgressParser(false, p)).toBe(true)
    expect(read(p)).toEqual(owner)
  }))

  it('an unreadable file is left alone, and the main agent then reads as NOT covered', () => withDir((dir) => {
    const p = join(dir, 'settings.local.json')
    writeFileSync(p, '{ not json')
    expect(ensureMainScopeBashEgressParser(true, p)).toBe(false)
    expect(readFileSync(p, 'utf-8')).toBe('{ not json')
    expect(bashEgressParserCovers(MAIN_AGENT_ID, {}, p)).toBe(false)
  }))
})
