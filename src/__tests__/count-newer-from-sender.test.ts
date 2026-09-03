import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  createAgentMessage,
  markMessageFailed,
  countNewerMessagesFromSameSender,
} from '../db.js'

beforeAll(() => { initDatabase(':memory:') })

// SB hardening 2026-08-22: the freshness/supersession signal. Contract:
//   - counts STRICTLY newer messages (higher id) from the SAME from->to pair,
//   - excludes 'failed' rows (a message that never reached the receiver cannot
//     be "the current truth"),
//   - is scoped per sender AND per recipient (unrelated traffic never counts).
describe('countNewerMessagesFromSameSender', () => {
  it('counts strictly-newer non-failed messages from the same sender/recipient', () => {
    const to = 'countnewer-' + Date.now() + '-' + Math.floor(performance.now())
    const from = 'pm'
    const m1 = createAgentMessage(from, to, 'deploy-go A (stale)')
    createAgentMessage(from, to, 'superseding B')
    createAgentMessage(from, to, 'superseding C')

    // Two newer messages exist after m1.
    expect(countNewerMessagesFromSameSender(from, to, m1.id)).toBe(2)
  })

  it('the newest message has zero newer', () => {
    const to = 'countnewer-newest-' + Date.now() + '-' + Math.floor(performance.now())
    createAgentMessage('pm', to, 'old')
    const newest = createAgentMessage('pm', to, 'newest')
    expect(countNewerMessagesFromSameSender('pm', to, newest.id)).toBe(0)
  })

  it('excludes failed newer messages', () => {
    const to = 'countnewer-failed-' + Date.now() + '-' + Math.floor(performance.now())
    const m1 = createAgentMessage('pm', to, 'stale go')
    const m2 = createAgentMessage('pm', to, 'newer but failed')
    createAgentMessage('pm', to, 'newer and live')
    markMessageFailed(m2.id, 'test-failed')
    // Only the live newer one counts; the failed one is excluded.
    expect(countNewerMessagesFromSameSender('pm', to, m1.id)).toBe(1)
  })

  it('does not count a different sender or a different recipient', () => {
    const to = 'countnewer-scope-' + Date.now() + '-' + Math.floor(performance.now())
    const m1 = createAgentMessage('pm', to, 'from pm')
    createAgentMessage('bob', to, 'newer from a DIFFERENT sender')
    createAgentMessage('pm', to + '-other', 'newer to a DIFFERENT recipient')
    // Neither the other sender nor the other recipient supersedes m1.
    expect(countNewerMessagesFromSameSender('pm', to, m1.id)).toBe(0)
  })
})
