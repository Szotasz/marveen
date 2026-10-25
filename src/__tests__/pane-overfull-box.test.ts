import { describe, it, expect } from 'vitest'
import {
  detectPaneState,
  stuckInputSignature,
  parkedInputText,
  parkedInputRowCount,
  parkedMachineOriginInput,
  parkedScheduledTaskInput,
  parkedChannelInput,
  decideStuckInputAction,
} from '../pane-state.js'

// OVERFULL INPUT BOX (2026-08-17 reggeli-napindito incident).
//
// A parked prompt taller than the visible pane pushes the input box's TOP
// separator -- and the ❯ prompt row with it -- off the top of the capture.
// Only the bottom border survives, just above the footer. Before the fix the
// two-separator scan found no top separator, detectPaneState returned 'idle'
// and liveInputBox returned null, so every 'typing'-gated recovery layer stood
// down silently while isSessionReadyForPrompt still refused to send: the MAIN
// channels session pinned itself on a parked 07:30 scheduled prompt for 30
// minutes, with not one log line from any watcher, until the owner typed and
// pushed the box through.
//
// The content-level half of the case was already handled
// (MACHINE_ORIGIN_TRUNCATED_MARKERS exists precisely because the TUI drops the
// HEAD rows of an overfull box) -- it was simply unreachable.

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'

// The TAIL of a long scheduled-task injection: the wrapper's head (the
// `SCHEDULED TASK NOTICE` prefix, the `[Utemezett feladat: ...]` marker AND the
// ❯ row) has scrolled off the top of the capture, exactly as observed.
const SCHEDULED_TAIL = [
  '  **AI hírek szekció -- CSAK a fő-ágensnél (mikrobi)**: ha NEM a fő-ágensként',
  '  futsz (azaz sub-agentként), HAGYD KI az "AI HÍREK" szekciót -- sub-agenteknek',
  '  nem releváns. Az email és naptár szekció marad mindenkinél.',
  '  </scheduled-task>',
]

const overfullPane = (content: string[]) => [...content, SEP, FOOTER].join('\n')

const IDLE = ['', SEP, '❯ ', SEP, FOOTER].join('\n')

describe('overfull input box (top border scrolled off the capture)', () => {
  it('classifies a head-truncated parked prompt as typing, not idle', () => {
    expect(detectPaneState(overfullPane(SCHEDULED_TAIL))).toBe('typing')
  })

  it('still reports the framed empty box as idle', () => {
    expect(detectPaneState(IDLE)).toBe('idle')
  })

  it('merges to busy when the caller asked for mergeTypingAsBusy', () => {
    expect(detectPaneState(overfullPane(SCHEDULED_TAIL), { mergeTypingAsBusy: true })).toBe('busy')
  })

  it('exposes the visible tail to the stuck-input recovery stack', () => {
    const sig = stuckInputSignature(overfullPane(SCHEDULED_TAIL))
    expect(sig).not.toBeNull()
    expect(sig).toContain('</scheduled-task>')
    // Multi-row: a bare Enter would insert a newline, so the escalation ladder
    // must see the real row count and skip straight to a clearing action.
    expect(parkedInputRowCount(overfullPane(SCHEDULED_TAIL))).toBeGreaterThan(1)
  })

  it('recognises the head-truncated tick via the truncated machine-origin markers', () => {
    const pane = overfullPane(SCHEDULED_TAIL)
    // The anchored prefixes (^SCHEDULED TASK NOTICE) cannot match a truncated
    // head -- the truncated-marker fallback is what carries this case.
    expect(parkedMachineOriginInput(pane)).toBe(true)
    expect(parkedScheduledTaskInput(pane)).toBe(true)
  })

  it('routes the parked tick to clear-scheduled rather than a lossy re-inject', () => {
    const pane = overfullPane(SCHEDULED_TAIL)
    const block = parkedChannelInput(pane)
    const action = decideStuckInputAction({
      escalate: true,
      rowCount: parkedInputRowCount(pane),
      blockComplete: false,
      blockTruncated: block != null && !block.complete,
      truncatedPreamble: false,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: parkedScheduledTaskInput(pane),
      machineOrigin: parkedMachineOriginInput(pane),
      // Upstream added this fact after the local branch forked: false is the
      // conservative value and the one the MAIN wrapper defaults to, so the
      // overfull-box case is still measured exactly as it is in production.
      recordedMatch: false,
    })
    expect(action).toBe('clear-scheduled')
  })

  it('does not read a lone stray rule above the footer as parked input', () => {
    // Guard on the inference: fewer than two non-blank rows above the orphan
    // separator is a short/garbled capture, not an overflowing box.
    expect(detectPaneState(['', SEP, FOOTER].join('\n'))).toBe('idle')
    expect(detectPaneState(['   ', SEP, FOOTER].join('\n'))).toBe('idle')
    expect(parkedInputText(['', SEP, FOOTER].join('\n'))).toBeNull()
  })

  it('leaves a busy pane busy -- the overflow inference never overrides busy', () => {
    const busy = overfullPane([...SCHEDULED_TAIL, '  Percolating… (52s · ↓ 2.6k tokens · esc to interrupt)'])
    expect(detectPaneState(busy)).toBe('busy')
  })

  it('keeps the framed-box path authoritative when both borders are visible', () => {
    const framed = ['', SEP, '❯ szia', SEP, FOOTER].join('\n')
    expect(detectPaneState(framed)).toBe('typing')
    expect(parkedInputText(framed)).toBe('szia')
  })
})
