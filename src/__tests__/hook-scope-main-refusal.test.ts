// #1305 (ISSUE1305HOOKSCOPE): no scaffold write may target the user-global
// ~/.claude/settings.json. The main agent's hooks are repo-shipped in the
// tracked <root>/.claude/settings.json (project scope); writing them into the
// user scope is what made fleet gates fire in the owner's own, unrelated
// Claude Code sessions (blocked WebFetch, injected provenance banners).
//
// Every writer that resolves its target through agentSettingsPath() is gated:
// ensureAgentHooks, ensureAgentStalenessHook, ensureAgentProvenanceHook,
// ensureEgressGate. Each test asserts the REFUSAL (return false + the
// user-global file untouched) and each has a mutation control (the same call
// for a sub-agent still writes), so a broken gate cannot pass as "nothing
// happened for anyone".
//
// HOME is redirected to a temp dir for every test: agentSettingsPath(main)
// resolves through os.homedir() at call time, so even a broken gate can only
// write into the sandbox, never into the operator's real home.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureAgentHooks,
  ensureAgentStalenessHook,
  ensureAgentProvenanceHook,
  ensureEgressGate,
  agentSettingsPath,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'

const PROBE = 'mainrefusal-probe'
const probeDir = join(PROJECT_ROOT, 'agents', PROBE)

let fakeHome: string
let realHome: string | undefined
let mainSettings: string

const MARKER = '{"hooks":{"marker":"untouched-by-1305-gate"}}'

beforeEach(() => {
  realHome = process.env.HOME
  fakeHome = mkdtempSync(join(tmpdir(), 'refuse1305-'))
  process.env.HOME = fakeHome
  mkdirSync(join(fakeHome, '.claude'), { recursive: true })
  mainSettings = agentSettingsPath(MAIN_AGENT_ID)
  // Sanity: the redirect took, we are sandboxed.
  expect(mainSettings).toBe(join(fakeHome, '.claude', 'settings.json'))
  writeFileSync(mainSettings, MARKER)

  if (existsSync(join(probeDir, 'HANDOFF.md'))) {
    throw new Error(`refusing: agents/${PROBE} looks like a live agent`)
  }
  rmSync(probeDir, { recursive: true, force: true })
  mkdirSync(join(probeDir, '.claude'), { recursive: true })
})

afterEach(() => {
  process.env.HOME = realHome
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(probeDir, { recursive: true, force: true })
})

function mainFileUntouched(): void {
  expect(readFileSync(mainSettings, 'utf-8')).toBe(MARKER)
}

function probeHookCommands(): string[] {
  const p = agentSettingsPath(PROBE)
  if (!existsSync(p)) return []
  const parsed = JSON.parse(readFileSync(p, 'utf-8')) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  }
  return Object.values(parsed.hooks ?? {})
    .flat()
    .flatMap((e) => e.hooks ?? [])
    .map((h) => h.command ?? '')
}

describe('#1305: scaffold hook writers refuse the main agent', () => {
  it('ensureAgentHooks: main is a no-op, a sub-agent still gets the template', () => {
    expect(ensureAgentHooks(MAIN_AGENT_ID)).toBe(false)
    mainFileUntouched()
    // Mutation control: the identical call for a sub-agent writes.
    expect(ensureAgentHooks(PROBE)).toBe(true)
    expect(probeHookCommands().length).toBeGreaterThan(0)
    mainFileUntouched()
  })

  it('ensureAgentStalenessHook: main is a no-op, a sub-agent still gets the hook', () => {
    expect(ensureAgentStalenessHook(MAIN_AGENT_ID)).toBe(false)
    mainFileUntouched()
    expect(ensureAgentStalenessHook(PROBE)).toBe(true)
    expect(probeHookCommands().some((c) => c.includes('staleness-guard.py'))).toBe(true)
    mainFileUntouched()
  })

  it('ensureAgentProvenanceHook: main is a no-op, a sub-agent still gets the gate', () => {
    expect(ensureAgentProvenanceHook(MAIN_AGENT_ID)).toBe(false)
    mainFileUntouched()
    expect(ensureAgentProvenanceHook(PROBE)).toBe(true)
    expect(probeHookCommands().some((c) => c.includes('provenance-gate.py'))).toBe(true)
    mainFileUntouched()
  })

  it('ensureEgressGate: main is a no-op, a sub-agent still gets the gate', () => {
    expect(ensureEgressGate(MAIN_AGENT_ID)).toBe(false)
    mainFileUntouched()
    expect(ensureEgressGate(PROBE)).toBe(true)
    expect(probeHookCommands().some((c) => c.includes('egress-gate.mjs'))).toBe(true)
    mainFileUntouched()
  })

  it('a main-agent settings file is not even created when absent', () => {
    rmSync(mainSettings, { force: true })
    ensureAgentHooks(MAIN_AGENT_ID)
    ensureAgentStalenessHook(MAIN_AGENT_ID)
    ensureAgentProvenanceHook(MAIN_AGENT_ID)
    ensureEgressGate(MAIN_AGENT_ID)
    expect(existsSync(mainSettings)).toBe(false)
  })
})
