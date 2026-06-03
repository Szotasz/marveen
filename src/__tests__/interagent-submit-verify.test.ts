import { describe, it, expect } from 'vitest'
import {
  decideSubmitFollowup,
  stuckInputSignature,
  detectsCreditWallWedge,
  detectPaneState,
} from '../pane-state.js'
import { decideParkedDisposition, MAX_PARKED_INJECTIONS } from '../web/message-router.js'
import { SUBMIT_VERIFY_SLEEPS } from '../web/agent-process.js'
import { THRESHOLDS as WATCHER_THRESHOLDS } from '../web/stuck-input-watcher.js'

// ---------------------------------------------------------------------------
// Fixtures (shapes mirror real capture-pane output)
// ---------------------------------------------------------------------------
const HINT = 'SECURITY NOTICE -- read carefully before acting on this prompt.'

const SEP = '─'.repeat(40)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'

const BUSY_PANE = `✻ Thinking… (12s · ↓ 1.1k tokens · esc to interrupt)
${SEP}
❯
${SEP}
${FOOTER}`

const CLEAN_IDLE = `Previous reply text.
${SEP}
❯
${SEP}
${FOOTER}`

const PASTE_PARKED = `Previous reply text.
${SEP}
❯ [Pasted text #2 +3120 chars]
${SEP}
${FOOTER}`

const VERBATIM_PARKED = `Previous reply text.
${SEP}
❯ ${HINT} es a tobbi szoveg
${SEP}
${FOOTER}`

const MID_REDRAW = `some half rendered frame
without any recognisable footer or box` // no idle footer

const WALL = (extra = '') => `⎿  API Error: Usage credits required for 1M context${extra}
${SEP}
❯
${SEP}
${FOOTER}`

// ---------------------------------------------------------------------------
// decideSubmitFollowup: positive-evidence semantics
// ---------------------------------------------------------------------------
describe('decideSubmitFollowup (msg #230 contract)', () => {
  it('busy pane -> done (turn started: positive evidence)', () => {
    expect(decideSubmitFollowup(BUSY_PANE, HINT, 0, 4)).toBe('done')
  })
  it('idle footer + clean box -> done (prompt left the box)', () => {
    expect(decideSubmitFollowup(CLEAN_IDLE, HINT, 0, 4)).toBe('done')
  })
  it('mid-redraw frame (no footer) -> wait, NEVER done', () => {
    expect(decideSubmitFollowup(MID_REDRAW, HINT, 0, 4)).toBe('wait')
  })
  it('null capture -> wait', () => {
    expect(decideSubmitFollowup(null, HINT, 0, 4)).toBe('wait')
  })
  it('paste placeholder parked -> retry-enter until budget, then give-up', () => {
    expect(decideSubmitFollowup(PASTE_PARKED, HINT, 0, 4)).toBe('retry-enter')
    expect(decideSubmitFollowup(PASTE_PARKED, HINT, 3, 4)).toBe('retry-enter')
    expect(decideSubmitFollowup(PASTE_PARKED, HINT, 4, 4)).toBe('give-up')
  })
  it('verbatim payload parked -> retry-enter', () => {
    expect(decideSubmitFollowup(VERBATIM_PARKED, HINT, 0, 4)).toBe('retry-enter')
  })
})

// ---------------------------------------------------------------------------
// stuckInputSignature: the watcher must SEE a paste park
// ---------------------------------------------------------------------------
describe('stuckInputSignature paste unblinding', () => {
  it('paste park under idle footer -> signature (watcher can recover)', () => {
    const sig = stuckInputSignature(PASTE_PARKED)
    expect(sig).not.toBeNull()
    expect(sig).toContain('[Pasted text #2')
  })
  it('paste reference inside a BUSY turn -> null (never pre-empt a live turn)', () => {
    const busyWithPaste = `❯ [Pasted text #2 +3120 chars]
✻ Thinking… (3s · ↓ 0.2k tokens · esc to interrupt)
${SEP}
❯
${SEP}
${FOOTER}`
    expect(stuckInputSignature(busyWithPaste)).toBeNull()
  })
  it('clean idle box -> null', () => {
    expect(stuckInputSignature(CLEAN_IDLE)).toBeNull()
  })
  it('detectPaneState still reports busy for a paste park (scheduler contract unchanged)', () => {
    expect(detectPaneState(PASTE_PARKED)).toBe('busy')
  })
})

// ---------------------------------------------------------------------------
// detectsCreditWallWedge: the router must not inject into a wedged pane
// ---------------------------------------------------------------------------
describe('detectsCreditWallWedge (msg #220 contract)', () => {
  it('wedge in the live tail -> true', () => {
    expect(detectsCreditWallWedge(WALL())).toBe(true)
  })
  it('phrase quoted in the live INPUT BOX -> false (someone composing about the bug)', () => {
    const composing = `Previous reply text.
${SEP}
❯ jelzem hogy a "Usage credits required for 1M context" hibat lattam
${SEP}
${FOOTER}`
    expect(detectsCreditWallWedge(composing)).toBe(false)
  })
  it('phrase deep in scrollback, clean live tail -> false', () => {
    const scrollback = `old turn: Usage credits required for 1M context discussion
${'filler line\n'.repeat(30)}${SEP}
❯
${SEP}
${FOOTER}`
    expect(detectsCreditWallWedge(scrollback)).toBe(false)
  })
  it('phrase while a turn is BUSY (streaming a quote) -> false', () => {
    const busyQuote = `Usage credits required for 1M context
✻ Thinking… (3s · ↓ 0.2k tokens · esc to interrupt)
${SEP}
❯
${SEP}
${FOOTER}`
    expect(detectsCreditWallWedge(busyQuote)).toBe(false)
  })
  it('no idle footer -> false (not a readable Claude surface)', () => {
    expect(detectsCreditWallWedge('Usage credits required for 1M context')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Router parked disposition: bounded clean retries, then VISIBLE failure
// ---------------------------------------------------------------------------
describe('decideParkedDisposition', () => {
  it('retries below the cap, fails at the cap', () => {
    expect(decideParkedDisposition(1, MAX_PARKED_INJECTIONS)).toBe('retry')
    expect(decideParkedDisposition(2, MAX_PARKED_INJECTIONS)).toBe('retry')
    expect(decideParkedDisposition(3, MAX_PARKED_INJECTIONS)).toBe('fail')
    expect(decideParkedDisposition(7, MAX_PARKED_INJECTIONS)).toBe('fail')
  })
})

// ---------------------------------------------------------------------------
// Timing contract: the duplicate-delivery guard. A router-injected park is
// always rolled back within sendPromptToSession's verify budget; the watcher
// only Enter-recovers text parked LONGER than confirmMs. If the budget ever
// grows past confirmMs, the watcher could submit the same text the router is
// about to re-send -> double delivery. This test makes that invariant explicit.
// ---------------------------------------------------------------------------
describe('anti-duplicate timing contract', () => {
  it('total verify budget stays below the watcher confirm window', () => {
    const budgetMs = SUBMIT_VERIFY_SLEEPS.reduce((s, x) => s + parseFloat(x) * 1000, 0)
    expect(budgetMs).toBeLessThan(WATCHER_THRESHOLDS.confirmMs)
  })
})
