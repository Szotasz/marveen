/**
 * CREDGATE1003 -- the credential gate (scripts/hooks/credential-gate.py) on a
 * sub-agent's letter tools, opt-in per security profile (`"credentialGate":
 * true`), default OFF. The property this suite exists for: with the switch off
 * the rendered settings.json is byte-identical to a render by a scaffold that
 * has never heard of the gate, so merging this code changes no install.
 *
 * Same method as destructive-gate-wiring.test.ts: the FINAL settings file after
 * a re-render is asserted, not the inject function alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentGetsCredentialGate,
  injectCredentialGate,
  ensureGovernanceGateCommands,
  writeAgentSettingsFromProfile,
  agentSettingsPath,
  EMAIL_GATE_MATCHER,
} from '../web/agent-scaffold.js'
import { listProfileTemplates, loadProfileTemplate, type ProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

const TEST_AGENT = 'credential-gate-probe'
const settingsFor = (n: string) => agentSettingsPath(n)
// NEVER render MAIN_AGENT_ID: its settings path is the owner's live file.
const agentRoot = (n: string) => join(AGENTS_BASE_DIR, n)

function cleanup(): void {
  const root = agentRoot(TEST_AGENT)
  if (!existsSync(root)) return
  if (!root.startsWith(join(AGENTS_BASE_DIR, TEST_AGENT))) {
    throw new Error(`refusing: ${root} is outside the agents base dir`)
  }
  if (existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, 'HANDOFF.md'))) {
    throw new Error(`refusing: ${root} looks like a live agent, not a test checkout`)
  }
  rmSync(root, { recursive: true, force: true })
}

beforeEach(cleanup)
afterEach(cleanup)

const BASE: ProfileTemplate = loadProfileTemplate('default')
const ON: ProfileTemplate = { ...BASE, credentialGate: true }
const OFF_EXPLICIT: ProfileTemplate = { ...BASE, credentialGate: false }

function render(profile: ProfileTemplate, fresh = true): string {
  if (fresh) cleanup()
  mkdirSync(join(agentRoot(TEST_AGENT), '.claude'), { recursive: true })
  writeAgentSettingsFromProfile(TEST_AGENT, profile)
  return readFileSync(settingsFor(TEST_AGENT), 'utf-8')
}

type Settings = { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }
const credentialEntries = (s: string) =>
  (JSON.parse(s) as Settings).hooks.PreToolUse.filter((e) => JSON.stringify(e).includes('credential-gate.py'))

describe('scope: who gets the credential gate', () => {
  it('a sub-agent whose profile opts in does', () => {
    expect(agentGetsCredentialGate(TEST_AGENT, ON)).toBe(true)
  })

  it('a profile that does not opt in -- absent or false -- does not', () => {
    expect(agentGetsCredentialGate(TEST_AGENT, BASE)).toBe(false)
    expect(agentGetsCredentialGate(TEST_AGENT, OFF_EXPLICIT)).toBe(false)
  })

  it('no shipped template opts in', () => {
    for (const p of listProfileTemplates()) expect(p.credentialGate).not.toBe(true)
  })

  it('never the main agent, not even on an opted-in profile', () => {
    expect(agentGetsCredentialGate(MAIN_AGENT_ID, ON)).toBe(false)
  })
})

describe('OFF: the rendered settings.json is byte-identical to a render without the gate', () => {
  it('absent and explicit false render the same bytes, with no trace of the gate', () => {
    const absent = render(BASE)
    const off = render(OFF_EXPLICIT)
    expect(off).toBe(absent)
    expect(absent).not.toContain('credential-gate')
  })

  it('the only code path to the gate is behind its predicate (pinned in source)', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(src).toContain('if (agentGetsCredentialGate(name, profile)) injectCredentialGate(existing)')
    expect(src).toContain('if (needCredential) injectCredentialGate(settings)')
    // Exactly these two call sites: a third, unguarded one would wire the gate
    // into every install.
    expect(src.match(/injectCredentialGate\((existing|settings)\)/g)).toHaveLength(2)
  })

  it('the startup migration leaves an OFF agent byte-identical', () => {
    const before = render(BASE)
    expect(ensureGovernanceGateCommands(TEST_AGENT, BASE)).toBe(false)
    expect(readFileSync(settingsFor(TEST_AGENT), 'utf-8')).toBe(before)
  })
})

describe('ON: exactly one entry, on the email-gate matcher, and nothing else moves', () => {
  it('wires one entry with the email-gate matcher and the python hook', () => {
    const entries = credentialEntries(render(ON))
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe(EMAIL_GATE_MATCHER)
    expect(entries[0].hooks[0].command).toContain(join('scripts', 'hooks', 'credential-gate.py'))
  })

  it('ON minus the gate entry equals OFF: the switch adds the entry and changes nothing else', () => {
    const off = JSON.parse(render(BASE)) as Settings
    const on = JSON.parse(render(ON)) as Settings
    on.hooks.PreToolUse = on.hooks.PreToolUse.filter((e) => !JSON.stringify(e).includes('credential-gate.py'))
    expect(JSON.stringify(on, null, 2)).toBe(JSON.stringify(off, null, 2))
  })

  it('a second render keeps exactly one entry (no accumulation)', () => {
    render(ON)
    expect(credentialEntries(render(ON, false))).toHaveLength(1)
  })

  it('switching OFF later does not tear the entry down (a teardown is a deliberate act)', () => {
    render(ON)
    expect(credentialEntries(render(BASE, false))).toHaveLength(1)
  })
})

describe('the startup migration for an agent whose profile opts in', () => {
  it('adds the gate to an agent scaffolded before the switch was set', () => {
    render(BASE)
    expect(ensureGovernanceGateCommands(TEST_AGENT, ON)).toBe(true)
    expect(credentialEntries(readFileSync(settingsFor(TEST_AGENT), 'utf-8'))).toHaveLength(1)
  })

  it('is a no-op on a second pass', () => {
    render(ON)
    expect(ensureGovernanceGateCommands(TEST_AGENT, ON)).toBe(false)
  })

  it('replaces a stale matcher instead of leaving a gate that never fires', () => {
    render(ON)
    const path = settingsFor(TEST_AGENT)
    const s = JSON.parse(readFileSync(path, 'utf-8')) as Settings
    for (const e of s.hooks.PreToolUse) if (JSON.stringify(e).includes('credential-gate.py')) e.matcher = 'Bash'
    writeFileSync(path, JSON.stringify(s, null, 2))
    expect(ensureGovernanceGateCommands(TEST_AGENT, ON)).toBe(true)
    const entries = credentialEntries(readFileSync(path, 'utf-8'))
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe(EMAIL_GATE_MATCHER)
  })
})

describe('injectCredentialGate on its own', () => {
  it('is idempotent and leaves foreign entries alone', () => {
    const s: Record<string, unknown> = {
      hooks: { PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'node "/x/egress-gate.mjs"' }] }] },
    }
    injectCredentialGate(s)
    injectCredentialGate(s)
    const ptu = (s.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(ptu.filter((e) => JSON.stringify(e).includes('credential-gate.py'))).toHaveLength(1)
    expect(JSON.stringify(ptu)).toContain('egress-gate.mjs')
  })
})
