// BASH_EGRESS_HOST_ALLOW (2026-10-13): the owner switch that moves curl https:// and wget from the
// name deny list to the bash-egress-parser hook. Off (default) must be byte-for-byte the old
// behaviour; on must retire the legacy rules only where the parser covers the session.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const settings: Record<string, string> = {}
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: (k: string) => settings[k] ?? '' }))

const { BASH_EGRESS_DENY, LEGACY_BASH_EGRESS_DENY, ensureBashEgressDeny, bashEgressHostAllowEnabled } = await import('../web/agent-scaffold.js')
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

  it('on: the main agent loses exactly the legacy rules (the repo project settings carry --main-scope)', () => withDir((dir) => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(sudo:*)', ...BASH_EGRESS_DENY, ...LEGACY_BASH_EGRESS_DENY] } }))
    settings.BASH_EGRESS_HOST_ALLOW = '1'
    expect(ensureBashEgressDeny(MAIN_AGENT_ID, dir)).toBe(true)
    expect(deny(dir)).toEqual(['Bash(sudo:*)', ...BASH_EGRESS_DENY])
    expect(ensureBashEgressDeny(MAIN_AGENT_ID, dir)).toBe(false)
  }))

  it('switched back off: the legacy rules return on the next start', () => withDir((dir) => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ permissions: { deny: [...BASH_EGRESS_DENY] } }))
    expect(ensureBashEgressDeny(MAIN_AGENT_ID, dir)).toBe(true)
    expect(deny(dir)).toEqual([...BASH_EGRESS_DENY, ...LEGACY_BASH_EGRESS_DENY])
  }))
})
