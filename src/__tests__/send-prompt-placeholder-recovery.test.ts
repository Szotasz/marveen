import { describe, it, expect, vi, beforeEach } from 'vitest'

// Card 71263d15 (a1), measured on the router log (2026-09-23 -> 2026-10-11): three re-sends after a
// paste-placeholder clear died on "can't find pane", and each of those rows was then logged "Agent message
// delivered" and lost. This drives the REAL sendPromptToSession over a mocked tmux (the
// send-prompt-emit-guard.test.ts harness); the pane is a small state machine, so the measured shapes replay
// key by key: the first submit parks a placeholder, a Ctrl-C clears it or does nothing, and the pane can
// vanish in the middle of the re-send.

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  const box = (input: string) => ['  ⎿  Done', '', SEP, `❯ ${input}`, SEP, FOOTER].join('\n')
  const IDLE = box('')
  const PARKED_BOX = box('[Pasted text #1 +812 chars]')
  // An older render: the input-box separators are off-screen, so only the detector's 8-line
  // fallback tail finds the stub, and nothing proves it sits in the input box.
  const PARKED_TAIL = ['  ⎿  Done', '', '> [Pasted text #1 +812 chars]', '  paste again to expand'].join('\n')
  // The stub quoted in the conversation ABOVE an empty input box (within the last 8 lines).
  const QUOTED_ABOVE_BOX = ['  ⎿  the pane showed [Pasted text #1 +812 chars] earlier', SEP, '❯ ', SEP, FOOTER].join('\n')
  const s = {
    parkedAs: 'box' as 'box' | 'tail',
    onCtrlC: 'clear' as 'clear' | 'nothing' | 'to-tail',
    // 0 = never; n = the n-th chunk typed after the first Ctrl-C finds the pane gone
    dieAtReplayChunk: 0,
    // 0 = never; n = the n-th capture of the parked pane fails
    nullParkedCapture: 0,
    state: 'idle' as 'idle' | 'parked' | 'gone',
    enters: 0,
    ctrlC: 0,
    chunksAfterCtrlC: 0,
    parkedCaptures: 0,
    calls: [] as string[][],
  }
  return { IDLE, PARKED_BOX, PARKED_TAIL, QUOTED_ABOVE_BOX, s }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (!Array.isArray(args)) return ''
    const s = h.s
    s.calls.push(args)
    const gone = (): never => { throw new Error("Command failed: tmux\ncan't find pane: agent-placeholder-test\n") }
    if (args.includes('capture-pane')) {
      if (s.state === 'gone') gone()
      if (s.state === 'parked') {
        s.parkedCaptures++
        if (s.parkedCaptures === s.nullParkedCapture) throw new Error('capture failed')
        return s.parkedAs === 'box' ? h.PARKED_BOX : h.PARKED_TAIL
      }
      return h.IDLE
    }
    if (args.includes('display-message')) {
      if (s.state === 'gone') gone()
      return '4242 claude\n'
    }
    if (args.includes('send-keys')) {
      if (s.state === 'gone') gone()
      const key = args[args.length - 1]
      if (args.includes('-l')) {
        if (s.ctrlC > 0 && s.dieAtReplayChunk > 0 && ++s.chunksAfterCtrlC === s.dieAtReplayChunk) {
          s.state = 'gone'
          gone()
        }
        return ''
      }
      if (key === 'Enter') {
        s.enters++
        s.state = s.enters === 1 ? 'parked' : 'idle'
        return ''
      }
      if (key === 'C-c') {
        s.ctrlC++
        if (s.onCtrlC === 'clear') s.state = 'idle'
        // the press emptied the box, but the next frame shows no separators: only the tail is readable
        if (s.onCtrlC === 'to-tail') s.parkedAs = 'tail'
        return ''
      }
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { sendPromptToSession } from '../web/agent-process.js'
import { __resetSessionSendLocks } from '../web/session-send-lock.js'

const SESSION = 'agent-placeholder-test'
// Longer than one 80-char chunk, so the re-send is a stream and can die in the middle of it.
const LONG = '[a message from another agent, routed by the queue]: ' + 'a long body that the pane receives in several chunks '.repeat(4)

function scenario(over: Partial<typeof h.s>): void {
  Object.assign(h.s, {
    parkedAs: 'box', onCtrlC: 'clear', dieAtReplayChunk: 0, nullParkedCapture: 0,
    state: 'idle', enters: 0, ctrlC: 0, chunksAfterCtrlC: 0, parkedCaptures: 0,
  }, over)
  h.s.calls.length = 0
}

beforeEach(() => {
  __resetSessionSendLocks()
  vi.restoreAllMocks()
})

describe('clear-and-resend over a pane that dies (71263d15 a1)', () => {
  it('⛔ measured shape 1 (2026-10-06): the clear fails, the pane vanishes in the middle of the re-send -> the send throws, it is not "sent"', async () => {
    scenario({ onCtrlC: 'nothing', dieAtReplayChunk: 2 })
    await expect(sendPromptToSession(SESSION, LONG, null, { waitForIdle: false })).rejects.toThrow(/can't find pane/)
    expect(h.s.ctrlC).toBe(3)
  }, 20_000)

  it('⛔ measured shape 2 (2026-10-07): the clear fails, the pane is gone at the first re-sent chunk -> the send throws', async () => {
    scenario({ onCtrlC: 'nothing', dieAtReplayChunk: 1 })
    await expect(sendPromptToSession(SESSION, LONG, null, { waitForIdle: false })).rejects.toThrow(/can't find pane/)
  }, 20_000)
})
