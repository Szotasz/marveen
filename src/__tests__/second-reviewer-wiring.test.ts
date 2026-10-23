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
})
