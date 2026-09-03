import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KNOWN_HOOK_SCRIPTS } from '../web/hook-registration-guard.js'

// The skill-usage-capture hook shipped fully tested (#607) but was registered
// NOWHERE: templates/settings.json.template never referenced it, so on every
// scaffolded agent the skill_usage table stayed silently empty while the
// /skill-usage dashboard and the dream-engine suggestions ran on no data.
// A hook that only exists on disk is dead code -- these tests pin the wiring,
// not the (already unit-tested) capture logic.

type Hook = { type?: string; command?: string; timeout?: number }
type HookEntry = { matcher?: string; hooks?: Hook[] }

const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
const tpl = JSON.parse(readFileSync(tplPath, 'utf-8')) as {
  hooks?: Record<string, HookEntry[]>
}

function commandsOf(event: string): string[] {
  return (tpl.hooks?.[event] ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ''))
}

describe('skill-usage-capture registration', () => {
  it('the template registers the hook under PostToolUse', () => {
    const cmds = commandsOf('PostToolUse')
    expect(cmds.some((c) => c.includes('skill-usage-capture.py'))).toBe(true)
  })

  it('uses the fail-open wrapper so a missing file never blocks the tool call', () => {
    const cmd = commandsOf('PostToolUse').find((c) => c.includes('skill-usage-capture.py'))!
    // Same shape as the other guarded hooks: file-existence test, exec on hit,
    // exit 0 otherwise. A bare `python3 <path>` would exit 2 after the checkout
    // moves and a non-zero hook surfaces as an error on every matched tool.
    expect(cmd).toMatch(/^bash -c '\[ -f [^']*skill-usage-capture\.py \] && exec python3 /)
    expect(cmd).toMatch(/; exit 0'$/)
  })

  it('matches only the tools the hook classifies (Skill calls and SKILL.md Reads)', () => {
    const entry = (tpl.hooks?.PostToolUse ?? []).find((e) =>
      (e.hooks ?? []).some((h) => (h.command ?? '').includes('skill-usage-capture.py')),
    )!
    expect(entry.matcher).toBe('Skill|Read')
  })

  it('is a known hook script, so the stale-entry pruner may clean it up', () => {
    // Without this, a stale registration (deleted checkout) would be treated as
    // FOREIGN by pruneStaleHookEntries and kept forever.
    expect(KNOWN_HOOK_SCRIPTS).toContain('skill-usage-capture.py')
  })
})
