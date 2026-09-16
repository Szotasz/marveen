/**
 * Card a14ea5c7 -- the destructive-gate was hand-written into six agents'
 * settings.json on 2026-09-08 and into NO code path. writeAgentSettingsFromProfile
 * regenerates settings.json from profile templates that carry no hooks section,
 * so the next spawn would have dropped the gate silently: the file would still
 * look fine, only the protection would be gone.
 *
 * These tests assert the FINAL settings file after a re-render, not the inject
 * function alone -- that is the distinction HBGATEWIRE826 was paid for.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentGetsDestructiveGate,
  injectDestructiveGate,
  ensureGovernanceGateCommands,
  writeAgentSettingsFromProfile,
  agentSettingsPath,
  DESTRUCTIVE_GATE_MATCHER,
} from '../web/agent-scaffold.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

const TEST_AGENT = 'destructive-gate-probe'
const settingsFor = (n: string) => agentSettingsPath(n)
// NEVER derive this for MAIN_AGENT_ID: agentSettingsPath() sends the main agent
// to ~/.claude/settings.json, so a "render the main agent and look" test would
// rewrite the owner's LIVE settings file. The main-agent case is therefore
// checked by the pure predicate plus a source-level pin, never by rendering.
const agentRoot = (n: string) => join(AGENTS_BASE_DIR, n)

// The four gates a plain sub-agent already carried before this card. If a fifth
// injector shifts one of them out, this list is what goes red.
const EXISTING_GATES = [
  'email-send-gate.mjs',
  'self-pace-gate.mjs',
  'outgoing-copy-gate.py',
  'egress-gate.mjs',
]

function cleanup(): void {
  const root = agentRoot(TEST_AGENT)
  if (!existsSync(root)) return
  // Only ever remove the throwaway directory this test created. A real agent
  // dir carries far more than a .claude folder, and deleting one is an
  // incident, so both the path prefix and the contents are checked.
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

function render(name: string): string {
  mkdirSync(join(agentRoot(name), '.claude'), { recursive: true })
  writeAgentSettingsFromProfile(name, loadProfileTemplate('default'))
  return readFileSync(settingsFor(name), 'utf-8')
}

describe('scope: who gets the destructive gate', () => {
  it('every sub-agent does', () => {
    for (const n of ['leanscout', 'leanwriter', 'gembaecho', TEST_AGENT]) {
      expect(agentGetsDestructiveGate(n)).toBe(true)
    }
  })
  it('the main agent does NOT -- the card is explicit, do not break it', () => {
    expect(agentGetsDestructiveGate(MAIN_AGENT_ID)).toBe(false)
  })
})

describe('the FINAL settings file after a re-render', () => {
  it('a fresh render wires the gate', () => {
    expect(render(TEST_AGENT)).toContain('destructive-gate.py')
  })

  it('(b) a SECOND render keeps it -- exactly once, no accumulation', () => {
    render(TEST_AGENT)
    const final = JSON.parse(render(TEST_AGENT)) as { hooks: { PreToolUse: unknown[] } }
    const entries = final.hooks.PreToolUse.filter((e) => JSON.stringify(e).includes('destructive-gate.py'))
    expect(entries).toHaveLength(1)
    expect((entries[0] as { matcher: string }).matcher).toBe(DESTRUCTIVE_GATE_MATCHER)
  })

  it('(c) the four pre-existing gates are still wired, unchanged', () => {
    const final = render(TEST_AGENT)
    for (const gate of EXISTING_GATES) expect(final).toContain(gate)
  })

  it('(d) the main agent is not rendered here -- the exemption is pinned in source', () => {
    // agentSettingsPath(MAIN_AGENT_ID) is the owner's LIVE ~/.claude/settings.json,
    // so rendering it to prove a negative would mutate production. The runtime
    // guarantee is two lines in the scaffold: the destructive gate sits behind
    // its predicate, and the egress gate deliberately does NOT (every agent can
    // be hijacked through an injected WebFetch, the main one included).
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(src).toContain('if (agentGetsDestructiveGate(name)) injectDestructiveGate(existing)')
    expect(src).toMatch(/^ {2}injectEgressGate\(existing\)$/m)
  })

  it('RED-BEFORE property: a template-only render loses the gate', () => {
    // The pre-fix behaviour, replayed: the profile templates carry no hooks
    // section at all, so without the injector the gate simply is not there.
    const tpl = JSON.stringify(loadProfileTemplate('default'))
    expect(tpl).not.toContain('destructive-gate.py')
  })
})

describe('the startup migration for the EXISTING fleet', () => {
  it('adds the gate to an agent scaffolded before this change', () => {
    render(TEST_AGENT)
    // Simulate the pre-card state: strip the gate back out of the file.
    const path = settingsFor(TEST_AGENT)
    const s = JSON.parse(readFileSync(path, 'utf-8')) as { hooks: { PreToolUse: unknown[] } }
    s.hooks.PreToolUse = s.hooks.PreToolUse.filter((e) => !JSON.stringify(e).includes('destructive-gate.py'))
    writeFileSync(path, JSON.stringify(s, null, 2))
    expect(readFileSync(path, 'utf-8')).not.toContain('destructive-gate.py')

    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toContain('destructive-gate.py')
  })

  it('is a no-op on a second pass (no rewrite churn at every boot)', () => {
    render(TEST_AGENT)
    ensureGovernanceGateCommands(TEST_AGENT)
    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(false)
  })

  it('replaces a STALE matcher instead of leaving a gate that never fires', () => {
    render(TEST_AGENT)
    const path = settingsFor(TEST_AGENT)
    const s = JSON.parse(readFileSync(path, 'utf-8')) as { hooks: { PreToolUse: Array<{ matcher: string }> } }
    for (const e of s.hooks.PreToolUse) {
      if (JSON.stringify(e).includes('destructive-gate.py')) e.matcher = 'Bash'
    }
    writeFileSync(path, JSON.stringify(s, null, 2))

    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(true)
    const after = JSON.parse(readFileSync(path, 'utf-8')) as { hooks: { PreToolUse: Array<{ matcher: string }> } }
    const entries = after.hooks.PreToolUse.filter((e) => JSON.stringify(e).includes('destructive-gate.py'))
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe(DESTRUCTIVE_GATE_MATCHER)
  })
})

describe('the matcher reaches every destructive tool', () => {
  it('fires on Bash AND the native file tools', () => {
    const s: Record<string, unknown> = {}
    injectDestructiveGate(s)
    const ptu = (s.hooks as Record<string, unknown>).PreToolUse as Array<{ matcher: string }>
    const re = new RegExp(`^(?:${ptu[0].matcher})$`)
    for (const t of ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit']) expect(re.test(t)).toBe(true)
    expect(re.test('WebFetch')).toBe(false)
  })

  it('injectDestructiveGate is idempotent and leaves foreign entries alone', () => {
    const s: Record<string, unknown> = {
      hooks: { PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'node "/x/egress-gate.mjs"' }] }] },
    }
    injectDestructiveGate(s)
    injectDestructiveGate(s)
    const ptu = (s.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(ptu.filter((e) => JSON.stringify(e).includes('destructive-gate.py'))).toHaveLength(1)
    expect(JSON.stringify(ptu)).toContain('egress-gate.mjs')
  })
})
