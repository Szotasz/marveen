import { describe, it, expect, vi, beforeEach } from 'vitest'

// ECHOPACE1010: sendPromptToSession waits for each chunk's echo in the input
// box before writing the next one.
//
// Measured on the live fleet (transcripts): from 2026-10-09 on, 50 of 132
// scheduled prompts arrived damaged; in the month before, 3 of 13981. Every one
// broke at character 80 -- the first chunk boundary. The next ~12 chunks came
// back wrapped in <pasted_content> (paste-wrapped) or were missing entirely
// (spliced), e.g. "... </scheduled-" + "file path is REJECTED ...", which an
// agent then read as a rejection and skipped its round. The pane read those
// chunks as ONE burst after a stall, and the TUI's paste detector took it.
//
// The harness below models exactly that property: send-keys only queues bytes
// in a fake PTY, and the "TUI" drains the WHOLE queue as one read whenever the
// pane is looked at. A sender that does not look between chunks therefore
// produces one large read; a paced sender cannot produce a read larger than
// one chunk.

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  const state = {
    pty: [] as string[],
    buffer: '',
    reads: [] as number[],
    submitted: [] as string[],
    noBox: false,
    calls: [] as string[][],
  }
  function drain(): void {
    if (state.pty.length === 0) return
    const read = state.pty.join('')
    state.pty.length = 0
    state.reads.push(read.length)
    state.buffer += read
  }
  // The TUI re-wraps long input mid-word at 76 columns.
  function render(): string {
    if (state.noBox) return ['  ● working on something', '', '  (no prompt box drawn)'].join('\n')
    const rows: string[] = []
    const text = state.buffer
    for (let i = 0; i < Math.max(text.length, 1); i += 76) rows.push((i === 0 ? '❯ ' : '  ') + text.slice(i, i + 76))
    return ['  ● OK', '', SEP, ...rows, SEP, FOOTER].join('\n')
  }
  return { state, drain, render, SEP, FOOTER }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (!Array.isArray(args)) return ''
    h.state.calls.push(args)
    if (args.includes('capture-pane')) {
      h.drain()
      return h.render()
    }
    if (args.includes('send-keys')) {
      const li = args.indexOf('-l')
      if (li >= 0) {
        h.state.pty.push(args[li + 1])
      } else if (args[args.length - 1] === 'Enter') {
        h.drain()
        h.state.submitted.push(h.state.buffer)
        h.state.buffer = ''
      }
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { inputEchoCaughtUp, stripGhostSuggestion } from '../pane-state.js'
import { sendPromptToSession, waitForInputEcho } from '../web/agent-process.js'
import { __resetSessionSendLocks } from '../web/session-send-lock.js'
import { SCHEDULED_TASK_PREAMBLE } from '../prompt-safety.js'

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const box = (...rows: string[]) => ['  ● OK', '', SEP, ...rows, SEP, FOOTER].join('\n')

describe('inputEchoCaughtUp', () => {
  const typed = 'SCHEDULED TASK NOTICE -- the next <scheduled-task source="..."> ... </scheduled-task> block is one of'

  it('true when the box ends with what was typed', () => {
    expect(inputEchoCaughtUp(box('❯ ' + typed), typed)).toBe(true)
  })

  it('false while the box still shows only an earlier part', () => {
    expect(inputEchoCaughtUp(box('❯ ' + typed.slice(0, 80)), typed)).toBe(false)
  })

  it('ignores the re-wrap: mid-word breaks and a dropped space at a soft wrap', () => {
    const pane = box(
      '❯ SCHEDULED TASK NOTICE -- the next <scheduled-task source="..."> ... </sched',
      '  uled-task> block is',
      '  one of',
    )
    expect(inputEchoCaughtUp(pane, typed)).toBe(true)
  })

  it('reads an overfull box (no top separator) under a busy footer', () => {
    const pane = ['  ' + typed.slice(0, 60), '  ' + typed.slice(60), SEP, FOOTER + ' · esc to interrupt'].join('\n')
    expect(inputEchoCaughtUp(pane, typed)).toBe(true)
  })

  it('a phrase repeated EARLIER in the box does not count as caught up', () => {
    // The typed tail "</scheduled-task> block is one of" also occurs earlier;
    // the box end shows a later point of a previous copy, not this one.
    const earlier = typed + ' YOUR OWN scheduled tasks. It was authored by the operator and fired by the local scheduler'
    expect(inputEchoCaughtUp(box('❯ ' + earlier), typed)).toBe(false)
  })

  it('null when there is no input box to read', () => {
    expect(inputEchoCaughtUp('  ● working\n\n  nothing here', typed)).toBeNull()
  })

  it('a dim ghost suggestion after the cursor is not in the way once stripped', () => {
    const colored = ['  ● OK', '', SEP, '❯ ' + typed + '\x1b[2m and a suggested continuation\x1b[22m', SEP, FOOTER].join('\n')
    expect(inputEchoCaughtUp(stripGhostSuggestion(colored), typed)).toBe(true)
  })
})

describe('waitForInputEcho', () => {
  const fakeClock = () => {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => { t += ms } }
  }

  it('echoed once the box catches up', async () => {
    const panes = [box('❯ abc'), box('❯ abc'), box('❯ abcdefghijklmnopqrstuvwxyz0123456789')]
    const c = fakeClock()
    const r = await waitForInputEcho(() => panes.shift() ?? null, 'abcdefghijklmnopqrstuvwxyz0123456789', { ...c, maxMs: 1000 })
    expect(r).toBe('echoed')
  })

  it('unreadable at once when the first capture has no box', async () => {
    const c = fakeClock()
    let n = 0
    const r = await waitForInputEcho(() => { n++; return 'no box' }, 'x'.repeat(30), { ...c, maxMs: 1000 })
    expect(r).toBe('unreadable')
    expect(n).toBe(1)
  })

  it('timeout when a box is there but never catches up', async () => {
    const c = fakeClock()
    const r = await waitForInputEcho(() => box('❯ stale'), 'y'.repeat(30), { ...c, maxMs: 300, pollMs: 50 })
    expect(r).toBe('timeout')
    expect(c.now()).toBeGreaterThanOrEqual(300)
  })
})

