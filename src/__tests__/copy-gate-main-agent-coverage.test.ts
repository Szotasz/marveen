import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TELEGRAM_COPY_GATE_MATCHER } from '../web/agent-scaffold.js'

// GATECOPY906: the outgoing-copy gate is TWO measurements, and #1195 only fixed
// one of them. The hook's own dispatch decides WHETHER a payload is audited
// (the detector); the PreToolUse matcher decides whether the hook is invoked at
// all (the trigger). #1184 widened the scaffold matcher to edit_message and
// #1195 widened the detector to match -- but the MAIN agent is deliberately
// exempt from the scaffold matcher (see the comment on TELEGRAM_COPY_GATE_MATCHER:
// it "already carries the same hook in its own committed project settings"), so
// its coverage lives in .claude/settings.json alone. That file still listed
// reply only, which means the main agent's edit_message reached the phone
// unaudited while every sub-agent's was gated.
//
// This test pins the invariant that made the exemption safe in the first place:
// whatever tools the scaffold gates for sub-agents, the main agent's own
// settings must gate too. It is the drift between the two that goes unnoticed.
const REPO_ROOT = join(__dirname, '..', '..')
const GATE_SCRIPT = 'outgoing-copy-gate.py'

type HookEntry = { matcher?: string; hooks?: Array<{ command?: string }> }

function copyGateMatchers(): string[] {
  const raw = readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf-8')
  const settings = JSON.parse(raw) as { hooks?: { PreToolUse?: HookEntry[] } }
  return (settings.hooks?.PreToolUse ?? [])
    .filter((e) => (e.hooks ?? []).some((h) => (h.command ?? '').includes(GATE_SCRIPT)))
    .map((e) => e.matcher ?? '')
    .filter(Boolean)
}

describe('outgoing-copy gate: the main agent covers what the scaffold covers', () => {
  const scaffoldTools = TELEGRAM_COPY_GATE_MATCHER.split('|')

  it('the scaffold gates more than one telegram tool (guards the test itself)', () => {
    // Without this, a scaffold regression to a single tool would make the
    // assertion below pass for the wrong reason.
    expect(scaffoldTools.length).toBeGreaterThan(1)
    expect(scaffoldTools).toContain('mcp__plugin_telegram_telegram__edit_message')
  })

  it.each(TELEGRAM_COPY_GATE_MATCHER.split('|'))(
    'the committed main-agent settings invoke the gate for %s',
    (tool) => {
      const covered = copyGateMatchers().some((m) => new RegExp(m).test(tool))
      expect(covered).toBe(true)
    },
  )
})
