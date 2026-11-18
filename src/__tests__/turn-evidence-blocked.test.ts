import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { classifyTurnEvidence, SYNTHETIC_MODEL } from '../web/delivery-integrity.js'
import { decideTaskTimeout, TASK_FIRE_GRACE_MS } from '../web/schedule-runner.js'
import type { TaskInflightEntry } from '../web/schedule-runner.js'
import { OWNER_ESCALATION_EXTRA_MS } from '../pending-retries.js'

// SCHEDHAMISDONE1014 -- "done" must mean the task RAN.
//
// The shapes below are the ones MEASURED on this install, 2026-10-14 07:30:06,
// when the morning round was answered by the CLI itself:
//
//   {"type":"system","subtype":"informational","content":"Usage limit reached
//     again · continuing automatically at 8am"}
//   {"type":"assistant","message":{"model":"<synthetic>","content":[{"type":
//     "text","text":"You've hit your weekly limit · resets 8am"}]}}
//
// and its task_runs row said status=fired, outcome=done, delivery=intact. The
// same shape produced 2851 'done' rows in four days while the fleet's model
// was quota-blocked.

const PROMPT = 'SCHEDULED TASK NOTICE -- the next <scheduled-task source="scheduled-task:reggeli-napindito"> block is yours'
const T0 = Date.parse('2026-10-14T05:30:05.000Z')

function row(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
}

function userRow(tsMs: number, text: string): string {
  return row({ type: 'user', timestamp: new Date(tsMs).toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } })
}

function assistantRow(tsMs: number, model: string, text: string): string {
  return row({ type: 'assistant', timestamp: new Date(tsMs).toISOString(), message: { role: 'assistant', model, content: [{ type: 'text', text }] } })
}

describe('classifyTurnEvidence', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'turn-evidence-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function transcript(name: string, lines: string[]): void {
    writeFileSync(join(dir, name), lines.join('\n') + '\n')
  }

  it('reads the quota refusal as synthetic, not as a turn', () => {
    transcript('a.jsonl', [
      userRow(T0 + 500, PROMPT),
      assistantRow(T0 + 1200, SYNTHETIC_MODEL, "You've hit your weekly limit · resets 8am (Europe/Budapest)"),
    ])
    expect(classifyTurnEvidence([dir], T0, PROMPT)).toBe('synthetic')
  })

  it('reads a real model reply as a turn', () => {
    transcript('a.jsonl', [
      userRow(T0 + 500, PROMPT),
      assistantRow(T0 + 1200, 'claude-opus-5', 'Checking the calendar.'),
    ])
    expect(classifyTurnEvidence([dir], T0, PROMPT)).toBe('real')
  })

  it('a real turn after a synthetic one still counts as real (the CLI retried itself)', () => {
    transcript('a.jsonl', [
      userRow(T0 + 500, PROMPT),
      assistantRow(T0 + 1200, SYNTHETIC_MODEL, 'Usage limit reached'),
      assistantRow(T0 + 90_000, 'claude-opus-5', 'Here is the morning round.'),
    ])
    expect(classifyTurnEvidence([dir], T0, PROMPT)).toBe('real')
  })

  it('a SIBLING session in the same projects dir cannot stand in as evidence', () => {
    // The old mtime probe looked at the directory, so any other session writing
    // there proved "our" turn. Anchoring on the prompt is what closes that.
    transcript('ours.jsonl', [
      userRow(T0 + 500, PROMPT),
      assistantRow(T0 + 1200, SYNTHETIC_MODEL, 'Usage limit reached'),
    ])
    transcript('sibling.jsonl', [
      userRow(T0 + 600, 'the owner typing in another session'),
      assistantRow(T0 + 2000, 'claude-opus-5', 'a real turn, but not ours'),
    ])
    expect(classifyTurnEvidence([dir], T0, PROMPT)).toBe('synthetic')
  })

  it('rows before the injection are not evidence', () => {
    transcript('a.jsonl', [
      userRow(T0 - 60_000, PROMPT),
      assistantRow(T0 - 50_000, 'claude-opus-5', 'the PREVIOUS occurrence'),
    ])
    expect(classifyTurnEvidence([dir], T0, PROMPT)).toBe('none')
  })

  it('untilMs bounds the window, so a backtest sees what the sweep saw', () => {
    transcript('a.jsonl', [
      userRow(T0 + 500, PROMPT),
      assistantRow(T0 + 1200, SYNTHETIC_MODEL, 'Usage limit reached'),
      assistantRow(T0 + 3_600_000, 'claude-opus-5', 'an hour later, after the reset'),
    ])
    expect(classifyTurnEvidence([dir], T0, PROMPT)).toBe('real')
    expect(classifyTurnEvidence([dir], T0, PROMPT, { untilMs: T0 + 30_000 })).toBe('synthetic')
  })

  it('an unreadable directory degrades to none, never throws', () => {
    expect(classifyTurnEvidence([join(dir, 'does-not-exist')], T0, PROMPT)).toBe('none')
    expect(classifyTurnEvidence([dir], T0, null)).toBe('none')
  })
})

