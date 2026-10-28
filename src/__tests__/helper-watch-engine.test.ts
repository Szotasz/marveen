// Deterministic watch engine (src/web/helper/watch-engine.ts). The Q1 probe
// measured qwen3:14b classifying a real release ("KIADVA az elo CRM-en") as
// skip 2/2 times, so the matcher is primary: a matcher hit is escalated
// without asking the model, and a model "skip" can never suppress it.
import { describe, it, expect, vi } from 'vitest'
import { evaluateWatch, buildEscalationMessage, MAX_ESCALATION_CHARS, type WatchItem, type JudgeOutcome, type WatchEvalDeps } from '../web/helper/watch-engine.js'
import type { WatchSpec } from '../web/helper/types.js'
import { validateWatchSpec } from '../web/helper/types.js'

const CREATED = 1_000
const card = (over: Partial<WatchSpec> = {}): WatchSpec => ({ kind: 'kanban-comment', target: 'abc123', authorPrefix: 'dev-', match: 'KIADVA', ...over })
const item = (id: number, content: string, author = 'dev-lead', createdAt = CREATED + id): WatchItem => ({ id, author, content, createdAt })

function deps(items: WatchItem[], judge: (q: string, it: WatchItem) => Promise<JudgeOutcome>, over: Partial<WatchEvalDeps> = {}): WatchEvalDeps {
  return { nowMs: 5_000_000, listItems: () => items, judge, fallback: 'skip', ...over }
}

describe('matcher first', () => {
  it('a matcher hit escalates and the model is NOT asked, even when it would say skip', async () => {
    const judge = vi.fn(async (): Promise<JudgeOutcome> => ({ kind: 'skip', reason: 'looks routine' }))
    const r = await evaluateWatch('Szólj, ha kiadták.', CREATED, card({ needsJudgement: true }), undefined,
      deps([item(1, 'KIADVA az elo CRM-en, Elo HEAD a -> b')], judge))
    expect(r.event).toBe('match')
    expect(r.escalated.map((e) => e.via)).toEqual(['matcher'])
    expect(judge).not.toHaveBeenCalled()
    expect(r.modelCalls).toBe(0)
    expect(r.done).toBe(true)
  })

  it('an item the matcher misses goes to the model only on a needsJudgement watch', async () => {
    const judge = vi.fn(async (): Promise<JudgeOutcome> => ({ kind: 'escalate', reason: 'release in other words' }))
    const plain = await evaluateWatch('', CREATED, card(), undefined, deps([item(1, 'kint van az új verzió')], judge))
    expect(plain.event).toBeNull()
    expect(judge).not.toHaveBeenCalled()
    const judged = await evaluateWatch('', CREATED, card({ needsJudgement: true }), undefined, deps([item(1, 'kint van az új verzió')], judge))
    expect(judged.escalated.map((e) => [e.via, e.reason])).toEqual([['model', 'release in other words']])
  })

  it('a model skip drops only the item it was asked about', async () => {
    const judge = vi.fn(async (): Promise<JudgeOutcome> => ({ kind: 'skip', reason: 'chatter' }))
    const r = await evaluateWatch('', CREATED, card({ needsJudgement: true }), undefined, deps([item(1, 'reggelt'), item(2, 'KIADVA')], judge))
    expect(judge).toHaveBeenCalledTimes(1)
    expect(r.escalated.map((e) => e.item.id)).toEqual([2])
    expect(r.skippedByModel).toBe(1)
  })
})

describe('author / history filtering', () => {
  it('ignores other authors and the helper itself', async () => {
    const judge = vi.fn(async (): Promise<JudgeOutcome> => ({ kind: 'escalate', reason: 'x' }))
    const r = await evaluateWatch('', CREATED, card(), undefined, deps([item(1, 'KIADVA', 'c3po'), item(2, 'KIADVA', 'helper')], judge))
    expect(r.event).toBeNull()
  })
  it('the first evaluation ignores comments written before the watch existed, later ones use the cursor', async () => {
    const judge = vi.fn(async (): Promise<JudgeOutcome> => ({ kind: 'skip', reason: '' }))
    const history = item(1, 'KIADVA (old)', 'dev-lead', CREATED - 10)
    const first = await evaluateWatch('', CREATED, card({ repeat: true }), undefined, deps([history], judge))
    expect(first.event).toBeNull()
    expect(first.nextState.cursor).toBe(1)
    const second = await evaluateWatch('', CREATED, card({ repeat: true }), first.nextState, deps([history, item(2, 'KIADVA new')], judge))
    expect(second.escalated.map((e) => e.item.id)).toEqual([2])
    expect(second.done).toBe(false)
  })
})

