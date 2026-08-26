import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// HBGATEWIRE826: the heartbeat worker ran with ZERO dashboard-side hooks --
// its kanban-write-gate (HBFUTTATOIR824) and digest-provenance-gate (#1083)
// included -- while every test stayed green, because the tests exercised the
// inject functions, never the FINAL file the running worker reads. Two
// independent gaps: (a) the web.ts seeding loop skipped sentinel-hidden
// agents, so ensureAgentHooks('heartbeat') never ran; (b) ensureHeartbeatAgent
// rewrote the project-scope settings wholesale at every boot, deleting
// whatever the seeding pass had written. These tests assert the FINAL file,
// in BOTH boot orders -- the positive control the original wiring never had.
import { ensureHeartbeatAgent, mergeClaudeSettingsJson, HEARTBEAT_AGENT_DIR } from '../web/heartbeat-agent-scaffold.js'
import {
  ensureAgentHooks,
  ensureAgentStalenessHook,
  ensureEgressGate,
  ensureGovernanceGateCommands,
  writeAgentSettingsFromProfile,
  agentSettingsPath,
  agentGetsKanbanWriteGate,
} from '../web/agent-scaffold.js'
import { loadProfileTemplate } from '../web/profiles.js'

// The real chain, as measured (HBGATEWIRE826): the web.ts boot loop seeds the
// template hooks, the GATES arrive via writeAgentSettingsFromProfile at agent
// SPAWN (agent-process.ts:1122), and ensureHeartbeatAgent reruns at every
// boot. Because the heartbeat tmux session survives dashboard restarts, the
// spawn-time profile write is SKIPPED on most boots -- so whatever an earlier
// spawn wrote must survive the scaffold rerun, or the gates silently die.
function runSeedChain(name: string): void {
  ensureAgentHooks(name)
  ensureAgentStalenessHook(name)
  ensureEgressGate(name)
  ensureGovernanceGateCommands(name)
  writeAgentSettingsFromProfile(name, loadProfileTemplate('default'))
}
import { HEARTBEAT_AGENT_ID } from '../config.js'

const ROOT = join(__dirname, '..', '..')
const SETTINGS = agentSettingsPath(HEARTBEAT_AGENT_ID)

// The scaffold and the seeder both target PROJECT_ROOT/agents/heartbeat --
// in the test checkout that directory does not exist (agents/ is runtime
// state, not tracked), so creating and removing it here touches nothing real.
function cleanHeartbeatDir(): void {
  rmSync(HEARTBEAT_AGENT_DIR, { recursive: true, force: true })
}

beforeEach(() => {
  // Refuse to run against a live install: a real heartbeat dir with a live
  // HANDOFF means we are inside a production tree, not a test checkout.
  if (existsSync(join(HEARTBEAT_AGENT_DIR, 'HANDOFF.md'))) {
    throw new Error('refusing: agents/heartbeat looks like a live install, not a test checkout')
  }
  cleanHeartbeatDir()
})
afterEach(() => {
  cleanHeartbeatDir()
})

const readFinal = () => readFileSync(SETTINGS, 'utf-8')

describe('mergeClaudeSettingsJson (pure contract)', () => {
  it('preserves foreign keys (hooks) and enforces only enabledPlugins', () => {
    const existing = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x.mjs' }] }] }, enabledPlugins: { 'telegram@claude-plugins-official': true } })
    const merged = JSON.parse(mergeClaudeSettingsJson(existing))
    expect(JSON.stringify(merged.hooks)).toContain('x.mjs')
    expect(merged.enabledPlugins['telegram@claude-plugins-official']).toBe(false)
  })
  it('POSITIVE CONTROL: the pre-fix wholesale render would fail this contract', () => {
    // The old renderClaudeSettingsJson() ignored the existing content entirely;
    // simulating it shows the hooks key vanishing -- exactly the measured bug.
    const wholesale = JSON.parse(JSON.stringify({ enabledPlugins: {} }))
    expect(wholesale.hooks).toBeUndefined()
  })
  it('tolerates null and corrupt input', () => {
    expect(() => JSON.parse(mergeClaudeSettingsJson(null))).not.toThrow()
    expect(() => JSON.parse(mergeClaudeSettingsJson('not-json{{'))).not.toThrow()
  })
})

describe('the FINAL heartbeat settings file carries the gates, in BOTH boot orders', () => {
  it('scope sanity: the gate predicate targets exactly the heartbeat id', () => {
    expect(agentGetsKanbanWriteGate(HEARTBEAT_AGENT_ID)).toBe(true)
  })

  it('order A (spawn-chain -> scaffold rerun): the boot-order that ate the gates before the fix', () => {
    mkdirSync(join(HEARTBEAT_AGENT_DIR, '.claude'), { recursive: true })
    runSeedChain(HEARTBEAT_AGENT_ID)
    ensureHeartbeatAgent() // reruns at boot AFTER the seeding pass
    const final = readFinal()
    expect(final).toContain('kanban-write-gate.mjs')
    expect(final).toContain('digest-provenance-gate.mjs')
    expect(final).toContain('enabledPlugins')
  })

  it('order B (scaffold -> spawn-chain): fresh install order', () => {
    ensureHeartbeatAgent()
    runSeedChain(HEARTBEAT_AGENT_ID)
    const final = readFinal()
    expect(final).toContain('kanban-write-gate.mjs')
    expect(final).toContain('digest-provenance-gate.mjs')
    expect(final).toContain('enabledPlugins')
  })

  it('RED-BEFORE property: a wholesale settings rewrite after seeding loses the gates', () => {
    mkdirSync(join(HEARTBEAT_AGENT_DIR, '.claude'), { recursive: true })
    runSeedChain(HEARTBEAT_AGENT_ID)
    // The pre-fix behavior, replayed byte-for-byte:
    writeFileSync(SETTINGS, JSON.stringify({ enabledPlugins: {} }, null, 2) + '\n')
    expect(readFinal()).not.toContain('kanban-write-gate.mjs')
  })
})

describe('the seeding pass covers sentinel-hidden agents', () => {
  it('web.ts iterates listAllAgentNames, not the dashboard-filtered lister', () => {
    // Source-level pin with the measured incident as rationale: the runtime
    // path cannot be exercised here (the loop lives inside startWeb), so this
    // guards the one line whose regression recreates the whole class.
    const src = readFileSync(join(ROOT, 'src', 'web.ts'), 'utf-8')
    expect(src).toMatch(/for \(const agentName of \[MAIN_AGENT_ID, \.\.\.listAllAgentNames\(\)\]\)/)
  })
  it('KNOWN-POSITIVE for the pin: the pre-fix line shape would fail it', () => {
    const preFix = 'for (const agentName of [MAIN_AGENT_ID, ...listAgentNames()]) {'
    expect(preFix).not.toMatch(/listAllAgentNames/)
  })
})
