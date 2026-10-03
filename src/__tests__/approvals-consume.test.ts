import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createApproval,
  getApproval,
  resolveApproval,
  consumeApproval,
} from '../db.js'
import {
  computeConsumeWindow,
  DEFAULT_CONSUME_WINDOW_SECONDS,
  MAX_TIMEOUT_SECONDS,
} from '../web/routes/approvals.js'

const DAY = 24 * 3600

beforeEach(() => {
  initDatabase(':memory:')
})

function approved(id: string, contentHash?: string) {
  createApproval({
    id,
    agent_id: 'szuszukalocsa',
    category: 'memory_maintenance',
    action_description: '9 elavult hot memoria cold-ba: 124,129,168',
    content_hash: contentHash ?? null,
  })
  resolveApproval(id, 'approved', 'owner-telegram')
  return getApproval(id)!
}

// MEMAPPROVALVEGTELEN923 -- the defect this suite pins down: before the fix an
// `approved` row was a permanent licence, because nothing outside the email
// gate ever wrote consumed_at.
describe('consumeApproval', () => {
  it('spends a fresh approved row once, and stamps consumed_at', () => {
    approved('ap-1')
    const first = consumeApproval('ap-1', { windowSeconds: DAY })
    expect(first.verdict).toBe('allowed')
    expect(first.bound).toBe(false)
    expect(first.approval?.consumed_at).toBeTypeOf('number')

    const second = consumeApproval('ap-1', { windowSeconds: DAY })
    expect(second.verdict).toBe('consumed')
    // The stamp of the FIRST consume must survive the refused second one.
    expect(getApproval('ap-1')?.consumed_at).toBe(first.approval?.consumed_at)
  })

  it('refuses a row the owner has not decided yet, and leaves it unconsumed', () => {
    createApproval({
      id: 'ap-pending',
      agent_id: 'szuszukalocsa',
      category: 'memory_maintenance',
      action_description: 'meg nincs dontes',
    })
    expect(consumeApproval('ap-pending', { windowSeconds: DAY }).verdict).toBe('pending')
    expect(getApproval('ap-pending')?.consumed_at).toBeNull()
  })

  it('refuses a rejected and a timed-out row', () => {
    createApproval({ id: 'ap-no', agent_id: 'a', category: 'memory_maintenance', action_description: 'x' })
    resolveApproval('ap-no', 'rejected', 'owner-telegram')
    expect(consumeApproval('ap-no', { windowSeconds: DAY }).verdict).toBe('rejected')

    createApproval({ id: 'ap-late', agent_id: 'a', category: 'memory_maintenance', action_description: 'x' })
    resolveApproval('ap-late', 'timeout', 'sweeper')
    expect(consumeApproval('ap-late', { windowSeconds: DAY }).verdict).toBe('timeout')
  })

  it('refuses a yes older than the window -- the 954b7685 shape', () => {
    // The live row: approved on 2026-09-20 13:38, still approved and unconsumed
    // on 09-23 05:30. Three days later it must not authorize anything.
    const row = approved('ap-954b')
    const threeDaysLater = row.resolved_at! + 3 * DAY
    const late = consumeApproval('ap-954b', { windowSeconds: DAY, nowS: threeDaysLater })
    expect(late.verdict).toBe('expired')
    expect(getApproval('ap-954b')?.consumed_at).toBeNull()

    // Same row, inside the window: still usable.
    const inTime = consumeApproval('ap-954b', { windowSeconds: DAY, nowS: row.resolved_at! + 3600 })
    expect(inTime.verdict).toBe('allowed')
  })

  it('a content-bound row only counts for its own anchor', () => {
    const anchor = 'b'.repeat(64)
    approved('ap-bound', anchor)

    const wrong = consumeApproval('ap-bound', { windowSeconds: DAY, contentHash: 'c'.repeat(64) })
    expect(wrong.verdict).toBe('hash_mismatch')
    expect(wrong.bound).toBe(true)

    // A caller that sends no anchor at all fails closed too.
    expect(consumeApproval('ap-bound', { windowSeconds: DAY }).verdict).toBe('hash_mismatch')
    expect(getApproval('ap-bound')?.consumed_at).toBeNull()

    const right = consumeApproval('ap-bound', { windowSeconds: DAY, contentHash: anchor })
    expect(right.verdict).toBe('allowed')
    expect(right.bound).toBe(true)
  })

  it('reports an unknown id as not_found, not as a pass', () => {
    const miss = consumeApproval('nincs-ilyen', { windowSeconds: DAY })
    expect(miss.verdict).toBe('not_found')
    expect(miss.approval).toBeUndefined()
  })
})

describe('computeConsumeWindow', () => {
  it('defaults to a day, so a dawn request answered at breakfast still works', () => {
    expect(computeConsumeWindow(undefined)).toBe(DEFAULT_CONSUME_WINDOW_SECONDS)
    expect(DEFAULT_CONSUME_WINDOW_SECONDS).toBe(DAY)
  })

  it('takes an explicit window, ignores nonsense, and caps at a week', () => {
    expect(computeConsumeWindow(600)).toBe(600)
    expect(computeConsumeWindow(0)).toBe(DEFAULT_CONSUME_WINDOW_SECONDS)
    expect(computeConsumeWindow(-5)).toBe(DEFAULT_CONSUME_WINDOW_SECONDS)
    expect(computeConsumeWindow('3600')).toBe(DEFAULT_CONSUME_WINDOW_SECONDS)
    expect(computeConsumeWindow(NaN)).toBe(DEFAULT_CONSUME_WINDOW_SECONDS)
    expect(computeConsumeWindow(99 * DAY)).toBe(MAX_TIMEOUT_SECONDS)
  })
})
