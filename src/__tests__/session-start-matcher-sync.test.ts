// Two guards for the SessionStart task-state replay, both aimed at the same
// failure: the hook is registered, but not for the sources that matter.
//
//   (a) Coverage: the template's SessionStart matcher must COVER REPLAY_SOURCES.
//       Asserted as containment, not equality -- an equality assertion passes
//       today and drifts silently the next time a source is added to one side
//       only, which is exactly how the replay went dead the first time.
//
//   (b) Convergence: an install created with an older matcher must converge on
//       the template's matcher on the next scaffold run. Adding a source to the
//       template alone reaches new installs and never the running ones, so the
//       fix looks complete while the fleet stays broken.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPLAY_SOURCES } from '../web/agent-taskstate.js'
import { syncHookMatchers } from '../web/agent-scaffold.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const TEMPLATE = join(ROOT, 'templates', 'settings.json.template')

const REPLAY_HOOK = 'taskstate-replay.py'

function templateSessionStartMatcher(): string {
  // The template carries {{PLACEHOLDER}} tokens that are not valid JSON values
  // on their own; they sit inside strings, so JSON.parse handles the file fine.
  const parsed = JSON.parse(readFileSync(TEMPLATE, 'utf-8')) as {
    hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>
  }
  const entries = parsed.hooks?.SessionStart ?? []
  const entry = entries.find((e) => (e.hooks ?? []).some((h) => h.command?.includes(REPLAY_HOOK)))
  if (!entry) throw new Error(`no SessionStart entry registers ${REPLAY_HOOK} in the template`)
  return entry.matcher ?? ''
}

describe('template SessionStart matcher covers REPLAY_SOURCES', () => {
  it('registers the replay hook at all', () => {
    expect(templateSessionStartMatcher()).not.toBe('')
  })

  // Containment, deliberately not equality: the matcher may legitimately list
  // MORE sources than the replay acts on, but never fewer.
  it.each([...REPLAY_SOURCES])('matcher includes source %s', (source) => {
    const alternatives = templateSessionStartMatcher().split('|')
    expect(alternatives).toContain(source)
  })
})

describe('syncHookMatchers (existing installs converge)', () => {
  const tplEntry = {
    matcher: 'compact|resume|startup|clear',
    hooks: [{ type: 'command', command: `python3 /opt/marveen/scripts/hooks/${REPLAY_HOOK}` }],
  }

  it('widens the matcher of a group the template fully owns', () => {
    const existing = [
      { matcher: 'compact|resume', hooks: [{ type: 'command', command: tplEntry.hooks[0].command }] },
    ]
    expect(syncHookMatchers(existing, tplEntry)).toBe(true)
    expect(existing[0].matcher).toBe('compact|resume|startup|clear')
  })

  it('is idempotent once converged', () => {
    const existing = [
      {
        matcher: 'compact|resume|startup|clear',
        hooks: [{ type: 'command', command: tplEntry.hooks[0].command }],
      },
    ]
    expect(syncHookMatchers(existing, tplEntry)).toBe(false)
  })

  // The important negative: a group holding a hook we did not put there keeps
  // its own matcher. Widening it would change when that foreign hook runs.
  it('leaves a group alone when it also holds a foreign command', () => {
    const existing = [
      {
        matcher: 'compact|resume',
        hooks: [
          { type: 'command', command: tplEntry.hooks[0].command },
          { type: 'command', command: 'python3 /opt/local/notify-me.py' },
        ],
      },
    ]
    expect(syncHookMatchers(existing, tplEntry)).toBe(false)
    expect(existing[0].matcher).toBe('compact|resume')
  })

  it('ignores unrelated groups', () => {
    const existing = [
      { matcher: 'startup', hooks: [{ type: 'command', command: 'python3 /opt/other/hook.py' }] },
    ]
    expect(syncHookMatchers(existing, tplEntry)).toBe(false)
    expect(existing[0].matcher).toBe('startup')
  })
})