describe('endpoint unavailable', () => {
  it('fallback skip keeps the item pending and judges it once the endpoint is back', async () => {
    const down = vi.fn(async (): Promise<JudgeOutcome> => ({ kind: 'unavailable' }))
    const s1 = await evaluateWatch('', CREATED, card({ needsJudgement: true }), undefined, deps([item(5, 'hmm')], down))
    expect(s1.event).toBeNull()
    expect(s1.nextState.pending).toEqual([5])
    const up = vi.fn(async (): Promise<JudgeOutcome> => ({ kind: 'escalate', reason: 'yes' }))
    const s2 = await evaluateWatch('', CREATED, card({ needsJudgement: true }), s1.nextState, deps([item(5, 'hmm')], up))
    expect(s2.escalated.map((e) => e.item.id)).toEqual([5])
    expect(s2.nextState.pending).toEqual([])
  })
  it('a pending item never delays a matcher hit in the same tick', async () => {
    const down = vi.fn(async (): Promise<JudgeOutcome> => ({ kind: 'unavailable' }))
    const r = await evaluateWatch('', CREATED, card({ needsJudgement: true }), undefined, deps([item(1, 'hmm'), item(2, 'KIADVA')], down))
    expect(r.escalated.map((e) => [e.item.id, e.via])).toEqual([[2, 'matcher']])
    expect(r.nextState.pending).toEqual([1])
  })
  it('fallback opus escalates the item unclassified', async () => {
    const down = vi.fn(async (): Promise<JudgeOutcome> => ({ kind: 'unavailable' }))
    const r = await evaluateWatch('', CREATED, card({ needsJudgement: true }), undefined, deps([item(1, 'hmm')], down, { fallback: 'opus' }))
    expect(r.escalated.map((e) => e.via)).toEqual(['fallback'])
  })
})

describe('message watch', () => {
  it('queries after the cursor and reaches back to pending items', async () => {
    const listItems = vi.fn(() => [] as WatchItem[])
    await evaluateWatch('', CREATED, { kind: 'message', target: '*', match: 'kész' }, { cursor: 40, pending: [12, 30] }, deps([], async () => ({ kind: 'unavailable' }), { listItems }))
    expect(listItems).toHaveBeenCalledWith(expect.anything(), 11, CREATED)
  })
})

describe('time and expiry', () => {
  it('a time watch fires once its time has passed', async () => {
    const at = '2026-10-26T15:00:00Z'
    const before = await evaluateWatch('', CREATED, { kind: 'time', target: at }, undefined, deps([], async () => ({ kind: 'unavailable' }), { nowMs: Date.parse(at) - 1 }))
    expect(before.event).toBeNull()
    const after = await evaluateWatch('', CREATED, { kind: 'time', target: at }, undefined, deps([], async () => ({ kind: 'unavailable' }), { nowMs: Date.parse(at) }))
    expect(after).toMatchObject({ event: 'time', done: true, modelCalls: 0 })
  })
  it('until passed without a hit -> one expired event, done', async () => {
    const r = await evaluateWatch('', CREATED, card({ until: '2026-10-26T10:00:00Z' }), undefined, deps([], async () => ({ kind: 'unavailable' }), { nowMs: Date.parse('2026-10-26T10:00:01Z') }))
    expect(r).toMatchObject({ event: 'expired', done: true })
  })
})

describe('escalation message', () => {
  it('one header line, at most 3 evidence lines, capped length, control chars stripped', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ item: item(i + 1, 'KIADVA \u0007' + 'x'.repeat(500)), via: 'matcher' as const }))
    const msg = buildEscalationMessage({ taskName: 'w1', helperType: 'watch', spec: card({ note: 'release figyelő' }), event: 'match', escalated: many })
    const lines = msg.split('\n')
    expect(lines[0]).toBe('[HELPER-ESCALATE task=w1 type=watch event=kanban-comment ref=card:abc123]')
    expect(lines.filter((l) => l.startsWith('- #'))).toHaveLength(3)
    expect(msg.length).toBeLessThanOrEqual(MAX_ESCALATION_CHARS)
    expect(msg).not.toContain('\u0007')
  })
})

describe('validateWatchSpec', () => {
  it.each([
    [{ kind: 'kanban-comment', target: 'abc' }, /match regex, needsJudgement/],
    [{ kind: 'kanban-comment', target: 'abc', match: '(' }, /valid regex/],
    [{ kind: 'time', target: 'tomorrow' }, /ISO/],
    [{ kind: 'message', target: '*', match: 'x', escalateTo: 'system' }, /not "system"/],
    [{ kind: 'gh-release', target: 'x' }, /kind/],
  ])('rejects %j', (raw, msg) => expect(validateWatchSpec(raw)).toMatch(msg))
  it('accepts a minimal card watch', () => {
    expect(validateWatchSpec({ kind: 'kanban-comment', target: 'abc', match: 'KIADVA' })).toEqual({ kind: 'kanban-comment', target: 'abc', match: 'KIADVA' })
  })
})
