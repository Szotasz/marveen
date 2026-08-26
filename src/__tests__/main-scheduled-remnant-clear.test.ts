import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// SCHEDCONTENTMATCH (Balogh-safe scheduler-content-match): the main channels box
// is NEVER auto-cleared for a REAL parked line (a human/inter-agent reply -- the
// 2026-06-30 "Balogh" near-miss). The one exception: a stranded FRAGMENT of one
// of OUR OWN dispatched scheduled prompts is provably system-generated text and
// can never be a real inbound reply, so it is safe to auto-clear instead of
// silencing the channel unattended. These tests cover (1) the pure content match
// and (2) that clearStaleParkedInput falls through to the clear path when a
// recorded remnant is parked, and stays escalate-only when it is not.

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  const mkPane = (line: string) => ['', SEP, '❯ ' + line, SEP, FOOTER].join('\n')
  return { mkPane, pane: '', calls: [] as string[][] }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      h.calls.push(args)
      if (args.includes('capture-pane')) return h.pane
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import {
  DISPATCHED_PROMPT_TTL_MS,
  SCHED_MATCH_MIN_LEN,
  recordDispatchedScheduledPrompt,
  matchesDispatchedScheduledPrompt,
  __resetDispatchedScheduledPromptsForTest,
} from '../web/dispatched-scheduled-prompts.js'
import { clearStaleParkedInput } from '../web/agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'

let clock = 5_000_000
const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)

function clearKeystrokes(): string[][] {
  return h.calls.filter(a => a.includes('send-keys') && (a.includes('C-u') || a.includes('C-k') || a.includes('C-a')))
}

beforeEach(() => {
  h.calls.length = 0
  __resetDispatchedScheduledPromptsForTest()
})
afterAll(() => { nowSpy.mockRestore() })

describe('matchesDispatchedScheduledPrompt (pure content match)', () => {
  const BODY = '[Utemezett feladat: reggeli-napindito] Keszits reggeli napindito uzenetet a Telegram csatornan MarkdownV2 formatumban.'

  it('exact recorded body matches', () => {
    recordDispatchedScheduledPrompt(BODY)
    expect(matchesDispatchedScheduledPrompt(BODY)).toBe(true)
  })

  it('a stranded fragment (substring) of a longer recorded body matches', () => {
    recordDispatchedScheduledPrompt(BODY)
    const frag = 'Keszits reggeli napindito uzenetet a Telegram csatornan' // >= SCHED_MATCH_MIN_LEN
    expect(frag.length).toBeGreaterThanOrEqual(SCHED_MATCH_MIN_LEN)
    expect(matchesDispatchedScheduledPrompt(frag)).toBe(true)
  })

  it('unrecorded / real-reply text never matches (Balogh case stays untouched)', () => {
    recordDispatchedScheduledPrompt(BODY)
    expect(matchesDispatchedScheduledPrompt('Igen, ird meg Baloghnak a valaszt')).toBe(false)
  })

  it('nothing recorded -> never matches', () => {
    expect(matchesDispatchedScheduledPrompt(BODY)).toBe(false)
  })

  it('parked text below SCHED_MATCH_MIN_LEN never matches even if it is a substring', () => {
    recordDispatchedScheduledPrompt(BODY)
    const shortFrag = 'Keszits' // < SCHED_MATCH_MIN_LEN chars
    expect(shortFrag.length).toBeLessThan(SCHED_MATCH_MIN_LEN)
    expect(matchesDispatchedScheduledPrompt(shortFrag)).toBe(false)
  })

  it('a body below the record-min-length is ignored (never authorizes a clear)', () => {
    recordDispatchedScheduledPrompt('too short body') // < 20 chars
    expect(matchesDispatchedScheduledPrompt('too short body')).toBe(false)
  })

  it('whitespace is normalized on both sides (newlines/tabs/runs collapse to single spaces)', () => {
    // Body + matched fragments must clear SCHED_MATCH_MIN_LEN (40) after normalize.
    recordDispatchedScheduledPrompt('alpha   beta\n\tgamma delta epsilon zeta eta theta iota kappa lambda')
    expect(matchesDispatchedScheduledPrompt('beta gamma delta epsilon zeta eta theta iota')).toBe(true)
    expect(matchesDispatchedScheduledPrompt('beta\n\n   gamma\tdelta epsilon zeta eta theta iota')).toBe(true)
  })

  it('an expired (past TTL) recorded body no longer matches', () => {
    recordDispatchedScheduledPrompt(BODY)
    expect(matchesDispatchedScheduledPrompt(BODY)).toBe(true)
    clock += DISPATCHED_PROMPT_TTL_MS + 1
    expect(matchesDispatchedScheduledPrompt(BODY)).toBe(false)
  })
})

describe('clearStaleParkedInput MAIN box: matched remnant falls through to clear', () => {
  const REMNANT = 'Reszletes utemezett prompt szoveg amit a boxba gepeltunk es beragadt'
  const RECORDED = '[Utemezett feladat: audit] ' + REMNANT + ' tovabbi folytatas.'

  it('a parked line that IS a recorded scheduled remnant is cleared (clearing keystrokes fire)', async () => {
    recordDispatchedScheduledPrompt(RECORDED)
    h.pane = h.mkPane(REMNANT)
    await clearStaleParkedInput(MAIN_CHANNELS_SESSION)
    // Fall-through to the forward-deletion clear path: clearing keystrokes reach
    // the main box (which upstream escalate-only behavior would NEVER do).
    expect(clearKeystrokes().length).toBeGreaterThan(0)
  }, 20_000)

  it('a real reply line that is NOT a recorded remnant stays escalate-only (never a keystroke)', async () => {
    // Nothing recorded -> the Balogh case: a real parked reply.
    h.pane = h.mkPane('Igen, ird meg Baloghnak a valaszt most')
    await clearStaleParkedInput(MAIN_CHANNELS_SESSION)
    expect(clearKeystrokes()).toHaveLength(0)
  }, 20_000)
})
