// The main agent coming up on the SHARED ~/.claude must be said out loud --
// from every launch path, not just the one that happens to run in daylight.
//
// WHY THIS FILE EXISTS (kanban card `guard-respawn-vak`). scripts/channels.sh
// has carried a loud regression guard since 2026-07: two triggers, both meaning
// "this boot resolved to the shared root, so the main bot rides a rotating
// credential and can 401 into a silent channel". But channels.sh is only ONE of
// the ways the main session starts. The nightly 03:00 respawn, the stage-3
// recovery resume and the hard restart all go through tmux respawn-pane and
// never touch channels.sh -- so the guard could not fire on any of them.
//
// The cost was measured, not imagined: on 2026-08-04 the main agent came up on
// the shared root at 03:00 and the outage ran until 07:58. Nothing was broken
// except the reporting. The store/channels-failures.log had no line for that
// morning, and the absence looked exactly like health.
//
// THIS FILE MEASURES THE DECISION ONLY, AND SAYS SO. A green decision test is
// not evidence that anybody calls it -- that lesson cost a full round on the
// router fix the same week (four mutations red on the predicate, a fifth that
// deleted the CALL and left all seven assertions green). The wiring assertions
// live with the call sites; what is pinned here is that the decision itself is
// right, and in particular that it stays SILENT on a stock install.

import { describe, it, expect } from 'vitest'
import { mainSharedConfigTrigger } from '../web/agent-process.js'

/** The three facts the decision reads, with the quiet default install as base. */
const stock = { isolatedConfigDir: null, fleetToken: false, isolatedDirExists: false }

describe('the guard stays silent where silence is correct', () => {
  it('says nothing on a stock install: no isolation, no token, no dir', () => {
    // The common case by a wide margin. A guard that speaks here is noise on
    // every install that never asked for isolation, and noise is how a real
    // warning stops being read.
    expect(mainSharedConfigTrigger(stock)).toBeNull()
  })

  it('says nothing while isolation is actually working', () => {
    // The resolved dir is the whole point of the guard; having it means the
    // thing we are afraid of did not happen.
    expect(mainSharedConfigTrigger({
      isolatedConfigDir: '/srv/marveen/.channels-config',
      fleetToken: true,
      isolatedDirExists: true,
    })).toBeNull()
  })
})

describe('the two triggers, and which one wins when both could apply', () => {
  it('a fleet token with no isolation is a MISSING SETTING, not a declined one', () => {
    // Issue #835's shape: the token is the thing isolation is gated on, so an
    // install that carries one and still lands on the shared root is
    // misconfigured rather than deliberately plain.
    expect(mainSharedConfigTrigger({ ...stock, fleetToken: true })).toBe('fleet-token-unused')
  })

  it('an existing .channels-config dir means isolation worked here once and was LOST', () => {
    // No token required: the dir on disk is the evidence. channels.sh trigger 2
    // fires on the same condition, deliberately, for the same reason.
    expect(mainSharedConfigTrigger({ ...stock, isolatedDirExists: true })).toBe('isolation-lost')
  })

  it('PRECEDENCE: the dir on disk wins over the token, because it points at the right fix', () => {
    // Both conditions hold on an install that lost its setting but kept its
    // token -- the likeliest real failure. Reporting that as a fresh install
    // would send the operator to "turn isolation on" when the truth is "your
    // setting disappeared", which is a different investigation.
    expect(mainSharedConfigTrigger({
      isolatedConfigDir: null, fleetToken: true, isolatedDirExists: true,
    })).toBe('isolation-lost')
  })
})

describe('POSITIVE CONTROL', () => {
  it('not every input is null -- an always-silent stub cannot pass this file', () => {
    // Without this, a decision that returned null for everything would satisfy
    // both silence tests above and look like a working guard.
    const speaks = [
      mainSharedConfigTrigger({ ...stock, fleetToken: true }),
      mainSharedConfigTrigger({ ...stock, isolatedDirExists: true }),
    ].filter((t) => t !== null)
    expect(speaks).toHaveLength(2)
  })
})
