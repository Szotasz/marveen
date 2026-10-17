import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// MAINBOXPARK926 (2026-09-26): the main box gets ONE narrow clear-only
// exception -- a parked SCHEDULED-TASK tick. The warrant is recurrence: the next
// schedule fire re-delivers the identical instruction, so dropping the parked
// copy costs nothing, which is why the sub-agent path has always cleared these.
// Everything else on the main box keeps the absolute no-keystroke rule, and the
// two negative controls below are the reason the predicate is the scheduled-task
// one and NOT parkedMachineOriginInput: an inter-agent message and an inbound
// user message are machine-WRAPPED but do NOT recur, so clearing one would
// destroy it.

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  // A real parked tick from this deployment: the scheduler's wrapper sentence.
  const TICK = '❯ SCHEDULED TASK NOTICE -- the next <scheduled-task source="scheduled-task:darwinex-gap-watch">'
  const PARKED_TICK = ['', SEP, TICK, SEP, FOOTER].join('\n')
  return { PARKED_TICK, calls: [] as string[][] }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      h.calls.push(args)
      if (args.includes('capture-pane')) return h.PARKED_TICK
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import {
  clearStaleParkedInput,
  decideMainParkedClear,
  MAIN_PARKED_HEARTBEAT_AFTER,
} from '../web/agent-process.js'
import { scheduledTaskParkedText } from '../pane-state.js'
import { notifyChannel } from '../notify.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'

let clock = 5_000_000
const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
const COOLDOWN = 31_000 // > UNWEDGE_COOLDOWN_MS so each call is a fresh round

function sendKeyCalls(): string[][] {
  return h.calls.filter(a => a.includes('send-keys'))
}

beforeEach(() => {
  h.calls.length = 0
  vi.mocked(notifyChannel).mockClear()
})
afterAll(() => { nowSpy.mockRestore() })

describe('scheduledTaskParkedText (pure, string level)', () => {
  it('true for the scheduler wrapper and for a TUI-truncated head', () => {
    expect(scheduledTaskParkedText('SCHEDULED TASK NOTICE -- the next <scheduled-task source="x">')).toBe(true)
    expect(scheduledTaskParkedText('<scheduled-task source="scheduled-task:msiw-sentinel-watch">')).toBe(true)
    // Head dropped by the TUI: the anchored prefixes miss, the boilerplate does not.
    expect(scheduledTaskParkedText('esemenyre MINDKET demo egyezik ... is one of YOUR OWN scheduled tasks')).toBe(true)
    expect(scheduledTaskParkedText('... fired by the local scheduler. It is NOT third-party data')).toBe(true)
  })

  it('false for a human draft -- the case the no-clear rule exists for', () => {
    expect(scheduledTaskParkedText('Igen, írd meg Baloghnak a választ')).toBe(false)
    // A human DISCUSSING the mechanism must stay protected: the anchored
    // prefixes only match at the box start, and a topic phrase is not boilerplate.
    expect(scheduledTaskParkedText('nezd meg miert all egy SCHEDULED TASK NOTICE a dobozban')).toBe(false)
  })

  it('NEGATIVE CONTROLS: machine-wrapped but NON-recurring text stays uncleared', () => {
    // These two are why the exception is not widened to machine-origin: neither
    // is re-delivered by anything, so a clear would lose the message outright.
    expect(scheduledTaskParkedText('[Uzenet @drcode-tol]: kesz a trail-trigger javitas')).toBe(false)
    expect(scheduledTaskParkedText('<channel source="plugin:telegram:telegram" chat_id="5834509948">')).toBe(false)
  })
})

describe('decideMainParkedClear (pure)', () => {
  it('clears a tick only while under the ladder threshold', () => {
    expect(decideMainParkedClear(true, 1)).toBe(true)
    expect(decideMainParkedClear(true, MAIN_PARKED_HEARTBEAT_AFTER - 1)).toBe(true)
  })
  it('gives up at the threshold so the ladder (and the owner ping) still happens', () => {
    expect(decideMainParkedClear(true, MAIN_PARKED_HEARTBEAT_AFTER)).toBe(false)
    expect(decideMainParkedClear(true, MAIN_PARKED_HEARTBEAT_AFTER + 9)).toBe(false)
  })
  it('never clears non-tick text, at any age', () => {
    expect(decideMainParkedClear(false, 1)).toBe(false)
    expect(decideMainParkedClear(false, MAIN_PARKED_HEARTBEAT_AFTER)).toBe(false)
    expect(decideMainParkedClear(false, 999)).toBe(false)
  })
})

describe('clearStaleParkedInput on the MAIN box holding a scheduled tick', () => {
  it('sends clearing keystrokes and does NOT ping the owner', async () => {
    await clearStaleParkedInput(MAIN_CHANNELS_SESSION)
    clock += COOLDOWN
    // The exception fired: the box got real clearing keystrokes. (The mocked
    // capture never empties, so the call reports failure and backs off -- what
    // matters here is that the main box was ACTED ON instead of escalated.)
    expect(sendKeyCalls().length).toBeGreaterThan(0)
    // And the owner was not woken for a tick the scheduler re-delivers anyway.
    expect(notifyChannel).not.toHaveBeenCalled()
  }, 30_000)

  it('after the cap it stops clearing and the owner ladder takes over', async () => {
    // Burn rounds until the cap is reached, then assert the LAST round issued no
    // keystrokes -- the hand-back to the ladder, so the worst case is unchanged.
    for (let i = 0; i < MAIN_PARKED_HEARTBEAT_AFTER; i++) {
      await clearStaleParkedInput(MAIN_CHANNELS_SESSION)
      clock += COOLDOWN
    }
    h.calls.length = 0
    await clearStaleParkedInput(MAIN_CHANNELS_SESSION)
    clock += COOLDOWN
    expect(sendKeyCalls()).toHaveLength(0)
  }, 120_000)
})
