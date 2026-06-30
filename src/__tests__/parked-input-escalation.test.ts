import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// Escalation behavior of clearStaleParkedInput (agent-process.ts), the #2 fix for
// the 2026-06-30 1h SILENT fleet-stall: a real reply ("Igen, írd meg Baloghnak a
// választ") parked in the MAIN agent's box wedged all inter-agent delivery while
// the auto-clear failed 109x behind a lone WARN. Contract:
//   - MAIN agent box: NEVER auto-cleared (Ctrl-U would destroy a real reply) ->
//     NOTIFY the operator once per stuck episode instead.
//   - sub-agent box: keep the existing Ctrl-U clear path.
//   - escalation is ONE-SHOT per stuck text (no spam).
//
// capturePane / runTmux are LOCAL to agent-process and both go through
// node:child_process execFileSync, so we mock execFileSync with arg-inspection:
// a 'capture-pane' call returns a stable parked pane; everything else (sleeps,
// send-keys) is a no-op we can inspect.

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  // A stranded, never-submitted real reply parked in the input box.
  const PARKED = ['', SEP, '❯ Igen, írd meg Baloghnak a választ', SEP, FOOTER].join('\n')
  const calls: string[][] = []
  return { PARKED, calls }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      h.calls.push(args)
      if (args.includes('capture-pane')) return h.PARKED
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { clearStaleParkedInput } from '../web/agent-process.js'
import { notifyChannel } from '../notify.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'

let clock = 1_000_000
const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
const COOLDOWN = 31_000 // > UNWEDGE_COOLDOWN_MS so each call increments `fails`

function clearKeystrokes(): string[][] {
  return h.calls.filter(a => a.includes('send-keys') && (a.includes('C-u') || a.includes('C-k')))
}

beforeEach(() => {
  h.calls.length = 0
  vi.mocked(notifyChannel).mockClear()
})
afterAll(() => { nowSpy.mockRestore() })

describe('parked-input escalation', () => {
  it('NEVER auto-clears the main agent box, and escalates exactly ONCE after K detections', () => {
    // 3 confirmed-stuck detections past the cooldown -> escalate on the 3rd.
    for (let i = 0; i < 3; i++) { clearStaleParkedInput(MAIN_CHANNELS_SESSION); clock += COOLDOWN }
    // CRITICAL contract: the main box is never touched with a clearing keystroke.
    expect(clearKeystrokes().length).toBe(0)
    expect(vi.mocked(notifyChannel)).toHaveBeenCalledTimes(1)
    // one-shot: further detections of the SAME parked text do not re-notify.
    clearStaleParkedInput(MAIN_CHANNELS_SESSION); clock += COOLDOWN
    clearStaleParkedInput(MAIN_CHANNELS_SESSION)
    expect(vi.mocked(notifyChannel)).toHaveBeenCalledTimes(1)
    expect(clearKeystrokes().length).toBe(0)
  })

  it('still attempts the Ctrl-U clear for a SUB-agent box', () => {
    clearStaleParkedInput('subagent-zara-channels')
    expect(clearKeystrokes().length).toBeGreaterThan(0)
  })
})
