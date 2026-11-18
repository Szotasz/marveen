/**
 * a missing column's worth of silence on the approvals
 * table. (The one-shot consumption half of the original card is
 * covered upstream by consumeApproval and POST /api/approvals/:id/consume.)
 *
 * Delivery: the only record that an approval request had reached
 * the owner was a log line. The field that used to stand in for it,
 * telegram_message_id, carried a value on exactly two rows in this install's
 * entire history -- both from the Telegram era. Measured 2026-10-07 across ten
 * rows: from 13:16 onward every row was NULL, so a DELIVERED request, a FAILED
 * one and an EXPIRED one were externally identical, and a sub-agent had
 * already written a rule that only worked by that coincidence.
 *
 * The class: an outcome the system performs but does not record,
 * so two different states read the same from outside.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import {
  initDatabase, createApproval, getApproval, resolveApproval,
  markApprovalNotified,
} from '../db.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

beforeAll(() => { initDatabase(':memory:') })
afterAll(() => { vi.restoreAllMocks() })

let seq = 0
function newApproval(category = 'skill_patch') {
  seq += 1
  const id = `approval-${seq}`
  createApproval({ id, agent_id: 'marveen', category, action_description: 'test' })
  return id
}

describe('notified_at -- the delivery leaves a mark on the row', () => {
  it('a fresh request is NOT marked as notified', () => {
    const id = newApproval()
    expect(getApproval(id)!.notified_at).toBeNull()
  })

  it('a successful send stamps the row', () => {
    const id = newApproval()
    expect(markApprovalNotified(id, 1_791_900_000)).toBe(true)
    expect(getApproval(id)!.notified_at).toBe(1_791_900_000)
  })

  it('write-once: a second stamp does not move the first delivery', () => {
    const id = newApproval()
    markApprovalNotified(id, 1_791_900_000)
    expect(markApprovalNotified(id, 1_791_999_999)).toBe(false)
    expect(getApproval(id)!.notified_at).toBe(1_791_900_000)
  })

  it('the distinction the card is about: two rows with the same status differ', () => {
    const delivered = newApproval()
    const suppressed = newApproval()
    markApprovalNotified(delivered, 1_791_900_000)
    resolveApproval(delivered, 'timeout', 'sweeper')
    resolveApproval(suppressed, 'timeout', 'sweeper')

    expect(getApproval(delivered)!.status).toBe(getApproval(suppressed)!.status)
    expect(getApproval(delivered)!.notified_at).not.toBeNull()
    expect(getApproval(suppressed)!.notified_at).toBeNull()
  })
})
