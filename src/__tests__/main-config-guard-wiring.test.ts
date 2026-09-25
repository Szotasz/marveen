// A guard that decides correctly and is never called is indistinguishable, from
// the outside, from no guard at all.
//
// THIS IS THE OTHER AXIS (kanban card `guard-respawn-vak`). Its sibling file
// main-shared-config-guard.test.ts pins the DECISION -- which of the two
// shared-root regressions a given state is. Everything there stays green if the
// decision is never consulted. That is not a hypothetical: on 2026-09-04 the
// router fix had four mutations red on its predicate and a fifth, which deleted
// the CALL, green on all seven assertions.
//
// So this file measures two things the decision test cannot see:
//   1. that resolving actually WRITES -- on the healthy launch too, because a
//      guard that only speaks when unhappy has an ambiguous silence, and that
//      ambiguity is precisely what hid the 2026-08-04 outage for four hours;
//   2. that no production module builds a decision through the reporting-free
//      test factory.
//
// WHY (2) IS NOT A LIST OF CALL SITES. The obvious version of this assertion
// enumerates the known callers and checks each one. That list is itself a thing
// somebody has to remember to update -- the same shape as the bug the card is
// about. Instead the assertion forbids ONE TOKEN in production modules, so it
// holds for callers that do not exist yet.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let ROOT = ''
const sent: Array<[string, string, string]> = []

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'boss',
  get PROJECT_ROOT() { return ROOT },
}))
vi.mock('../db.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createAgentMessage: (from: string, to: string, content: string) => { sent.push([from, to, content]); return 1 },
}))

/** State the resolver reads. Only the two lookups are faked -- the verdict
 *  itself runs for real, so a wrong decision still fails here. */
let fakeState = { isolatedConfigDir: null as string | null, fleetToken: false, isolatedDirExists: false }
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureMainAgentIsolatedConfigDir: () => fakeState.isolatedConfigDir,
  readMainSharedConfigState: (dir: string | null) => ({ ...fakeState, isolatedConfigDir: dir }),
}))

const { resolveMainConfigDecision } = await import('../web/main-config-decision.js')

function log(): string {
  const p = join(ROOT, 'store', 'channels-failures.log')
  return existsSync(p) ? readFileSync(p, 'utf-8') : ''
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mcguard-'))
  require('node:fs').mkdirSync(join(ROOT, 'store'), { recursive: true })
  sent.length = 0
  fakeState = { isolatedConfigDir: null, fleetToken: false, isolatedDirExists: false }
})
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('THE HEALTHY LAUNCH LEAVES A TRACE TOO', () => {
  it('records the isolated dir when isolation is working', () => {
    // Without this line the guard's silence would mean either "all well" or
    // "never ran", and on 2026-08-04 it meant the second while looking like the
    // first for four hours.
    fakeState = { isolatedConfigDir: '/srv/m/.channels-config', fleetToken: true, isolatedDirExists: true }
    const d = resolveMainConfigDecision()
    expect(d.trigger).toBeNull()
    expect(log()).toContain('isolated CLAUDE_CONFIG_DIR=/srv/m/.channels-config')
    expect(sent).toHaveLength(0)
  })

  it('records the stock install too, and stays quiet in the inbox', () => {
    const d = resolveMainConfigDecision()
    expect(d.trigger).toBeNull()
    expect(log()).toContain('shared ~/.claude')
    expect(sent).toHaveLength(0)
  })
})

describe('THE REGRESSION LAUNCH BOTH LOGS AND TELLS SOMEBODY', () => {
  it('warns in the log AND messages the main agent when isolation was lost', () => {
    fakeState = { isolatedConfigDir: null, fleetToken: true, isolatedDirExists: true }
    const d = resolveMainConfigDecision()
    expect(d.trigger).toBe('isolation-lost')
    expect(log()).toContain('WARN isolation-lost')
    expect(sent).toHaveLength(1)
    expect(sent[0][0]).toBe('respawn-guard')
    expect(sent[0][1]).toBe('boss')
    expect(sent[0][2]).toContain('[GUARD]')
  })

  it('warns for an unused fleet token as well', () => {
    fakeState = { isolatedConfigDir: null, fleetToken: true, isolatedDirExists: false }
    expect(resolveMainConfigDecision().trigger).toBe('fleet-token-unused')
    expect(sent).toHaveLength(1)
  })

  it('a second respawn inside the cooldown still LOGS but does not message again', () => {
    // The hard restart can fire repeatedly on a wedged session. One notice per
    // attempt would bury the first -- the shape of the 2026-08-10 handoff chain.
    // The log line is not suppressed: it costs nothing and it is the series.
    fakeState = { isolatedConfigDir: null, fleetToken: true, isolatedDirExists: true }
    resolveMainConfigDecision()
    resolveMainConfigDecision()
    expect(sent).toHaveLength(1)
    expect(log().match(/WARN isolation-lost/g) ?? []).toHaveLength(2)
    expect(log()).toContain('notice suppressed')
  })
})

describe('NO PRODUCTION MODULE MAY BUILD A DECISION WITHOUT REPORTING IT', () => {
  it('the reporting-free factory appears in no src/web module but its own', () => {
    // Not a list of call sites -- a forbidden token. It therefore holds for
    // callers nobody has written yet, which a list never does.
    const dir = join(__dirname, '..', 'web')
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'main-config-decision.ts')
      .filter((f) => readFileSync(join(dir, f), 'utf-8').includes('mainConfigDecisionForTest'))
    expect(offenders).toEqual([])
  })

  it('no src/web module casts its way around the brand either', () => {
    // The brand makes forgetting impossible, not bypassing. A cast is the one
    // remaining way through.
    //
    // This walks the directory for the same reason (2) does. It used to name
    // channel-monitor.ts alone -- true today, because the type has exactly two
    // mentions, but the FIRST new caller falls outside a one-file check, and a
    // hand-maintained list of places to look is the very shape this file rejects
    // two paragraphs above its own assertion.
    const dir = join(__dirname, '..', 'web')
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'main-config-decision.ts')
      .filter((f) => readFileSync(join(dir, f), 'utf-8').includes('as MainConfigDecision'))
    expect(offenders).toEqual([])
  })

  it('POSITIVE CONTROL: BOTH forbidden tokens are findable in CODE where they legitimately live', () => {
    // Without this, a typo in either token would make the bans above pass while
    // searching for a string that occurs nowhere at all. Both are covered: the
    // factory ban and the cast ban fail silently in exactly the same way, and
    // covering only one of them leaves the other's typo undetectable.
    //
    // COMMENTS ARE STRIPPED FIRST, and that is the whole point of this version.
    // Measured while writing it: renaming BOTH real casts still left the control
    // green, because the module's own header PROSE spells the token out. A
    // positive control satisfied by a sentence about the code is not a control --
    // it is the same false green it exists to prevent.
    const raw = readFileSync(join(__dirname, '..', 'web', 'main-config-decision.ts'), 'utf-8')
    const code = raw
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(code).toContain('mainConfigDecisionForTest')
    expect(code).toContain('as MainConfigDecision')
  })
})
