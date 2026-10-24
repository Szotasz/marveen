/**
 * D3(b) -- the second-reviewer gate wiring, opt-in per profile (`"secondReviewer": true`).
 * Same method as credential-gate-wiring.test.ts. The hook script is built in another task, so a
 * placeholder is created for the registration guard when it is absent, and removed afterwards.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentGetsSecondReviewer,
  injectSecondReviewerGate,
  removeSecondReviewerGate,
  ensureGovernanceGateCommands,
  writeAgentSettingsFromProfile,
  agentSettingsPath,
  SECOND_REVIEWER_MATCHER,
} from '../web/agent-scaffold.js'
import { loadProfileTemplate, profileWantsSecondReviewer, type ProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

const TEST_AGENT = 'second-reviewer-probe'
const agentRoot = (n: string) => join(AGENTS_BASE_DIR, n)
const hookDir = join(PROJECT_ROOT, 'scripts', 'hooks')
const hookPath = join(hookDir, 'second-reviewer-gate.py')
const created: string[] = []

beforeAll(() => {
  for (const d of [join(PROJECT_ROOT, 'scripts'), hookDir]) {
    if (!existsSync(d)) { mkdirSync(d); created.push(d) }
  }
  if (!existsSync(hookPath)) { writeFileSync(hookPath, '# placeholder\n'); created.push(hookPath) }
})
afterAll(() => {
  for (const p of created.reverse()) { try { p.endsWith('.py') ? rmSync(p) : rmdirSync(p) } catch { /* ignore */ } }
})

function cleanup(): void {
  const root = agentRoot(TEST_AGENT)
  if (!existsSync(root)) return
  if (existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, 'HANDOFF.md'))) {
    throw new Error(`refusing: ${root} looks like a live agent`)
  }
  rmSync(root, { recursive: true, force: true })
}
beforeEach(cleanup)
afterEach(cleanup)

const BASE: ProfileTemplate = loadProfileTemplate('default')
const ON: ProfileTemplate = { ...BASE, secondReviewer: true }

function render(profile: ProfileTemplate): string {
  cleanup()
  mkdirSync(join(agentRoot(TEST_AGENT), '.claude'), { recursive: true })
  writeAgentSettingsFromProfile(TEST_AGENT, profile)
  return readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8')
}
type Settings = { hooks?: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }> } }
const entries = (s: string) =>
  (JSON.parse(s) as Settings).hooks?.PreToolUse?.filter((e) => JSON.stringify(e).includes('second-reviewer-gate.py')) ?? []

describe('second reviewer wiring', () => {
  it('W1 off: no entry', () => {
    expect(entries(render(BASE))).toHaveLength(0)
  })
  it('W2 on: exactly one entry, matcher and timeout', () => {
    const e = entries(render(ON))
    expect(e).toHaveLength(1)
    expect(e[0].matcher).toBe(SECOND_REVIEWER_MATCHER)
    expect(e[0].hooks[0].timeout).toBe(180)
  })
  it('W3 never the main agent', () => {
    expect(agentGetsSecondReviewer(MAIN_AGENT_ID, ON)).toBe(false)
  })
  it('W4 inject twice leaves one entry', () => {
    const s: Record<string, unknown> = {}
    injectSecondReviewerGate(s)
    injectSecondReviewerGate(s)
    expect(((s.hooks as any).PreToolUse as unknown[])).toHaveLength(1)
  })
  it('W5 predicate is strict', () => {
    expect(profileWantsSecondReviewer(ON)).toBe(true)
    for (const v of [undefined, null, 'true', 1]) {
      expect(profileWantsSecondReviewer(v === undefined || v === null ? v : ({ secondReviewer: v } as any))).toBe(false)
    }
  })
  it('W6 on, then off: the respawn write drops the entry and keeps the other hooks', () => {
    render(ON)
    writeAgentSettingsFromProfile(TEST_AGENT, BASE)
    const s = readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8')
    expect(entries(s)).toHaveLength(0)
    expect((JSON.parse(s) as Settings).hooks?.PreToolUse?.length ?? 0).toBeGreaterThan(0)
  })
  it('W7 on, then off: ensureGovernanceGateCommands drops the entry and says it wrote', () => {
    render(ON)
    expect(ensureGovernanceGateCommands(TEST_AGENT, BASE)).toBe(true)
    expect(entries(readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8'))).toHaveLength(0)
    expect(ensureGovernanceGateCommands(TEST_AGENT, BASE)).toBe(false)
  })
  it('W8 still on: ensureGovernanceGateCommands keeps the one entry', () => {
    render(ON)
    ensureGovernanceGateCommands(TEST_AGENT, ON)
    expect(entries(readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8'))).toHaveLength(1)
  })
  it('W9 removeSecondReviewerGate touches only the reviewer entry', () => {
    const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 /x/scripts/hooks/destructive-gate.py' }] }
    const s: Record<string, unknown> = { hooks: { PreToolUse: [other] } }
    injectSecondReviewerGate(s)
    expect(removeSecondReviewerGate(s)).toBe(true)
    expect((s.hooks as any).PreToolUse).toEqual([other])
    expect(removeSecondReviewerGate(s)).toBe(false)
    expect(removeSecondReviewerGate({})).toBe(false)
  })
  it('W10 a hand-merged entry keeps its other hook; a lookalike script name is not the reviewer', () => {
    const other = { type: 'command', command: 'python3 /x/scripts/hooks/destructive-gate.py' }
    const lookalike = { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 /x/my-second-reviewer-gate.py' }] }
    const s: Record<string, unknown> = { hooks: { PreToolUse: [lookalike] } }
    injectSecondReviewerGate(s)
    const merged = (s.hooks as any).PreToolUse[1]
    merged.hooks.push(other)
    expect(removeSecondReviewerGate(s)).toBe(true)
    expect((s.hooks as any).PreToolUse).toEqual([lookalike, { ...merged, hooks: [other] }])
  })
  it('W11 a command that only names the file as an argument stays; a malformed entry does not throw', () => {
    const argOnly = { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 /x/audit.py second-reviewer-gate.py' }] }
    const malformed = { matcher: 'Bash', hooks: {} }
    const s: Record<string, unknown> = { hooks: { PreToolUse: [argOnly, malformed] } }
    expect(removeSecondReviewerGate(s)).toBe(false)
    injectSecondReviewerGate(s)
    expect(removeSecondReviewerGate(s)).toBe(true)
    expect((s.hooks as any).PreToolUse).toEqual([argOnly, malformed])
  })
  it('W12 still on, with a lookalike entry beside it: the migration pass settles after one write', () => {
    render(ON)
    const p = agentSettingsPath(TEST_AGENT)
    const s = JSON.parse(readFileSync(p, 'utf-8'))
    s.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 /x/my-second-reviewer-gate.py' }] })
    writeFileSync(p, JSON.stringify(s))
    ensureGovernanceGateCommands(TEST_AGENT, ON)
    expect(ensureGovernanceGateCommands(TEST_AGENT, ON)).toBe(false)
    expect(entries(readFileSync(p, 'utf-8'))).toHaveLength(2)
  })
})
