import { describe, it, expect, vi, beforeEach } from 'vitest'

// Card a20f5430 (the 71263d15 send fix layered on the upstream #2016 background-agent block): the
// clear-and-resend decides on WHERE the paste stub sits (pastePlaceholderLocation, 71263d15 a3), and
// it finds the input box by the two U+2500 separators counted from the BOTTOM of the pane. Since
// #2016 a running background (sub-)agent renders a block BELOW the idle footer (blank row, `  ⏺ main`,
// one `  ◯ ...` row per agent), so the box is no longer at the bottom of the capture. The block
// carries no separator, so the box must still be found: a parked stub in the box is still cleared
// with one Ctrl-C and re-sent, a stub only in the conversation is still left alone. Same harness as
// send-prompt-placeholder-recovery.test.ts: the REAL sendPromptToSession over a mocked tmux.

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  const BG = ['', '  ⏺ main', '  ◯ general-purpose  Explore the repo 1m 5s · ↓ 2.3k tokens', '  ◯ Explore  Find the callers 12s · ↓ 800 tokens']
  const BG_LONG = ['', '  ⏺ main', ...Array.from({ length: 6 }, (_, i) => `  ◯ general-purpose  Task ${i + 1} ${i + 2}m 0s · ↓ 1.${i}k tokens`)]
  const box = (input: string, bg: string[]) => ['  ⎿  Done', '', SEP, `❯ ${input}`, SEP, FOOTER, ...bg].join('\n')
  const IDLE_BG = box('', BG)
  const PARKED_BOX_BG = box('[Pasted text #1 +812 chars]', BG)
  const PARKED_BOX_BG_LONG = box('[Pasted text #1 +812 chars]', BG_LONG)
  // The stub quoted in the conversation above an EMPTY input box, with the background block below.
  const QUOTED_ABOVE_BOX_BG = ['  ⎿  the pane showed [Pasted text #1 +812 chars] earlier', SEP, '❯ ', SEP, FOOTER, ...BG].join('\n')
  const s = {
    parked: 'box' as 'box' | 'box-long' | 'quoted',
    state: 'idle' as 'idle' | 'parked',
    enters: 0,
    ctrlC: 0,
    calls: [] as string[][],
  }
  return { IDLE_BG, PARKED_BOX_BG, PARKED_BOX_BG_LONG, QUOTED_ABOVE_BOX_BG, s }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (!Array.isArray(args)) return ''
    const s = h.s
    s.calls.push(args)
    if (args.includes('capture-pane')) {
      if (s.state === 'parked') {
        return s.parked === 'box' ? h.PARKED_BOX_BG : s.parked === 'box-long' ? h.PARKED_BOX_BG_LONG : h.QUOTED_ABOVE_BOX_BG
      }
      return h.IDLE_BG
    }
    if (args.includes('display-message')) return '4242 claude\n'
    if (args.includes('send-keys')) {
      const key = args[args.length - 1]
      if (args.includes('-l')) return ''
      if (key === 'Enter') {
        s.enters++
        s.state = s.enters === 1 ? 'parked' : 'idle'
        return ''
      }
      if (key === 'C-c') {
        s.ctrlC++
        s.state = 'idle'
        return ''
      }
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { sendPromptToSession } from '../web/agent-process.js'
import { __resetSessionSendLocks } from '../web/session-send-lock.js'
import { detectBackgroundAgents, pastePlaceholderLocation } from '../pane-state.js'
import { logger } from '../logger.js'

const SESSION = 'agent-placeholder-bg-test'
const SHORT = '[a short message]: one chunk'
const typed = (text: string) => h.s.calls.filter((a) => a.includes('send-keys') && a.includes('-l')).map((a) => a[a.length - 1]).join('').split(text.slice(0, 40)).length - 1

function scenario(over: Partial<typeof h.s>): void {
  Object.assign(h.s, { parked: 'box', state: 'idle', enters: 0, ctrlC: 0 }, over)
  h.s.calls.length = 0
}

beforeEach(() => {
  __resetSessionSendLocks()
  vi.restoreAllMocks()
})

describe('pastePlaceholderLocation under a background-agent block (a20f5430: 71263d15 on #2016)', () => {
  it('control: the fixtures carry the measured #2016 block, so the box is not the bottom of the pane', () => {
    expect(detectBackgroundAgents(h.PARKED_BOX_BG)).toEqual({ total: 2, running: 2, queued: 0 })
    expect(detectBackgroundAgents(h.PARKED_BOX_BG_LONG)).toEqual({ total: 6, running: 6, queued: 0 })
    expect(h.PARKED_BOX_BG.split('\n').slice(-1)[0]).toMatch(/◯/)
  })

  it('a stub parked in the input box above the block is in the box', () => {
    expect(pastePlaceholderLocation(h.PARKED_BOX_BG)).toBe('box')
  })

  it('a long block (six agents, the box out of the last eight lines) still finds the box, not the fallback tail', () => {
    expect(h.PARKED_BOX_BG_LONG.split('\n').slice(-8).join('\n')).not.toContain('[Pasted text')
    expect(pastePlaceholderLocation(h.PARKED_BOX_BG_LONG)).toBe('box')
  })

  it('an empty box above the block is nowhere, and a stub quoted above that empty box is nowhere too', () => {
    expect(pastePlaceholderLocation(h.IDLE_BG)).toBeNull()
    expect(pastePlaceholderLocation(h.QUOTED_ABOVE_BOX_BG)).toBeNull()
  })
})

describe('clear-and-resend with a background-agent block on screen (a20f5430)', () => {
  it('a stub in the box above the block is cleared with one Ctrl-C and the payload is re-sent', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    scenario({ parked: 'box' })
    await expect(sendPromptToSession(SESSION, SHORT, null, { waitForIdle: false })).resolves.toBe('sent')
    expect(h.s.ctrlC).toBe(1)
    expect(typed(SHORT)).toBe(2)
  }, 20_000)

  it('the same with a long block: one Ctrl-C, re-sent', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    scenario({ parked: 'box-long' })
    await expect(sendPromptToSession(SESSION, SHORT, null, { waitForIdle: false })).resolves.toBe('sent')
    expect(h.s.ctrlC).toBe(1)
    expect(typed(SHORT)).toBe(2)
  }, 20_000)

  it('⛔ a stub only quoted above an empty box: no Ctrl-C and no re-send (a Ctrl-C on an empty box quits the TUI)', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    scenario({ parked: 'quoted' })
    await expect(sendPromptToSession(SESSION, SHORT, null, { waitForIdle: false })).resolves.toBe('sent')
    expect(h.s.ctrlC).toBe(0)
    expect(typed(SHORT)).toBe(1)
  }, 20_000)
})
