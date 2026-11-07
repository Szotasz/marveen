import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parkedScheduledPasteSignature,
  parkedPasteSignature,
  parkedScheduledTaskInput,
  parkedInputText,
  stuckInputSignature,
  detectPaneState,
  type StuckInputState,
} from '../pane-state.js'
import {
  decideScheduledPasteClear,
  oldestRetryFor,
  SCHED_PASTE_THRESHOLDS,
  SCHED_PASTE_MIN_RETRY_MS,
} from '../web/stuck-input-watcher.js'
import type { PendingTaskRetryRow } from '../db.js'

// SCHEDPASTE1030: the main pane held this box from 2026-10-29 18:20 to 2026-10-30
// 10:53 and the scheduler deferred 19 tasks behind it. The capture below is the
// real one (tmux capture-pane, tail), U+00A0 after the prompt glyph included; the
// spinner line is the capturing agent's own live turn.
const SEP = '─'.repeat(80)
const BOX = [
  '❯ SCHEDULED TASK NOTICE -- the next <scheduled-task source="..."> ...',
  '  </scheduled-[Pasted text #48][Pasted text #49]ulj el reszleges szovegbol:',
  '  jelezd a hibat a kor eredmenyekent. </scheduled-task>',
  '',
]
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const CAPTURED = [
  '✢ Sketching… (22s · ↓ 1.5k tokens · thought for 2s)',
  '',
  '───────────────────────────────────────────────────────────────────────── Nova ─',
  ...BOX,
  SEP,
  FOOTER,
].join('\n')
const IDLE = ['● Done.', '', SEP, ...BOX, SEP, FOOTER].join('\n')
const box = (rows: string[]) => ['● Done.', '', SEP, ...rows, '', SEP, FOOTER].join('\n')

describe('parkedScheduledPasteSignature (the real 10-29 pane)', () => {
  it('matches the captured box, mid-turn and idle alike', () => {
    for (const pane of [CAPTURED, IDLE]) {
      const sig = parkedScheduledPasteSignature(pane)
      expect(sig).toMatch(/^SCHEDULED TASK NOTICE -- the next <scheduled-task/)
      expect(sig).toContain('[Pasted text #48][Pasted text #49]')
    }
  })

  it('is the box no other path saw: the stub reads busy, so every typing-gated probe is null', () => {
    expect(detectPaneState(IDLE)).toBe('busy')
    expect(stuckInputSignature(IDLE)).toBeNull()
    expect(parkedInputText(IDLE)).toBeNull()
    expect(parkedScheduledTaskInput(IDLE)).toBe(false)
    // mid-turn the bare-Enter paste path is out too (busy region)
    expect(parkedPasteSignature(CAPTURED)).toBeNull()
  })

  it('leaves alone a box that does not start with the scheduler wrapper', () => {
    expect(parkedScheduledPasteSignature(box(['❯ [Pasted text #12 +40 lines]']))).toBeNull()
    expect(parkedScheduledPasteSignature(box(['❯ nezd meg ezt: [Pasted text #3] es SCHEDULED TASK NOTICE']))).toBeNull()
    expect(parkedScheduledPasteSignature(box(['❯ <channel source="plugin:telegram:telegram" chat_id="1">[Pasted text #4]</channel>']))).toBeNull()
  })

  it('leaves a notice without a stub to the typing path (clear-scheduled already covers it)', () => {
    const pane = box(['❯ SCHEDULED TASK NOTICE -- the next <scheduled-task source="x"> run it </scheduled-task>'])
    expect(parkedScheduledPasteSignature(pane)).toBeNull()
    expect(parkedScheduledTaskInput(pane)).toBe(true)
  })

  it('a stub quoted in scrollback above an empty box is not a parked tick', () => {
    const pane = ['● the box held: SCHEDULED TASK NOTICE ... [Pasted text #48]', '', SEP, '❯ ', SEP, FOOTER].join('\n')
    expect(parkedScheduledPasteSignature(pane)).toBeNull()
  })

  it('without the box separators on screen nothing proves the box holds it (tail fallback): no match', () => {
    const pane = ['SCHEDULED TASK NOTICE -- the next <scheduled-task source="x"> [Pasted text #2]', FOOTER].join('\n')
    expect(parkedScheduledPasteSignature(pane)).toBeNull()
  })

  it('also matches the <scheduled-task> wrapper form', () => {
    expect(parkedScheduledPasteSignature(box(['❯ <scheduled-task name="x"> a [Pasted text #2] b']))).toMatch(/^<scheduled-task/)
  })
})

const NO_STATE: StuckInputState = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }
const MIN = 60_000