// --- The decision the evidence feeds ---

const BASE_OPTS = {
  graceMs: TASK_FIRE_GRACE_MS,
  timeoutMs: 2_700_000,
  maxTrackMs: 6 * 60 * 60_000,
  ownerExtraMs: OWNER_ESCALATION_EXTRA_MS,
}

type EntryFields = Pick<TaskInflightEntry, 'injectedAt' | 'alerted' | 'ownerAlerted' | 'sawTurn' | 'sawSynthetic'>

function entry(overrides: Partial<EntryFields> = {}): EntryFields {
  return { injectedAt: 0, alerted: false, ownerAlerted: false, sawTurn: false, ...overrides }
}

describe('decideTaskTimeout: a refused injection is blocked, not done', () => {
  it('idle + synthetic reply + past grace => blocked', () => {
    expect(decideTaskTimeout(entry({ sawSynthetic: true }), 'idle', TASK_FIRE_GRACE_MS + 1, BASE_OPTS)).toBe('blocked')
  })

  it('inside the grace window it still holds -- the CLI may retry itself', () => {
    expect(decideTaskTimeout(entry({ sawSynthetic: true }), 'idle', TASK_FIRE_GRACE_MS - 1, BASE_OPTS)).toBe('hold')
  })

  it('a real turn outranks an earlier synthetic one', () => {
    expect(decideTaskTimeout(entry({ sawTurn: true, sawSynthetic: true }), 'idle', TASK_FIRE_GRACE_MS + 1, BASE_OPTS)).toBe('done')
  })

  it('without synthetic evidence the lost path is unchanged', () => {
    expect(decideTaskTimeout(entry(), 'idle', TASK_FIRE_GRACE_MS + 1, BASE_OPTS)).toBe('lost')
  })
})

// --- Fix-revert guards (the pattern this suite already uses) ---

const RUNNER_SRC = readFileSync(new URL('../web/schedule-runner.ts', import.meta.url), 'utf8')

describe('the sweep keeps the evidence conservative', () => {
  it('only a POSITIVE synthetic reading overrides the mtime verdict', () => {
    // 'none' (prompt not found, transcript unreadable) must keep setting
    // sawTurn: downgrading it would re-open the false-lost hole, which costs a
    // redelivery, while a wrong quota row costs only a wrong row.
    expect(RUNNER_SRC).toMatch(/if \(evidence === 'synthetic'\) entry\.sawSynthetic = true\s*\n\s*else entry\.sawTurn = true/)
  })

  it('the blocked branch closes the run and does NOT queue a redelivery', () => {
    const branch = RUNNER_SRC.split("} else if (decision === 'blocked') {")[1]?.split("} else if (decision === 'lost') {")[0] ?? ''
    expect(branch).toContain("markTaskRunCompleted(entry.runId, 'blocked', now)")
    expect(branch).not.toContain('insertPendingTaskRetryIfNew')
    expect(branch).not.toContain('scheduleLastRun.delete')
  })
})
