import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb, recordEmailIntent, recordEmailOutcome, getEmailAuditRows, EMAIL_AUDIT_OUTCOMES } from '../db.js'

beforeAll(() => {
  // In-memory: these cases write and delete email_audit_log rows wholesale, and
  // against the real store/claudeclaw.db that would eat the live audit trail --
  // the one table whose whole point is that nothing silently removes rows.
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

// EMAILAUDIT1109 (card 7df70b2e): the outgoing-letter audit trail.
//
// What this pins is not "a row gets written" but the three ways the trail can
// LIE, each of which was a real design choice:
//   1. a blocked send fires no PostToolUse, so its row stays outcome NULL --
//      and NULL must never be readable as success;
//   2. the two halves are written by two separate hook invocations, so neither
//      may assume the other ran (the row survives either order, and neither
//      half duplicates the row);
//   3. the first recorded outcome is the real one -- a later write must not
//      overwrite it, or a retry could turn a failure into a success.

const row = (traceId: string) =>
  getDb().prepare('SELECT * FROM email_audit_log WHERE trace_id = ?').get(traceId) as
    | Record<string, unknown>
    | undefined

const count = () =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM email_audit_log').get() as { n: number }).n

const intent = (traceId: string, over: Record<string, unknown> = {}) =>
  recordEmailIntent({
    trace_id: traceId,
    tool_name: 'mcp__google-workspace__send_gmail_message',
    mail_kind: 'send_email',
    agent_id: 'agent-x',
    session_id: 'sess-1',
    to: ['a@example.test'],
    cc: ['c@example.test'],
    bcc: ['b@example.test'],
    subject: 'Havi zaras',
    body_sha256: 'deadbeef',
    envelope_hash: 'anchor-1',
    approval_id: 'appr-1',
    ...over,
  })

describe('email_audit_log schema', () => {
  beforeEach(() => getDb().exec('DELETE FROM email_audit_log'))

  it('stores the body only as a digest -- there is no body column at all', () => {
    const cols = (getDb().prepare("SELECT name FROM pragma_table_info('email_audit_log')").all() as {
      name: string
    }[]).map(c => c.name)
    expect(cols).toContain('body_sha256')
    // The trail answers who wrote to whom, when, about what and under which
    // approval. A body column would quietly make it a second copy of the
    // mailbox, which is a different thing with different access rules.
    expect(cols.filter(c => /^(body|body_text|text|html)$/.test(c))).toEqual([])
  })

  it('keeps the recipient fields apart, bcc included', () => {
    // The approval anchor already treats bcc as part of the envelope
    // (EMAILBCCHORGONY903); an audit trail that folded it into `to` would lose
    // exactly the recipient nobody else can see.
    const cols = (getDb().prepare("SELECT name FROM pragma_table_info('email_audit_log')").all() as {
      name: string
    }[]).map(c => c.name)
    expect(cols).toContain('recipients_to')
    expect(cols).toContain('recipients_cc')
    expect(cols).toContain('recipients_bcc')
  })
})

describe('recordEmailIntent / recordEmailOutcome', () => {
  beforeEach(() => getDb().exec('DELETE FROM email_audit_log'))

  it('an intent alone leaves outcome NULL, which is NOT success', () => {
    intent('t-open')
    const r = row('t-open')!
    expect(r.outcome).toBeNull()
    expect(r.outcome_at).toBeNull()
    expect(r.intent_at).toBeTypeOf('number')
    // The written vocabulary is closed; NULL is outside it on purpose.
    expect(EMAIL_AUDIT_OUTCOMES).not.toContain(null as unknown as never)
  })

  it('the outcome closes the SAME row -- no second row per letter', () => {
    intent('t-1')
    recordEmailOutcome('t-1', 'sent', { providerMessageId: 'gmail-123' })
    expect(count()).toBe(1)
    const r = row('t-1')!
    expect(r.outcome).toBe('sent')
    expect(r.provider_message_id).toBe('gmail-123')
    expect(r.subject).toBe('Havi zaras')
    expect(r.approval_id).toBe('appr-1')
  })

  it('a repeated intent does not duplicate the row or revive a closed one', () => {
    intent('t-2')
    recordEmailOutcome('t-2', 'sent')
    intent('t-2', { subject: 'MASIK targy' })
    expect(count()).toBe(1)
    const r = row('t-2')!
    // The row is already complete: a late second intent must not rewrite the
    // letter it describes.
    expect(r.subject).toBe('Havi zaras')
    expect(r.outcome).toBe('sent')
  })

  it('an outcome with no intent is KEPT, with intent_at NULL as the measurable gap', () => {
    recordEmailOutcome('t-orphan', 'failed', {
      errorText: 'quota exceeded',
      toolName: 'mcp__x__send_email',
      mailKind: 'send_email',
      agentId: 'agent-y',
    })
    const r = row('t-orphan')!
    expect(r.outcome).toBe('failed')
    expect(r.error_text).toBe('quota exceeded')
    // Not silently dropped, and not pretending to be a full record either.
    expect(r.intent_at).toBeNull()
    expect(r.agent_id).toBe('agent-y')
  })

  it('an intent arriving after an orphan outcome fills the envelope in place', () => {
    recordEmailOutcome('t-3', 'sent', { providerMessageId: 'm-9' })
    intent('t-3')
    expect(count()).toBe(1)
    const r = row('t-3')!
    expect(r.intent_at).toBeTypeOf('number')
    expect(r.subject).toBe('Havi zaras')
    expect(r.outcome).toBe('sent')
    expect(r.provider_message_id).toBe('m-9')
  })

  it('the FIRST outcome wins -- a later write cannot turn a failure into a send', () => {
    intent('t-4')
    recordEmailOutcome('t-4', 'failed', { errorText: 'refused upstream' })
    recordEmailOutcome('t-4', 'sent', { providerMessageId: 'should-not-land' })
    const r = row('t-4')!
    expect(r.outcome).toBe('failed')
    expect(r.provider_message_id).toBeNull()
    expect(count()).toBe(1)
  })

  it("'blocked' is a first-class outcome, for the send a gate refused", () => {
    // A gate-blocked send never reaches PostToolUse, so this value is written
    // by whoever observes the refusal; the column must accept it.
    intent('t-5')
    recordEmailOutcome('t-5', 'blocked', { errorText: 'email_send level 1' })
    expect(row('t-5')!.outcome).toBe('blocked')
    expect(EMAIL_AUDIT_OUTCOMES).toEqual(['sent', 'failed', 'blocked'])
  })
})

describe('getEmailAuditRows', () => {
  beforeEach(() => getDb().exec('DELETE FROM email_audit_log'))

  it('returns an orphan outcome row too -- the time filter uses COALESCE', () => {
    // An intent_at-only filter would hide exactly the rows that record a gap,
    // and the gap is the reason they are kept.
    recordEmailOutcome('t-o', 'failed', { toolName: 'x', mailKind: 'send_email' })
    const rows = getEmailAuditRows(3600)
    expect(rows.map(r => r.trace_id)).toContain('t-o')
  })

  it('filters by agent when asked, and parses nothing away', () => {
    intent('t-a', { agent_id: 'one' })
    intent('t-b', { agent_id: 'two' })
    expect(getEmailAuditRows(3600, 'one').map(r => r.trace_id)).toEqual(['t-a'])
    expect(getEmailAuditRows(3600).length).toBe(2)
  })

  it('does not return rows older than the window', () => {
    intent('t-old')
    getDb().prepare('UPDATE email_audit_log SET intent_at = ? WHERE trace_id = ?')
      .run(Math.floor(Date.now() / 1000) - 7200, 't-old')
    expect(getEmailAuditRows(3600).map(r => r.trace_id)).not.toContain('t-old')
    expect(getEmailAuditRows(10800).map(r => r.trace_id)).toContain('t-old')
  })
})
