import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'
import { agentGetsBashEgressParser, injectBashEgressParser } from '../web/agent-scaffold.js'

// MAINBASHEGRESS1116: the Bash egress parser shipped fully tested and wired for
// 23 of 24 agents. The one it did not reach was the main agent -- the one agent
// that reads untrusted web content on the owner's behalf. Measured 2026-11-16
// on this install: 13 curl requests from the main session to a host that is on
// no allowlist all returned HTTP 200, because on the Bash route there was no
// egress control at all to be wrong (kanban ab72dbea).
//
// The gap was not a bug in the parser and not a missing registration either.
// agentGetsBashEgressParser() returns false for the main agent BY DESIGN, and
// hook-registration-completeness stays green because the scaffold registers the
// script for sub-agents. Nothing measured the main agent's own surface, so
// "exempt from the scaffold" and "not gated anywhere" looked identical.
//
// This test is the discriminator. It pins the two surfaces together: whatever
// the scaffold injects for a sub-agent, the main agent's own committed project
// settings must invoke too. Same invariant, and for the same reason, as
// copy-gate-main-agent-coverage.test.ts.
const REPO_ROOT = join(__dirname, '..', '..')
const GATE_SCRIPT = 'bash-egress-parser.mjs'
const FAIL_CLOSED_TAG = 'governance-kapu (fail-closed)'

type HookEntry = { matcher?: string; hooks?: Array<{ command?: string }> }

function projectPreToolUse(): HookEntry[] {
  const raw = readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf-8')
  return (JSON.parse(raw) as { hooks?: { PreToolUse?: HookEntry[] } }).hooks?.PreToolUse ?? []
}

function parserEntries(): HookEntry[] {
  return projectPreToolUse().filter((e) => (e.hooks ?? []).some((h) => (h.command ?? '').includes(GATE_SCRIPT)))
}

describe('Bash egress parser: the main agent is exempt from the scaffold, not from the gate', () => {
  it('the scaffold still exempts the main agent and still covers sub-agents (guards the test itself)', () => {
    // Without this the assertions below could pass because the scaffold started
    // covering the main agent too, i.e. for a different reason than they claim.
    expect(agentGetsBashEgressParser(MAIN_AGENT_ID)).toBe(false)
    expect(agentGetsBashEgressParser('social')).toBe(true)
  })

  it('the committed main-agent settings invoke the parser exactly once', () => {
    // Exactly once, not at least once: the scaffold dedupes by script basename,
    // and this file is hand-maintained, so a second copy would double-fire the
    // gate the way the derived isolated-dir copies did (#1305).
    expect(parserEntries()).toHaveLength(1)
  })

  it('it runs on the Bash matcher, the same matcher the scaffold uses', () => {
    const scaffolded: Record<string, unknown> = {}
    injectBashEgressParser(scaffolded)
    const expected = (((scaffolded.hooks as Record<string, unknown>).PreToolUse) as HookEntry[])[0].matcher
    expect(expected).toBe('Bash')
    expect(parserEntries().map((e) => e.matcher)).toEqual([expected])
  })

  it('it is fail-closed, like every other security gate on this surface', () => {
    // A gate that exits non-zero on a load error and is NOT wrapped is silently
    // non-enforcing: the call goes through. hook-fail-closed.test.ts runs the
    // command for real; this only asserts the wrapper is present at all.
    const command = parserEntries()[0].hooks?.[0]?.command ?? ''
    expect(command).toContain(FAIL_CLOSED_TAG)
    expect(command.endsWith('exit "$rc"')).toBe(true)
  })

  it('the path is checkout-relative, so the entry survives a move of the install', () => {
    // An absolute path baked into a committed file points at whichever checkout
    // wrote it; HOSTMOVE923 is the same defect on the CLAUDE.md anchors.
    const command = parserEntries()[0].hooks?.[0]?.command ?? ''
    expect(command).toContain(`$CLAUDE_PROJECT_DIR/scripts/hooks/${GATE_SCRIPT}`)
  })

  it('the WebFetch egress gate is still separately wired (the two routes are two hooks)', () => {
    // The parser closes the Bash route; egress-gate.mjs closes WebFetch. Reusing
    // one for both was the misreading this card started from, so pin both.
    const webfetch = projectPreToolUse().filter((e) =>
      (e.hooks ?? []).some((h) => (h.command ?? '').includes('egress-gate.mjs')))
    expect(webfetch.map((e) => e.matcher)).toEqual(['WebFetch'])
  })
})
