/**
 * AGENTISO1123 PR-A: strict mode, fail-closed.
 *  1. An explicitly configured security profile that is missing or unreadable refuses the start (no fallback to the
 *     permissive `default`); an agent with no profile configured starts as before.
 *  2. A strict profile drops `permissions` from the agent's settings.local.json on every spawn.
 *  3. A strict profile's deny list covers the files that define the agent's own limits (Dani S3).
 *  4. No PreToolUse hook answers "ask" (a strict agent runs unattended: an ask would be a prompt nobody answers).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

// No real tmux, no real owner notification, whatever the start path reaches (it must not reach either here).
const h = vi.hoisted(() => ({ tmuxCalls: [] as string[][] }))
vi.mock('node:child_process', async (orig) => {
  const real = await orig() as Record<string, unknown>
  const refuse = (file: unknown, args?: unknown) => {
    h.tmuxCalls.push([String(file), ...(Array.isArray(args) ? args.map(String) : [])])
    throw new Error('child_process disabled in this test')
  }
  return { ...real, execFileSync: vi.fn(refuse), execSync: vi.fn(refuse), spawnSync: vi.fn(refuse) }
})
vi.mock('../notify.js', async (orig) => ({
  ...(await orig() as object),
  notifyChannel: vi.fn(async () => true),
  sendOwnerMessage: vi.fn(async () => ({ ok: true })),
  sendOwnerSlackDm: vi.fn(async () => true),
  deliverWithSlack: vi.fn(async () => true),
}))

import { PROFILES_DIR, decideStartProfile, loadProfileTemplate, type ProfileTemplate, type ProfileResolution } from '../web/profiles.js'
import { writeAgentSettingsFromProfile, agentSettingsPath, sanitizeAgentLocalSettings, strictSelfProtectDeny } from '../web/agent-scaffold.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { startAgentProcess } from '../web/agent-process.js'
import { logger } from '../logger.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TEST_AGENT = 'zz-agentiso-probe'
const agentRoot = join(AGENTS_BASE_DIR, TEST_AGENT)
const corruptId = `zz-agentiso-corrupt-${process.pid}`
const corruptPath = join(PROFILES_DIR, `${corruptId}.json`)

function cleanup(): void {
  if (existsSync(agentRoot)) {
    if (!agentRoot.startsWith(join(AGENTS_BASE_DIR, TEST_AGENT))) throw new Error(`refusing: ${agentRoot}`)
    if (existsSync(join(agentRoot, 'CLAUDE.md')) || existsSync(join(agentRoot, 'HANDOFF.md'))) throw new Error(`refusing: ${agentRoot} looks live`)
    rmSync(agentRoot, { recursive: true, force: true })
  }
  rmSync(corruptPath, { force: true })
}
beforeEach(() => { cleanup(); h.tmuxCalls.length = 0 })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function writeAgentConfig(config: Record<string, unknown>): void {
  mkdirSync(join(agentRoot, '.claude'), { recursive: true })
  writeFileSync(join(agentRoot, 'agent-config.json'), JSON.stringify(config))
}

describe('decideStartProfile (pure-ish: reads templates/profiles)', () => {
  it('an explicitly configured MISSING profile is refused, with the name and the reason', () => {
    const d = decideStartProfile('no-such-profile-agentiso', true)
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.error).toContain('"no-such-profile-agentiso" is missing')
    expect(d.error).toContain('NOT started')
  })

  it('an explicitly configured UNREADABLE (invalid JSON) profile is refused as unreadable', () => {
    writeFileSync(corruptPath, '{ "id": "half a file')
    const d = decideStartProfile(corruptId, true)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.error).toContain('is unreadable')
  })

  it('valid JSON that is not a profile (no filesystem lists) is refused as unreadable too', () => {
    writeFileSync(corruptPath, JSON.stringify({ id: corruptId, permissionMode: 'strict' }))
    const d = decideStartProfile(corruptId, true)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.error).toContain('is unreadable')
  })

  it('NO profile configured: a missing role-derived profile still falls back to default (unchanged)', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const d = decideStartProfile('no-such-profile-agentiso', false)
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.profile.id).toBe('default')
  })

  it('CONTROL: an existing configured profile starts with itself', () => {
    const d = decideStartProfile('developer-junior', true)
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.profile.id).toBe('developer-junior')
  })

  it('N2: one read -- a resolver that succeeds once then fails: the decision carries the FIRST resolution', () => {
    const strict = loadProfileTemplate('developer-junior')
    const fallback = loadProfileTemplate('default')
    let calls = 0
    const flaky = (id: string): ProfileResolution => {
      calls += 1
      return calls === 1
        ? { profile: strict, requested: id, effective: id, fallbackReason: null }
        : { profile: fallback, requested: id, effective: 'default', fallbackReason: 'missing' }
    }
    const d = decideStartProfile('developer-junior', true, flaky)
    expect(calls).toBe(1)
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.profile).toBe(strict)
      expect(d.profile.permissionMode).toBe('strict')
    }
  })

  it('CONTROL: default, not configured, starts with default', () => {
    const d = decideStartProfile('default', false)
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.profile.id).toBe('default')
  })
})

describe('startAgentProcess refuses a broken configured profile before anything is launched', () => {
  it('missing configured profile -> { ok:false } with the profile error, no tmux call, no settings written', async () => {
    writeAgentConfig({ securityProfile: 'no-such-profile-agentiso' })
    const err = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never)
    const r = await startAgentProcess(TEST_AGENT)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('security profile "no-such-profile-agentiso" is missing')
    expect(h.tmuxCalls).toEqual([])
    expect(existsSync(agentSettingsPath(TEST_AGENT))).toBe(false)
    expect(err.mock.calls.some(c => String(c[1]).includes('agent NOT started (fail-closed, no fallback to default)'))).toBe(true)
  })

  it('unreadable configured profile -> refused as unreadable', async () => {
    writeFileSync(corruptPath, '{ not json')
    writeAgentConfig({ securityProfile: corruptId })
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as never)
    const r = await startAgentProcess(TEST_AGENT)
    expect(r.ok).toBe(false)
    expect(r.error).toContain(`security profile "${corruptId}" is unreadable`)
    expect(h.tmuxCalls).toEqual([])
  })

  it('wiring: the settings are written from the profile the gate resolved, not a second load', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')
    const fn = src.slice(src.indexOf('export async function startAgentProcess('))
    expect(fn).toMatch(/decideStartProfile\(resolveAgentSecurityProfile\(name\), readAgentSecurityProfile\(name\) !== 'default'\)/)
    expect(fn).toMatch(/const profile = startProfile\.profile\n\s*writeAgentSettingsFromProfile\(name, profile\)/)
  })
})

const localPath = () => join(agentRoot, '.claude', 'settings.local.json')
const LOCAL = { permissions: { allow: ['Bash(*)'], defaultMode: 'bypassPermissions' }, effortLevel: 'high' }

describe('settings.local.json: loosening permission keys dropped for a strict profile', () => {
  it('strict spawn: only loosening permission keys -> the emptied permissions key goes, other keys stay', () => {
    writeAgentConfig({})
    writeFileSync(localPath(), JSON.stringify(LOCAL))
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    writeAgentSettingsFromProfile(TEST_AGENT, loadProfileTemplate('developer-junior'))
    const after = JSON.parse(readFileSync(localPath(), 'utf-8')) as Record<string, unknown>
    expect('permissions' in after).toBe(false)
    expect(after.effortLevel).toBe('high')
  })

  const MIXED = {
    permissions: {
      allow: ['Bash(*)'],
      defaultMode: 'bypassPermissions',
      additionalDirectories: ['/'],
      deny: ['Bash(curl:*)', 'Read(//etc/**)'],
      ask: ['Bash(git push:*)'],
      disableBypassPermissionsMode: 'disable',
    },
  }

  it('strict spawn drops ONLY allow, defaultMode and additionalDirectories', () => {
    writeAgentConfig({})
    writeFileSync(localPath(), JSON.stringify(MIXED))
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    writeAgentSettingsFromProfile(TEST_AGENT, loadProfileTemplate('developer-junior'))
    const perms = (JSON.parse(readFileSync(localPath(), 'utf-8')) as { permissions: Record<string, unknown> }).permissions
    for (const k of ['allow', 'defaultMode', 'additionalDirectories']) expect(k in perms).toBe(false)
  })

  it('strict spawn KEEPS the narrowing keys: deny, ask, disableBypassPermissionsMode', () => {
    writeAgentConfig({})
    writeFileSync(localPath(), JSON.stringify(MIXED))
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    writeAgentSettingsFromProfile(TEST_AGENT, loadProfileTemplate('developer-junior'))
    const after = JSON.parse(readFileSync(localPath(), 'utf-8')) as { permissions?: Record<string, unknown> }
    expect(after.permissions?.deny).toEqual(MIXED.permissions.deny)
    expect(after.permissions?.ask).toEqual(MIXED.permissions.ask)
    expect(after.permissions?.disableBypassPermissionsMode).toBe('disable')
  })

  it('CONTROL: a permissive spawn leaves the local permissions alone', () => {
    writeAgentConfig({})
    writeFileSync(localPath(), JSON.stringify(LOCAL))
    writeAgentSettingsFromProfile(TEST_AGENT, loadProfileTemplate('default'))
    const after = JSON.parse(readFileSync(localPath(), 'utf-8')) as Record<string, unknown>
    expect(after.permissions).toEqual(LOCAL.permissions)
  })

  it('sanitizeAgentLocalSettings reports stripped for strict, clean without the mode', () => {
    writeAgentConfig({})
    writeFileSync(localPath(), JSON.stringify({ permissions: { allow: ['Read(//**)'] } }))
    expect(sanitizeAgentLocalSettings(TEST_AGENT)).toBe('clean')
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    expect(sanitizeAgentLocalSettings(TEST_AGENT, 'strict')).toBe('stripped')
  })
})

describe('strict deny list covers the agent\'s own limit-defining files (S3)', () => {
  // The paths, each written once; every one must come out as an Edit rule AND its Write twin (Dani N1).
  const paths = (root: string) => [
    join(root, '.claude', 'settings.json'),
    join(root, '.claude', 'settings.local.json'),
    join(root, '.claude-config', 'settings.json'),
    join(root, '.claude-config', 'settings.local.json'),
    join(root, '.claude-config', '.claude.json'),
    `${join(root, '.claude-config', 'plugins')}/**`,
    `${join(root, '.claude-config', 'skills')}/**`,
    `${join(root, '.claude-config', 'hooks')}/**`,
    `${join(root, '.claude-config', 'agents')}/**`,
    `${join(root, '.claude-config', 'commands')}/**`,
    `${join(PROJECT_ROOT, 'scripts')}/**`,
    `${join(homedir(), '.claude', 'hooks')}/**`,
    `${join(STORE_DIR, 'bash-sandbox')}/**`,
    join(STORE_DIR, 'egress-vendor-hosts.json'),
    join(STORE_DIR, 'bash-sandbox-write-paths.json'),
    // Dani B1: what selects or defines the profile and the gates.
    join(root, 'agent-config.json'),
    join(root, '.mcp.json'),
    `${join(PROJECT_ROOT, 'templates', 'profiles')}/**`,
    join(PROJECT_ROOT, '.env'),
    `${join(PROJECT_ROOT, 'local-hooks')}/**`,
    join(STORE_DIR, 'extra-hooks.json'),
    join(STORE_DIR, 'autonomy-config.json'),
    join(STORE_DIR, 'agent-sender-role-gates.json'),
    join(STORE_DIR, 'config-overrides.json'),
  ]
  const expected = (root: string) => paths(root).flatMap(p => [`Edit(/${p})`, `Write(/${p})`])

  it('every rule is an absolute `//` Edit or Write rule, in the expected set', () => {
    const rules = strictSelfProtectDeny(agentRoot)
    expect(rules).toEqual(expected(agentRoot))
    for (const r of rules) expect(/^(Edit|Write)\(\/\//.test(r)).toBe(true)
  })

  it('every Edit rule has its Write twin and vice versa (N1)', () => {
    const rules = strictSelfProtectDeny(agentRoot)
    const edits = rules.filter(r => r.startsWith('Edit(')).map(r => r.slice('Edit'.length))
    const writes = rules.filter(r => r.startsWith('Write(')).map(r => r.slice('Write'.length))
    expect(edits.length).toBe(paths(agentRoot).length)
    expect([...writes].sort()).toEqual([...edits].sort())
  })

  it('B1: the agent-config.json (securityProfile) rule is present for this agent', () => {
    const rules = strictSelfProtectDeny(agentRoot)
    expect(rules).toContain(`Edit(/${join(agentRoot, 'agent-config.json')})`)
    expect(rules).toContain(`Write(/${join(agentRoot, 'agent-config.json')})`)
  })

  it('the agent\'s file memory (.claude-config/projects) is NOT denied, nor the config dir as a whole', () => {
    const cfg = join(agentRoot, '.claude-config')
    for (const r of strictSelfProtectDeny(agentRoot)) {
      for (const tool of ['Edit', 'Write']) {
        expect(r.startsWith(`${tool}(/${join(cfg, 'projects')}`)).toBe(false)
        expect(r).not.toBe(`${tool}(/${cfg}/**)`)
        expect(r).not.toBe(`${tool}(/${cfg})`)
      }
    }
  })

  it('a strict profile\'s written settings.json carries all of them', () => {
    writeAgentConfig({})
    const strict: ProfileTemplate = loadProfileTemplate('developer-junior')
    writeAgentSettingsFromProfile(TEST_AGENT, strict)
    const deny = (JSON.parse(readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8')).permissions as { deny: string[] }).deny
    for (const rule of expected(agentRoot)) expect(deny).toContain(rule)
  })

  it('CONTROL: a permissive profile does not get them (no change for permissive agents)', () => {
    writeAgentConfig({})
    writeAgentSettingsFromProfile(TEST_AGENT, loadProfileTemplate('default'))
    const deny = (JSON.parse(readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8')).permissions as { deny: string[] }).deny
    for (const rule of expected(agentRoot)) expect(deny).not.toContain(rule)
  })
})

describe('no PreToolUse hook answers "ask"', () => {
  // Every script a sub-agent's settings can run lives under scripts/ (agent-scaffold.ts hookCommand paths).
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(full); continue }
      if (/\.(mjs|js|py|sh)$/.test(e.name)) files.push(full)
    }
  }
  walk(join(ROOT, 'scripts'))

  it('CONTROL: the scan reaches the gates', () => {
    expect(files.some(f => f.endsWith(join('hooks', 'db-write-gate.mjs')))).toBe(true)
    expect(files.some(f => f.endsWith(join('hooks', 'second-reviewer-gate.py')))).toBe(true)
  })

  it('no script emits permissionDecision "ask"', () => {
    const offenders = files.filter(f => /permissionDecision['"]?\s*:\s*['"]ask['"]/.test(readFileSync(f, 'utf-8')))
    expect(offenders).toEqual([])
  })

  it('the second reviewer turns a dashboard "ask" into a block (exit 2), not a prompt', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'hooks', 'second-reviewer-gate.py'), 'utf-8')
    const tail = src.slice(src.indexOf('if decision == "allow":'))
    expect(tail).toMatch(/approval = str\(answer\.get\("approval_id", ""\)\)\[:300\]\n\s*stop\(/)
    expect(src).toMatch(/def stop\(msg: str\):\n\s*sys\.stderr\.write\(msg\)\n\s*sys\.exit\(2\)/)
  })
})
