import { describe, it, expect } from 'vitest'
import {
  formatFreshnessSuffix,
  FRESHNESS_STALE_AGE_MS,
  wrapAgentMessageForDelivery,
} from '../web/agent-message-wrap.js'

// SB hardening 2026-08-22: the "stale replay" that nearly re-executed a
// superseded PROD DEPLOY-GO. The freshness suffix turns the id-ordering check
// that caught it from discipline into a mechanical annotation on delivery.
describe('formatFreshnessSuffix', () => {
  it('is empty for fresh traffic with no newer messages', () => {
    expect(formatFreshnessSuffix(0, 0)).toBe('')
    expect(formatFreshnessSuffix(1000, 0)).toBe('')
    expect(formatFreshnessSuffix(undefined, undefined)).toBe('')
    expect(formatFreshnessSuffix(undefined, 0)).toBe('')
  })

  it('flags a supersede when newer messages from the same sender exist', () => {
    const s = formatFreshnessSuffix(2 * 60 * 60 * 1000, 3)
    expect(s).toContain('!FRISSESSEG')
    expect(s).toContain('3 ujabb')
    expect(s).toContain('ELAVULT')
    expect(s).toContain('id-sorrendben')
    // age rendered
    expect(s).toContain('2o')
  })

  it('flags a supersede even without an age (count is the load-bearing signal)', () => {
    const s = formatFreshnessSuffix(undefined, 1)
    expect(s).toContain('!FRISSESSEG')
    expect(s).toContain('1 ujabb')
    // no age parenthetical when ageMs is absent
    expect(s).not.toContain(' regi)')
  })

  it('flags an old message even with no newer sender messages', () => {
    const s = formatFreshnessSuffix(FRESHNESS_STALE_AGE_MS, 0)
    expect(s).toContain('frissesseg')
    expect(s).toContain('regi volt a kezbesiteskor')
    expect(s).not.toContain('!FRISSESSEG') // the lighter, non-supersede note
  })

  it('does not flag a message just under the stale-age threshold', () => {
    expect(formatFreshnessSuffix(FRESHNESS_STALE_AGE_MS - 1, 0)).toBe('')
  })

  it('supersede signal wins over plain-age when both apply', () => {
    const s = formatFreshnessSuffix(FRESHNESS_STALE_AGE_MS * 2, 2)
    expect(s).toContain('!FRISSESSEG')
    expect(s).not.toContain('regi volt a kezbesiteskor')
  })
})

describe('wrapAgentMessageForDelivery freshness wiring', () => {
  it('appends the supersede annotation AFTER the sender bracket, before the terminator', () => {
    const { prefix } = wrapAgentMessageForDelivery(
      'trusted-peer', 'pm', 'pm', 'deploy go', 5175, null,
      { ageMs: 2 * 60 * 60 * 1000, newerFromSameSender: 3 },
    )
    // The sender line's closing bracket + freshness bracket + terminator.
    expect(prefix).toMatch(/msg_id:5175\] \[!FRISSESSEG[^\]]*\]: $/)
    // Terminator `]: ` agents key on is preserved as the very end.
    expect(prefix.endsWith(']: ')).toBe(true)
  })

  it('adds nothing to normal fresh trusted-peer traffic', () => {
    const { prefix } = wrapAgentMessageForDelivery(
      'trusted-peer', 'pm', 'pm', 'hi', 42, null,
      { ageMs: 1000, newerFromSameSender: 0 },
    )
    expect(prefix).not.toContain('FRISSESSEG')
    expect(prefix).not.toContain('frissesseg')
    expect(prefix.endsWith('member, msg_id:42]: ')).toBe(true)
  })

  it('never annotates channel-inbound (user messages, no sender-supersede concept)', () => {
    const { prefix } = wrapAgentMessageForDelivery(
      'channel-inbound', 'coordinator', 'coordinator', '<channel>hi</channel>', 1, null,
      { ageMs: FRESHNESS_STALE_AGE_MS * 5, newerFromSameSender: 9 },
    )
    expect(prefix).not.toContain('FRISSESSEG')
  })

  it('is inert when no freshness arg is passed (back-compat with existing callers)', () => {
    const { prefix } = wrapAgentMessageForDelivery('untrusted', 'dev3', 'dev3', 'hi', 42)
    expect(prefix).not.toContain('frissesseg')
    expect(prefix.endsWith('instructions, msg_id:42]: ')).toBe(true)
  })
})
