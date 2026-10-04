import { describe, it, expect, vi, beforeEach } from 'vitest'

// BORITEKVESZ927 review follow-up (#1625): computeTmuxChunk is pinned on its
// own in tmux-chunk-boundary.test.ts, but nothing asserted that the code that
// SHIPS -- sendPromptToSession's chunk stream -- goes through it. Replacing the
// call with the old inline dash-only loop left every test green. This drives
// the real sendPromptToSession and inspects each `send-keys -l` argument.
//
// Harness as in janitor-under-send-lane.test.ts: runTmux/capturePane are local
// to agent-process and go through node:child_process execFileSync, so that is
// mocked with argument inspection. The pane is an idle, empty prompt box, so
// the submit follow-up loop finishes on its first sample.

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  const IDLE = ['', SEP, '❯ ', SEP, FOOTER].join('\n')
  return { IDLE, calls: [] as string[][] }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      h.calls.push(args)
      if (args.includes('capture-pane')) return h.IDLE
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { sendPromptToSession } from '../web/agent-process.js'
import { __resetSessionSendLocks } from '../web/session-send-lock.js'

function literalChunks(): string[] {
  return h.calls
    .filter(a => a.includes('send-keys') && a.includes('-l'))
    .map(a => a[a.indexOf('-l') + 1])
}

beforeEach(() => {
  h.calls.length = 0
  __resetSessionSendLocks()
})

describe('sendPromptToSession streams through computeTmuxChunk', () => {
  it("no literal chunk ends in ';' or starts with '-', and every ';' survives", async () => {
    // Boundaries are computed WITH the slides: chunk 1 would end on ';'
    // followed by 'x-' (the case where two sequential dodge loops typed a
    // space into the text) and slides to index 82; chunk 2 (82..161) ends on
    // a ';'; the prompt's very last character is a ';'.
    const text =
      'a'.repeat(79) + ';x-' +
      'b'.repeat(79) + ';' +
      'tail ' + 'd'.repeat(20) + ';'
    expect(await sendPromptToSession('chunk-binding-test', text, null, { waitForIdle: false })).toBe('sent')

    const chunks = literalChunks()
    expect(chunks.length).toBe(3)
    for (const c of chunks) {
      expect(c.endsWith(';')).toBe(false)
      expect(c.startsWith('-')).toBe(false)
    }
    const streamed = chunks.join('')
    // The only permitted change: a trailing space after a prompt-final ';'.
    expect(streamed).toBe(text + ' ')
    expect((streamed.match(/;/g) || []).length).toBe((text.match(/;/g) || []).length)
  }, 15_000)
})
