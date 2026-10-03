/**
 * Card 0ad8d161 -- the kill gate (scripts/hooks/kill-gate.py) on every agent.
 *
 * A gate script that passes its own tests but is wired nowhere runs nowhere. These
 * pin the binding the card asks for: every sub-agent gets the Bash hook from the
 * scaffold, on spawn AND by the startup migration; the main agent gets it from the
 * committed project settings (also pinned in project-settings-hook-anchor.test.ts);
 * and no other injector strips it. As in destructive-gate-wiring.test.ts, the FINAL
 * settings file after a render is checked, not the inject function alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentGetsKillGate,
  injectKillGate,
  ensureKillGate,
  injectBashEgressParser,
  injectEgressGate,
  injectSelfPaceGate,
  writeAgentSettingsFromProfile,
  agentSettingsPath,
} from '../web/agent-scaffold.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

const TEST_AGENT = 'kill-gate-probe'
// NEVER derive a settings path for MAIN_AGENT_ID here: agentSettingsPath() sends the
// main agent to ~/.claude/settings.json, the owner's live file.
const agentRoot = (n: string) => join(AGENTS_BASE_DIR, n)

type Entry = { matcher?: string; hooks?: Array<{ command?: string }> }
const ptu = (s: Record<string, unknown>) =>
  (((s.hooks as Record<string, unknown>)?.PreToolUse ?? []) as Entry[])
const gateEntries = (s: Record<string, unknown>) => ptu(s).filter((e) => JSON.stringify(e).includes('kill-gate.py'))

function cleanup(): void {
  const root = agentRoot(TEST_AGENT)
  if (!existsSync(root)) return
  // Only ever remove the throwaway directory this test created.
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

function writeSettings(s: Record<string, unknown>): string {
  mkdirSync(join(agentRoot(TEST_AGENT), '.claude'), { recursive: true })
  const p = agentSettingsPath(TEST_AGENT)
  writeFileSync(p, JSON.stringify(s, null, 2))
  return p
}

describe('scope', () => {
  it('covers every sub-agent; the main agent is exempt here because its copy ships in the project settings', () => {
    expect(agentGetsKillGate(MAIN_AGENT_ID)).toBe(false)
    for (const n of ['social', 'emma', 'heartbeat-worker', TEST_AGENT]) expect(agentGetsKillGate(n)).toBe(true)
  })
})

describe('injectKillGate', () => {
  it('wires the hook on the Bash matcher, once, however often it runs', () => {
    const s: Record<string, unknown> = {}
    injectKillGate(s)
    injectKillGate(s)
    const entries = gateEntries(s)
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe('Bash')
    expect(entries[0].hooks?.[0]?.command).toContain(join(PROJECT_ROOT, 'scripts', 'hooks', 'kill-gate.py'))
  })

  it('survives the other gate injectors, and they survive it', () => {
    const s: Record<string, unknown> = {}
    injectKillGate(s)
    injectBashEgressParser(s)
    injectEgressGate(s)
    injectSelfPaceGate(s)
    expect(gateEntries(s)).toHaveLength(1)
    const all = JSON.stringify(ptu(s))
    expect(all).toContain('bash-egress-parser.mjs')
    expect(all).toContain('egress-gate.mjs')
  })

  it('replaces a stale entry (another matcher, an old path) instead of keeping two', () => {
    const s: Record<string, unknown> = {
      hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'python3 /old/scripts/hooks/kill-gate.py' }] }] },
    }
    injectKillGate(s)
    const entries = gateEntries(s)
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe('Bash')
    expect(JSON.stringify(entries)).not.toContain('/old/')
  })
})

describe('the rendered settings file', () => {
  it('a spawn render (writeAgentSettingsFromProfile) carries the hook next to the existing gates', () => {
    mkdirSync(join(agentRoot(TEST_AGENT), '.claude'), { recursive: true })
    writeAgentSettingsFromProfile(TEST_AGENT, loadProfileTemplate('default'))
    const s = JSON.parse(readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8'))
    expect(gateEntries(s)).toHaveLength(1)
    expect(gateEntries(s)[0].matcher).toBe('Bash')
    expect(JSON.stringify(ptu(s))).toContain('egress-gate.mjs')
  })

  it('ensureKillGate backfills an existing settings file once, then is a no-op', () => {
    const p = writeSettings({ hooks: { PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'x' }] }] } })
    expect(ensureKillGate(TEST_AGENT)).toBe(true)
    const s = JSON.parse(readFileSync(p, 'utf-8'))
    expect(gateEntries(s)).toHaveLength(1)
    expect(ptu(s).some((e) => e.matcher === 'WebFetch')).toBe(true)
    expect(ensureKillGate(TEST_AGENT)).toBe(false)
  })

  it('ensureKillGate rewrites an entry under a wrong matcher', () => {
    const p = writeSettings({})
    const s: Record<string, unknown> = {}
    injectKillGate(s)
    gateEntries(s)[0].matcher = 'Read'
    writeFileSync(p, JSON.stringify(s, null, 2))
    expect(ensureKillGate(TEST_AGENT)).toBe(true)
    expect(gateEntries(JSON.parse(readFileSync(p, 'utf-8')))[0].matcher).toBe('Bash')
  })

  it('ensureKillGate creates nothing for an agent that has no settings file yet', () => {
    expect(ensureKillGate(TEST_AGENT)).toBe(false)
    expect(existsSync(agentSettingsPath(TEST_AGENT))).toBe(false)
  })

  it('ensureKillGate never touches the main agent', () => {
    expect(ensureKillGate(MAIN_AGENT_ID)).toBe(false)
  })
})

describe('call sites and the main agent copy', () => {
  it('is called from the spawn path and the startup migration', () => {
    const scaffold = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    const spawn = scaffold.slice(scaffold.indexOf('export function writeAgentSettingsFromProfile'))
    const spawnBody = spawn.slice(0, spawn.indexOf('\n}\n'))
    expect(spawnBody).toContain('if (agentGetsKillGate(name)) injectKillGate(existing)')
    const web = readFileSync(join(PROJECT_ROOT, 'src', 'web.ts'), 'utf-8')
    expect(web).toMatch(/if \(ensureKillGate\(agentName\)\) killGatePatched\.push\(agentName\)/)
  })

  it('the committed project settings carry exactly one kill-gate entry, on Bash, through $CLAUDE_PROJECT_DIR', () => {
    const s = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8'))
    const entries = gateEntries(s)
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe('Bash')
    expect(entries[0].hooks?.[0]?.command).toBe('python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/kill-gate.py"')
  })
})
