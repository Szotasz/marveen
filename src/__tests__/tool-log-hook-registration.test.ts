import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KNOWN_HOOK_SCRIPTS } from '../web/hook-registration-guard.js'

// tool-log-capture.py was registered ONLY in the install's own
// .claude/settings.json, i.e. for sessions whose project root is the repo
// itself. Measured 2026-08-29: every one of the 603 rows in tool_call_log
// carried agent_id='jarvis' and not a single sub-agent had ever written one,
// because an agent's project root is agents/<name>, whose settings.json did
// not reference the hook. The per-agent activity view ("which agent is working
// and how long since it last did anything") reads this table, so for 6 of 7
// agents it had no data at all.
//
// These tests pin the WIRING, not the capture logic (already unit-tested).
type Hook = { type?: string; command?: string; timeout?: number }
type HookEntry = { matcher?: string; hooks?: Hook[] }

const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
const tpl = JSON.parse(readFileSync(tplPath, 'utf-8')) as {
  hooks?: Record<string, HookEntry[]>
}

function commandsOf(event: string): string[] {
  return (tpl.hooks?.[event] ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ''))
}

describe('tool-log-capture registration', () => {
  it('the template registers the hook under PostToolUse', () => {
    // ensureAgentHooks merges the template into each agent's OWN
    // settings.json, which is what gives every agent its own rows.
    expect(commandsOf('PostToolUse').some((c) => c.includes('tool-log-capture.py'))).toBe(true)
  })

  it('uses the fail-open wrapper so a missing file never blocks the tool call', () => {
    const cmd = commandsOf('PostToolUse').find((c) => c.includes('tool-log-capture.py'))!
    // A bare `python3 <path>` exits 2 once the checkout moves, and a non-zero
    // PostToolUse hook surfaces as an error on EVERY tool call -- with matcher
    // '*' that is every tool the agent runs.
    expect(cmd).toMatch(/^bash -c '\[ -f [^']*tool-log-capture\.py \] && exec python3 /)
    expect(cmd).toMatch(/; exit 0'$/)
  })

  it('matches every tool, since the point is the call COUNT and the gap between calls', () => {
    const entry = (tpl.hooks?.PostToolUse ?? []).find((e) =>
      (e.hooks ?? []).some((h) => (h.command ?? '').includes('tool-log-capture.py')),
    )!
    expect(entry.matcher).toBe('*')
  })

  it('does not disturb the skill-usage hook that shares the PostToolUse event', () => {
    // Both live under PostToolUse with different matchers; the merge in
    // ensureAgentHooks appends rather than replaces, and a regression that
    // collapsed the two entries would silently kill skill_usage capture.
    const entries = tpl.hooks?.PostToolUse ?? []
    expect(entries.some((e) => e.matcher === 'Skill|Read')).toBe(true)
    expect(entries.filter((e) => (e.hooks ?? []).some((h) => (h.command ?? '').includes('tool-log-capture.py')))).toHaveLength(1)
  })

  it('is a known hook script, so the stale-entry pruner may clean it up', () => {
    expect(KNOWN_HOOK_SCRIPTS).toContain('tool-log-capture.py')
  })
})
