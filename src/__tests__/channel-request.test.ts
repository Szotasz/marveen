import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import {
  initDatabase,
  getDb,
  upsertChannelRequest,
  listPendingChannelRequests,
  updateChannelRequestStatus,
  updateChannelRequestName,
} from '../db.js'
import { channelRequestFromAuditLine } from '../web/channel-request-watcher.js'

beforeAll(() => {
  // In-memory DB so the test never writes to the real store/claudeclaw.db.
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().exec("DELETE FROM pending_channel_requests")
})

describe('upsertChannelRequest', () => {
  it('inserts a new pending request', () => {
    expect(upsertChannelRequest('test-agent', 'C123', 'U456')).toBe(true)
    const rows = listPendingChannelRequests('test-agent')
    expect(rows).toHaveLength(1)
    expect(rows[0].channel_id).toBe('C123')
    expect(rows[0].user_id).toBe('U456')
    expect(rows[0].status).toBe('pending')
  })

  it('deduplicates pending requests for same agent+channel', () => {
    upsertChannelRequest('test-agent', 'C123')
    expect(upsertChannelRequest('test-agent', 'C123')).toBe(false)
    expect(listPendingChannelRequests('test-agent')).toHaveLength(1)
  })

  it('allows same channel for different agents', () => {
    upsertChannelRequest('agent-a', 'C123')
    expect(upsertChannelRequest('agent-b', 'C123')).toBe(true)
  })

  it('blocks re-entry for recently denied channels (7-day window)', () => {
    upsertChannelRequest('test-agent', 'C123')
    const rows = listPendingChannelRequests('test-agent')
    updateChannelRequestStatus(rows[0].id, 'denied')
    expect(upsertChannelRequest('test-agent', 'C123')).toBe(false)
  })

  it('allows re-entry for denied channels after 7 days', () => {
    upsertChannelRequest('test-agent', 'C123')
    const rows = listPendingChannelRequests('test-agent')
    updateChannelRequestStatus(rows[0].id, 'denied')
    const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 86400
    getDb().prepare('UPDATE pending_channel_requests SET resolved_at = ? WHERE id = ?').run(eightDaysAgo, rows[0].id)
    expect(upsertChannelRequest('test-agent', 'C123')).toBe(true)
  })

  it('allows re-entry for approved channels (new pending)', () => {
    upsertChannelRequest('test-agent', 'C123')
    const rows = listPendingChannelRequests('test-agent')
    updateChannelRequestStatus(rows[0].id, 'approved')
    expect(upsertChannelRequest('test-agent', 'C123')).toBe(true)
  })
})

describe('updateChannelRequestStatus', () => {
  it('sets resolved_at when approving', () => {
    upsertChannelRequest('test-agent', 'C123')
    const rows = listPendingChannelRequests('test-agent')
    updateChannelRequestStatus(rows[0].id, 'approved')
    const row = getDb().prepare('SELECT resolved_at, status FROM pending_channel_requests WHERE id = ?').get(rows[0].id) as { resolved_at: number; status: string }
    expect(row.status).toBe('approved')
    expect(row.resolved_at).toBeGreaterThan(0)
  })

  it('sets resolved_at when denying', () => {
    upsertChannelRequest('test-agent', 'C123')
    const rows = listPendingChannelRequests('test-agent')
    updateChannelRequestStatus(rows[0].id, 'denied')
    const row = getDb().prepare('SELECT resolved_at, status FROM pending_channel_requests WHERE id = ?').get(rows[0].id) as { resolved_at: number; status: string }
    expect(row.status).toBe('denied')
    expect(row.resolved_at).toBeGreaterThan(0)
  })

  it('returns false for non-existent id', () => {
    expect(updateChannelRequestStatus(99999, 'approved')).toBe(false)
  })

  it('returns false for already resolved request', () => {
    upsertChannelRequest('test-agent', 'C123')
    const rows = listPendingChannelRequests('test-agent')
    updateChannelRequestStatus(rows[0].id, 'denied')
    expect(updateChannelRequestStatus(rows[0].id, 'approved')).toBe(false)
  })
})

describe('updateChannelRequestName', () => {
  it('sets channel name on existing request', () => {
    upsertChannelRequest('test-agent', 'C123')
    const rows = listPendingChannelRequests('test-agent')
    updateChannelRequestName(rows[0].id, 'general')
    const updated = listPendingChannelRequests('test-agent')
    expect(updated[0].channel_name).toBe('general')
  })
})

describe('channelRequestFromAuditLine (the real parser)', () => {
  // The record the slack-channel plugin writes since DROPREASON1124 (Szotasz/claude-code-slack-channel#13).
  const journal = (reason: string | undefined, input: Record<string, unknown>) =>
    JSON.stringify({
      v: 1, ts: '2026-11-24T16:00:00.000Z', seq: 1, prevHash: 'a'.repeat(64),
      kind: 'gate.inbound.drop', outcome: 'drop', actor: 'session_owner',
      ...(reason ? { reason } : {}), input, hash: 'b'.repeat(64),
    })

  it('turns a journaled channel-not-allowed drop that tagged the bot into a request', () => {
    expect(channelRequestFromAuditLine(journal('channel-not-allowed', { channel: 'C123', user: 'U456', botMentioned: true })))
      .toEqual({ channel: 'C123', user: 'U456' })
  })

  it('ignores a drop that did not tag the bot, or had another reason', () => {
    expect(channelRequestFromAuditLine(journal('channel-not-allowed', { channel: 'C123', user: 'U456', botMentioned: false }))).toBeNull()
    expect(channelRequestFromAuditLine(journal('sender-not-allowed', { channel: 'C123', user: 'U456', botMentioned: true }))).toBeNull()
    expect(channelRequestFromAuditLine(journal('duplicate', { channel: 'C123', ts: '1.1' }))).toBeNull()
  })

  it('ignores the pre-DROPREASON1124 record (no reason, no mention flag): measured shape, 2026-11-17', () => {
    const old = '{"v":1,"ts":"2026-11-17T20:50:56.452Z","seq":60,"prevHash":"' + 'c'.repeat(64) +
      '","kind":"gate.inbound.drop","outcome":"drop","actor":"peer_agent","input":{"channel":"C0CGUBW4PR7","user":"U0CJFU9QQF7"},"hash":"' + 'd'.repeat(64) + '"}'
    expect(channelRequestFromAuditLine(old)).toBeNull()
  })

  it('still accepts the flat shape', () => {
    const flat = '{"type":"gate.inbound.drop","reason":"channel-not-allowed","channel":"C123","user":"U456","botMentioned":true}'
    expect(channelRequestFromAuditLine(flat)).toEqual({ channel: 'C123', user: 'U456' })
  })

  it('ignores other kinds and malformed lines', () => {
    expect(channelRequestFromAuditLine(journal('channel-not-allowed', { channel: 'C123', botMentioned: true }).replace('gate.inbound.drop', 'gate.inbound.deliver'))).toBeNull()
    expect(channelRequestFromAuditLine('not json')).toBeNull()
    expect(channelRequestFromAuditLine('null')).toBeNull()
    expect(channelRequestFromAuditLine(journal('channel-not-allowed', { botMentioned: true }))).toBeNull()
  })
})