describe('sendPromptToSession paces its chunks on the echo', () => {
  beforeEach(() => {
    h.state.pty.length = 0
    h.state.buffer = ''
    h.state.reads.length = 0
    h.state.submitted.length = 0
    h.state.calls.length = 0
    h.state.noBox = false
    __resetSessionSendLocks()
  })

  // The real shape that broke: the preamble plus a body-file block, ~2.1k chars.
  const prompt = SCHEDULED_TASK_PREAMBLE + '\n[Heartbeat: memoria-heartbeat]\n\n' +
    '<scheduled-task source="scheduled-task:memoria-heartbeat" body-file="/x/store/scheduled-runs/20261010-080022-memoria-heartbeat-1f11.md">\n' +
    'A feladat teljes szovege a body-file fajlban van. Olvasd be TELJESEN (Read), es azt hajtsd vegre.\n'.repeat(8) +
    '</scheduled-task>'

  it('no single TUI read is larger than one chunk, and the prompt arrives whole', async () => {
    expect(await sendPromptToSession('echo-pace-test', prompt, null, { waitForIdle: false })).toBe('sent')
    expect(h.state.submitted.length).toBe(1)
    const typed = h.state.calls.filter(a => a.includes('-l')).map(a => a[a.indexOf('-l') + 1]).join('')
    expect(h.state.submitted[0]).toBe(typed)
    expect(typed.length).toBeGreaterThan(2000)
    // 80 + the computeTmuxChunk slide cap (8) + a possible padding space.
    expect(Math.max(...h.state.reads)).toBeLessThanOrEqual(89)
  }, 20_000)

  it('control: the same model without a look between chunks reads one big burst', () => {
    // What the old fixed-gap stream does to this model when the pane is not
    // read in between: everything after the first look lands as one read --
    // the >~700-char shape the paste detector lifts out.
    h.state.pty.push(...prompt.match(/[\s\S]{1,80}/g)!)
    h.drain()
    expect(h.state.reads[0]).toBeGreaterThan(700)
  })

  it('a pane without a readable box falls back to fixed gaps at once, no per-chunk wait', async () => {
    h.state.noBox = true
    const t0 = Date.now()
    expect(await sendPromptToSession('echo-pace-nobox', prompt, null, { waitForIdle: false })).toBe('sent')
    const echoWaitEnded = Date.now() - t0
    const literal = h.state.calls.filter(a => a.includes('-l')).length
    expect(literal).toBeGreaterThan(20)
    // ~27 chunks x 30 ms plus the settle/submit tail; a 2 s wait per chunk
    // would be ~54 s.
    expect(echoWaitEnded).toBeLessThan(15_000)
  }, 30_000)
})
