import { describe, it, expect, vi, beforeEach } from 'vitest'

// Card 71263d15 (a1)-(a3), measured on the router log (2026-09-23 -> 2026-10-11): 69 paste
// placeholders were cleared and re-sent, 18 of the clears "failed", and three re-sends died on
// "can't find pane" -- yet each of those three rows was logged "Agent message delivered" and lost.
// In every measured case the three Ctrl-C presses ran on a LIVE pane and the pane died right after
// them. This drives the REAL sendPromptToSession over a mocked tmux (the
// send-prompt-emit-guard.test.ts harness); the pane is a small state machine, so the measured
// shapes replay key by key: the first submit parks a placeholder, a Ctrl-C clears it or does
// nothing, and the pane can vanish in the middle of the re-send.

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
    onCtrlC: 'clear' as 'clear' | 'nothing' | 'to-tail' | 'die',
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
        // the TUI quits on this press and the pane goes with it (no remain-on-exit)
        if (s.onCtrlC === 'die') s.state = 'gone'
        return ''
      }
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { sendPromptToSession } from '../web/agent-process.js'
import { __resetSessionSendLocks } from '../web/session-send-lock.js'
import { detectsPastePlaceholder, pastePlaceholderLocation } from '../pane-state.js'
import { logger } from '../logger.js'

const SESSION = 'agent-placeholder-test'
// Longer than one 80-char chunk, so the re-send is a stream and can die in the middle of it.
const LONG = '[a message from another agent, routed by the queue]: ' + 'a long body that the pane receives in several chunks '.repeat(4)
const SHORT = '[a short message]: one chunk'
const typed = (text: string) => h.s.calls.filter((a) => a.includes('send-keys') && a.includes('-l')).map((a) => a[a.length - 1]).join('').split(text.slice(0, 40)).length - 1
const logged = (spy: { mock: { calls: unknown[][] } }, msg: string) => spy.mock.calls.filter((c) => c[1] === msg).map((c) => c[0] as Record<string, unknown>)

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

describe('pastePlaceholderLocation (71263d15 a3): where the detector found the stub', () => {
  it('the input box, the fallback tail, or nowhere', () => {
    expect(pastePlaceholderLocation(h.PARKED_BOX)).toBe('box')
    expect(pastePlaceholderLocation(h.PARKED_TAIL)).toBe('tail')
    expect(pastePlaceholderLocation(h.IDLE)).toBeNull()
    expect(pastePlaceholderLocation('')).toBeNull()
  })

  it('a stub quoted above an empty box is nowhere: when the box is on screen, the box decides', () => {
    expect(pastePlaceholderLocation(h.QUOTED_ABOVE_BOX)).toBeNull()
  })

  it('control: detectsPastePlaceholder is unchanged, it still sees both places', () => {
    expect(detectsPastePlaceholder(h.PARKED_BOX)).toBe(true)
    expect(detectsPastePlaceholder(h.PARKED_TAIL)).toBe(true)
    expect(detectsPastePlaceholder(h.IDLE)).toBe(false)
    expect(detectsPastePlaceholder(h.QUOTED_ABOVE_BOX)).toBe(false)
  })
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

  it('measured shape 3 (2026-10-11): the clear fails, the re-send lands on a live pane -> sent, and the log keeps where each Ctrl-C went and the pane process around them (a2)', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    scenario({ onCtrlC: 'nothing' })
    await expect(sendPromptToSession(SESSION, LONG, null, { waitForIdle: false })).resolves.toBe('sent')
    const presses = logged(info, 'discardPlaceholderBuffer: Ctrl-C on a placeholder in the input box')
    expect(presses.map((p) => [p.press, p.where])).toEqual([[1, 'box'], [2, 'box'], [3, 'box']])
    const after = logged(info, 'discardPlaceholderBuffer: pane process after Ctrl-C')
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ presses: 3, paneProcessBefore: '4242 claude', paneProcessAfter: '4242 claude' })
  }, 20_000)

  it('⛔ the pane dies at the first Ctrl-C: no blind second press, the send throws, and the log keeps the vanished process and the last screen (a2)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    scenario({ onCtrlC: 'die' })
    await expect(sendPromptToSession(SESSION, LONG, null, { waitForIdle: false })).rejects.toThrow(/can't find pane/)
    expect(h.s.calls.filter((a) => a[a.length - 1] === 'C-c')).toHaveLength(1)
    const after = logged(warn, 'discardPlaceholderBuffer: pane process after Ctrl-C')
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ presses: 1, paneProcessBefore: '4242 claude', paneProcessAfter: null })
    expect(String(after[0].lastScreen)).toContain('[Pasted text #1')
  }, 20_000)

  it('the log of a re-send that dies carries the last screen the clear saw (a2)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    scenario({ onCtrlC: 'nothing', dieAtReplayChunk: 1 })
    await expect(sendPromptToSession(SESSION, LONG, null, { waitForIdle: false })).rejects.toThrow()
    const failed = logged(warn, 'Clear-and-resend chunk replay failed')
    expect(failed).toHaveLength(1)
    expect(String(failed[0].lastScreen)).toContain('[Pasted text #1')
  }, 20_000)
})

describe('Ctrl-C only on a placeholder confirmed in the input box (71263d15 a3)', () => {
  it('⛔ a stub found only in the fallback tail: no Ctrl-C and no re-send (a Ctrl-C on an empty box quits the TUI)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    scenario({ parkedAs: 'tail', onCtrlC: 'nothing' })
    await expect(sendPromptToSession(SESSION, SHORT, null, { waitForIdle: false })).resolves.toBe('sent')
    expect(h.s.ctrlC).toBe(0)
    expect(typed(SHORT)).toBe(1)
    expect(logged(warn, 'discardPlaceholderBuffer: placeholder only in the fallback tail, not in the input box; no Ctrl-C')).toHaveLength(1)
  }, 20_000)

  it('⛔ an unreadable pane at the clear: no blind Ctrl-C', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    // capture 1 of the parked pane is the follow-up decision, capture 2 is the clear's first look
    scenario({ nullParkedCapture: 2 })
    await expect(sendPromptToSession(SESSION, SHORT, null, { waitForIdle: false })).resolves.toBe('sent')
    expect(h.s.ctrlC).toBe(0)
  }, 20_000)

  it('⛔ a box cleared by one Ctrl-C whose next frame shows only the tail: no second press, and the payload is re-sent (never left cleared)', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    scenario({ onCtrlC: 'to-tail' })
    await expect(sendPromptToSession(SESSION, SHORT, null, { waitForIdle: false })).resolves.toBe('sent')
    expect(h.s.ctrlC).toBe(1)
    expect(typed(SHORT)).toBe(2)
  }, 20_000)

  it('control: a placeholder in the input box is cleared with one Ctrl-C and re-sent, as before', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    scenario({ onCtrlC: 'clear' })
    await expect(sendPromptToSession(SESSION, SHORT, null, { waitForIdle: false })).resolves.toBe('sent')
    expect(h.s.ctrlC).toBe(1)
    expect(typed(SHORT)).toBe(2)
  }, 20_000)
})
