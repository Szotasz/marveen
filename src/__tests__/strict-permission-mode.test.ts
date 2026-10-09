/**
 * #1837 (opontop): a strict profile's allow-list is its whole value, but Claude
 * Code evaluates bypassPermissions BEFORE the allow-list. The operator's own
 * ~/.claude/settings.json (often `permissions.defaultMode: "bypassPermissions"`)
 * is copied into a sub-agent's isolated config dir, so a strict agent could
 * come up in bypass mode with an inert allow-list. enforceStrictPermissionMode
 * pins the mode in both places a strict agent's mode can come from.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enforceStrictPermissionMode, writeAgentSettingsFromProfile, agentSettingsPath } from '../web/agent-scaffold.js'
import { loadProfileTemplate, type ProfileTemplate } from '../web/profiles.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

describe('enforceStrictPermissionMode (pure)', () => {
  const pinned = (incoming: unknown) => {
    const s: Record<string, unknown> = incoming === undefined ? {} : { permissions: { defaultMode: incoming, allow: ['Read(./x)'] } }
    const changed = enforceStrictPermissionMode(s, 'strict')
    return { changed, mode: (s.permissions as Record<string, unknown>).defaultMode, perms: s.permissions as Record<string, unknown> }
  }

  it('pins bypassPermissions, acceptEdits, default and an absent mode to dontAsk for a strict profile', () => {
    // 'default' too: it PROMPTS on an unmatched call, and a sub-agent in tmux has
    // no one to answer, so it would hang (#1844 review). dontAsk denies instead.
    for (const m of ['bypassPermissions', 'acceptEdits', 'default', 'auto']) {
      const r = pinned(m)
      expect(r.changed).toBe(true)
      expect(r.mode).toBe('dontAsk')
      expect(r.perms.allow).toEqual(['Read(./x)'])
    }
    const absent = pinned(undefined)
    expect(absent.changed).toBe(true)
    expect(absent.mode).toBe('dontAsk')
  })

  it('leaves dontAsk and an operator-chosen plan alone', () => {
    for (const m of ['dontAsk', 'plan']) {
      const r = pinned(m)
      expect(r.changed).toBe(false)
      expect(r.mode).toBe(m)
    }
  })

  it('does nothing for a non-strict profile, even with bypass incoming', () => {
    for (const mode of ['permissive', undefined]) {
      const s: Record<string, unknown> = { permissions: { defaultMode: 'bypassPermissions' } }
      expect(enforceStrictPermissionMode(s, mode)).toBe(false)
      expect((s.permissions as Record<string, unknown>).defaultMode).toBe('bypassPermissions')
    }
  })

  it('replaces a non-object permissions value instead of writing into it', () => {
    const s: Record<string, unknown> = { permissions: ['not', 'an', 'object'] }
    expect(enforceStrictPermissionMode(s, 'strict')).toBe(true)
    expect(s.permissions).toEqual({ defaultMode: 'dontAsk' })
  })
})

const TEST_AGENT = 'strict-mode-probe'
const agentRoot = (n: string) => join(AGENTS_BASE_DIR, n)
function cleanup(): void {
  const root = agentRoot(TEST_AGENT)
  if (!existsSync(root)) return
  if (!root.startsWith(join(AGENTS_BASE_DIR, TEST_AGENT))) throw new Error(`refusing: ${root}`)
  if (existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, 'HANDOFF.md'))) throw new Error(`refusing: ${root} looks live`)
  rmSync(root, { recursive: true, force: true })
}
beforeEach(cleanup)
afterEach(cleanup)

function render(profile: ProfileTemplate): Record<string, unknown> {
  mkdirSync(join(agentRoot(TEST_AGENT), '.claude'), { recursive: true })
  writeAgentSettingsFromProfile(TEST_AGENT, profile)
  return JSON.parse(readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8')) as Record<string, unknown>
}

describe('the project settings a strict sub-agent gets', () => {
  it('carry permissions.defaultMode = dontAsk next to the allow-list', () => {
    const strict: ProfileTemplate = { ...loadProfileTemplate('developer-junior') }
    expect(strict.permissionMode).toBe('strict')
    const perms = render(strict).permissions as Record<string, unknown>
    expect(perms.defaultMode).toBe('dontAsk')
    expect(Array.isArray(perms.allow)).toBe(true)
  })

  it('a permissive profile gets no defaultMode (unchanged behaviour)', () => {
    const perms = render(loadProfileTemplate('default')).permissions as Record<string, unknown>
    expect('defaultMode' in perms).toBe(false)
  })
})

describe('wiring: the isolated user-level copy is pinned too', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'web', 'agent-process.ts'), 'utf-8')
  const fn = src.slice(src.indexOf('function provisionIsolatedConfigDir('), src.indexOf('// 3. Own plugins/ dir'))

  it('provisionIsolatedConfigDir pins the mode from the agent profile, for sub-agents only', () => {
    expect(fn).toMatch(/if \(name !== MAIN_AGENT_ID\) \{[\s\S]*?loadProfileTemplate\(resolveAgentSecurityProfile\(name\)\)\?\.permissionMode[\s\S]*?\n\s*if \(enforceStrictPermissionMode\(settings, permissionMode\)\) \{/)
  })

  it('pins AFTER the own-settings merge and BEFORE the write, so nothing re-adds a bypass', () => {
    const merge = fn.indexOf('const ownSettingsPath = join(cfg, \'settings.json\')')
    const pin = fn.indexOf('enforceStrictPermissionMode(settings, permissionMode)')
    const write = fn.indexOf('writeJsonAtomic(ownSettingsPath, settings)')
    expect(merge).toBeGreaterThan(0)
    expect(pin).toBeGreaterThan(merge)
    expect(write).toBeGreaterThan(pin)
  })
})
