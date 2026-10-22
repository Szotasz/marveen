import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initDatabase, getDb, createApproval, getApproval, resolveApproval, CLEARED_EMAIL_PAYLOAD,
} from '../db.js'
import { startApprovalTimeoutSweeper } from '../web/routes/approvals.js'

// The Python send gate writes consumed_at directly, so
// only the timeout sweeper can clear the letter of an approval it consumed.
// This pins the wiring: the sweeper itself, on its own timer, clears it.
const LETTER = JSON.stringify({
  envelope_v: 1, to: ['ugyfel@example.com'], cc: [], bcc: ['rejtett@example.com'], text: 'Tisztelt Ügyfelünk!',
})

let timer: NodeJS.Timeout | null = null

beforeEach(() => {
  initDatabase(':memory:')
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})

afterEach(() => {
  if (timer) clearInterval(timer)
  timer = null
  vi.useRealTimers()
})

describe('startApprovalTimeoutSweeper', () => {
  it('clears the envelope of a letter the Python gate consumed, on its next tick', () => {
    const now = Math.floor(Date.now() / 1000)
    createApproval({
      id: 'sw-1', agent_id: 'marveen', category: 'email_send', action_description: 'x',
      action_payload: LETTER, content_hash: 'ab'.repeat(32), timeout_at: now + 600,
    })
    expect(resolveApproval('sw-1', 'approved', 'dashboard')).toBe(true)
    // What the gate does on an allowed send.
    getDb().prepare('UPDATE approvals SET consumed_at = ? WHERE id = ?').run(now, 'sw-1')

    timer = startApprovalTimeoutSweeper()
    expect(getApproval('sw-1')!.action_payload).toBe(LETTER)
    vi.advanceTimersByTime(60_000)
    expect(getApproval('sw-1')!.action_payload).toBe(CLEARED_EMAIL_PAYLOAD)
  })
})
