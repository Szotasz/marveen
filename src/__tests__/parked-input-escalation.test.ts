import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// clearStaleParkedInput (agent-process.ts) contract, as of v1.18.3 + the dim-guard:
//   - MAIN agent box: NEVER auto-cleared (a parked line could be a real reply --
//     the 2026-06-30 "Balogh" near-miss); the operator escalation is MUTED
//     (v1.18.3) so NO notifyChannel fires on the main box either.
//   - sub-agent box: keep the Ctrl-U clear path for a REAL parked line.
//   - DIM-GUARD (Szabi insight): a ghost/phantom line renders DIM (SGR-2 faint);
//     captureParkedInputView strips it, so it reads as NO parked text and is NEVER
//     treated as a wedge (no clear, no escalate) -- for ANY agent. This is the fix
//     for the 2026-06-30 "Koszi a halakat." dim-fragment false-positive.
//
// capturePane (-p) and captureParkedInputView (-e) are LOCAL to agent-process and
// go through node:child_process execFileSync, so we mock execFileSync with
// arg-inspection: a 'capture-pane' call returns a pane; the -e variant returns
// `eView` so a test can make the dim-stripped view differ from the plain one.

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  const LINE = '❯ Igen, írd meg Baloghnak a választ'
  // Real, normal-intensity parked line (survives the dim strip).
  const PARKED = ['', SEP, LINE, SEP, FOOTER].join('\n')
  // Ghost/phantom: the text after the prompt is DIM (SGR-2 faint) -> stripped to
  // an empty box by captureParkedInputView -> reads as no parked text.
  const PARKED_DIM = ['', SEP, '❯ \x1b[2mKoszi a halakat.\x1b[22m', SEP, FOOTER].join('\n')
  return { PARKED, PARKED_DIM, calls: [] as string[][], eView: null as string | null }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      h.calls.push(args)
      if (args.includes('capture-pane')) {
        return args.includes('-e') ? (h.eView ?? h.PARKED) : h.PARKED
      }
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
const COOLDOWN = 31_000 // > UNWEDGE_COOLDOWN_MS so each call re-runs (not cooldown-skipped)

function clearKeystrokes(): string[][] {
  return h.calls.filter(a => a.includes('send-keys') && (a.includes('C-u') || a.includes('C-k')))
}

beforeEach(() => {
  h.calls.length = 0
  h.eView = null // default: dim-stripped view == plain (real, non-dim parked line)
  vi.mocked(notifyChannel).mockClear()
})
afterAll(() => { nowSpy.mockRestore() })

describe('clearStaleParkedInput', () => {
  it('NEVER auto-clears the main agent box, and (escalation muted) never notifies', () => {
    for (let i = 0; i < 4; i++) { clearStaleParkedInput(MAIN_CHANNELS_SESSION); clock += COOLDOWN }
    expect(clearKeystrokes().length).toBe(0)        // main box untouched by clearing keystrokes
    expect(vi.mocked(notifyChannel)).toHaveBeenCalledTimes(0) // muted (v1.18.3)
  })

  it('attempts the Ctrl-U clear for a SUB-agent box with a REAL parked line', () => {
    clearStaleParkedInput('subagent-zara-channels')
    expect(clearKeystrokes().length).toBeGreaterThan(0)
  })

  it('DIM-GUARD: a dim ghost line is NOT treated as parked -> no clear (any agent)', () => {
    h.eView = h.PARKED_DIM // the -e/dim-stripped view shows an empty box
    clearStaleParkedInput('subagent-zara-channels')
    expect(clearKeystrokes().length).toBe(0) // ghost stripped -> no parked text -> no action
    // and the main box likewise stays untouched + silent on a dim ghost
    clearStaleParkedInput(MAIN_CHANNELS_SESSION)
    expect(vi.mocked(notifyChannel)).toHaveBeenCalledTimes(0)
  })
})