describe('decideScheduledPasteClear', () => {
  const sig = 'SCHEDULED TASK NOTICE x [Pasted text #1]'
  // the scheduler has retried for 20 minutes unless a case says otherwise
  const run = (ticks: Array<{ at: number; sig?: string | null; retry?: number | null }>) => {
    let prev = NO_STATE
    return ticks.map(t => {
      const r = decideScheduledPasteClear({
        sig: t.sig === undefined ? sig : t.sig, prev, now: t.at,
        retryingSince: t.retry === undefined ? t.at - 20 * MIN : t.retry,
      })
      prev = r.next
      return r
    })
  }

  it('clears only after the box sat unchanged for the confirm window', () => {
    const r = run([{ at: 0 }, { at: 149_000 }, { at: 150_000 }])
    expect(r.map(x => x.clear)).toEqual([false, false, true])
    expect(r[2].next.attempts).toBe(1)
  })

  it('never clears while the scheduler is not (long enough) retrying, and spends no attempt', () => {
    const r = run([{ at: 0 }, { at: 200_000, retry: null }, { at: 215_000, retry: 215_000 - SCHED_PASTE_MIN_RETRY_MS + 1 }])
    expect(r.map(x => x.clear)).toEqual([false, false, false])
    expect(r[2].next.attempts).toBe(0)
    expect(r[2].next.firstSeenAt).toBe(0)
    // the moment the retry crosses ten minutes, the spell (already confirmed) clears
    const later = decideScheduledPasteClear({ sig, prev: r[2].next, now: 230_000, retryingSince: 230_000 - SCHED_PASTE_MIN_RETRY_MS })
    expect(later.clear).toBe(true)
  })

  it('a changed box restarts the confirm window', () => {
    const r = run([{ at: 0 }, { at: 140_000, sig: sig + ' more' }, { at: 160_000, sig: sig + ' more' }])
    expect(r.map(x => x.clear)).toEqual([false, false, false])
  })

  it('stops after maxAttempts, with the dedup gap between clears', () => {
    const ticks = [{ at: 0 }]
    for (let t = 150_000; t <= 400_000; t += 15_000) ticks.push({ at: t })
    const cleared = run(ticks).filter(x => x.clear).length
    expect(cleared).toBe(SCHED_PASTE_THRESHOLDS.maxAttempts)
    const at = run(ticks).map((x, i) => (x.clear ? ticks[i].at : null)).filter((x): x is number => x !== null)
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(SCHED_PASTE_THRESHOLDS.dedupMs)
  })

  it('an empty box ends the spell', () => {
    const r = run([{ at: 0 }, { at: 150_000, sig: null }])
    expect(r[1]).toEqual({ clear: false, next: NO_STATE })
  })
})

describe('oldestRetryFor', () => {
  const row = (agent_name: string, first_attempt: number) => ({ agent_name, first_attempt } as PendingTaskRetryRow)
  it('the oldest retry of that agent only', () => {
    expect(oldestRetryFor([row('nova', 300), row('bit', 100), row('nova', 200)], 'nova')).toBe(200)
    expect(oldestRetryFor([row('bit', 100)], 'nova')).toBeNull()
    expect(oldestRetryFor([], 'nova')).toBeNull()
  })
})

// --- wiring contract (windows anchored on declarations) ---
const SRC = readFileSync(join(__dirname, '..', 'web', 'stuck-input-watcher.ts'), 'utf-8')

describe('wiring', () => {
  const sweep = SRC.slice(SRC.indexOf('export function startStuckInputWatcher'))
  const fnStart = SRC.indexOf('async function clearScheduledPaste')
  const fn = SRC.slice(fnStart, SRC.indexOf('\n}', fnStart))

  it('the scheduled-paste clear runs before the bare-Enter paste path, on MAIN and on local sub-agents', () => {
    const main = sweep.indexOf('clearScheduledPaste(MAIN_AGENT_ID')
    expect(main).toBeGreaterThan(-1)
    expect(main).toBeLessThan(sweep.indexOf('recoverParkedPaste(MAIN_AGENT_ID'))
    const local = sweep.indexOf('clearScheduledPaste(name, session)')
    expect(local).toBeGreaterThan(-1)
    expect(local).toBeLessThan(sweep.indexOf('recoverParkedPaste(name, session, null'))
  })

  it('it clears under the send lane and never sends Enter', () => {
    expect(fn).toMatch(/clearParkedInputUnderLane\(session\)/)
    expect(fn).not.toMatch(/sendEnterToSession|'Enter'/)
  })

  it('the scheduler gate reads pending_task_retries for this agent', () => {
    expect(fn).toMatch(/oldestRetryFor\(listPendingTaskRetries\(\), label\)/)
  })
})
