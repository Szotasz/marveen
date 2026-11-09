// Acceptance test for card 2e1a5659: the context-guard resume prompt drains
// the recipient's pending inter-agent queue into the SAME injection, so the
// fresh session's first (long) continuation turn cannot starve delivery for
// its whole duration. Measured incident behind the card (2026-11-08, a
// long-turn agent): three pending rows were created 03:23-03:29 and were
// delivered only 04:30 -- they outlived TWO full guard restart cycles because
// the fresh session went straight into a 30-70 min continuation turn and the
// router only delivers to an idle pane.
//
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const wrapMock = vi.hoisted(() => ({
  classifyAgentMessage: vi.fn(),
  wrapAgentMessageForDelivery: vi.fn(),
}))
vi.mock('../web/agent-message-wrap.js', () => wrapMock)

const sysdirMock = vi.hoisted(() => ({ sendSystemDirective: vi.fn() }))
vi.mock('../web/system-directive.js', () => sysdirMock)

const dbMock = vi.hoisted(() => ({
  getPendingMessages: vi.fn(),
  markMessageDelivered: vi.fn((_id: number) => true),
  countNewerMessagesFromSameSender: vi.fn(() => 0),
  createAgentMessage: vi.fn(),
  getMessageStatus: vi.fn(),
  markMessageFailed: vi.fn(() => true),
}))
vi.mock('../db.js', () => dbMock)

const agentProcessMock = vi.hoisted(() => ({ sendPromptToSession: vi.fn() }))
vi.mock('../web/agent-process.js', () => agentProcessMock)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../config.js', () => ({ MAIN_AGENT_ID: 'main-agent' }))

import {
  RESUME_DRAIN_MAX,
  selectDrainableRows,
  sendResumeWithDrain,
} from '../web/resume-queue-drain.js'

// Minimal AgentMessage fixtures: only the fields the drain reads.
function row(over: Partial<Record<string, unknown>> & { id: number }): Record<string, unknown> {
  return {
    from_agent: 'peer',
    to_agent: 'rcpt',
    content: `CONTENT-${over.id}`,
    urgent: 0,
    stop_authorized: 0,
    created_at: Math.floor(Date.now() / 1000) - 60,
    origin_note: null,
    ...over,
  }
}

afterEach(() => { vi.unstubAllEnvs() })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('ROUTER_BATCH_INJECT_AGENTS', '*')
  vi.stubEnv('ROUTER_BATCH_INJECT_MAX', '50')
  dbMock.markMessageDelivered.mockReturnValue(true)
  dbMock.countNewerMessagesFromSameSender.mockReturnValue(0)
  // Default classification: an ordinary trusted inter-agent row.
  wrapMock.classifyAgentMessage.mockImplementation(
    (from: string) => ({ category: 'trusted-peer', safeFrom: from }),
  )
  // Envelope stub: the drain must reuse the REAL wrapper in production; here
  // the stub makes the row's identity visible in the composed attachment.
  wrapMock.wrapAgentMessageForDelivery.mockImplementation(
    (_cat: unknown, _safeFrom: unknown, from: string, content: string, id?: number) => ({
      prefix: `[ENV ${id} @${from}] `,
      wrapped: `<${content}>`,
    }),
  )
})

describe('selectDrainableRows (pure filter)', () => {
  it('keeps plain inter-agent rows in ascending id order and drops urgent, STOP and channel-inbound rows', () => {
    const rows = [
      row({ id: 202, content: 'PLAIN-BETA' }),
      row({ id: 201, content: 'PLAIN-ALPHA' }),
      row({ id: 203, content: 'URGENT-ROW', urgent: 1 }),
      row({ id: 204, content: '[STOP] abortion now', from_agent: 'main-agent', stop_authorized: 1 }),
      row({ id: 205, content: 'USER-CHAT', from_agent: 'telegram-shadow' }),
    ]
    wrapMock.classifyAgentMessage.mockImplementation(
      (from: string) => (from === 'telegram-shadow'
        ? { category: 'channel-inbound', safeFrom: from }
        : { category: 'trusted-peer', safeFrom: from }),
    )
    const out = selectDrainableRows(rows as never, 'main-agent')
    expect(out.map((m: { id: number }) => m.id)).toEqual([201, 202])
  })

  it('drops a row whose classification is null (invalid sender) instead of failing', () => {
    wrapMock.classifyAgentMessage.mockReturnValue(null)
    const out = selectDrainableRows([row({ id: 301 })] as never, 'main-agent')
    expect(out).toEqual([])
  })
})

describe('sendResumeWithDrain (wiring)', () => {
  it('with an empty pending queue behaves exactly like the plain directive send: no attachment, no marking', async () => {
    dbMock.getPendingMessages.mockReturnValue([])
    sysdirMock.sendSystemDirective.mockResolvedValue('sent')
    const out = await sendResumeWithDrain('rcpt', 'agent-rcpt', 'RESUME TEXT', null, { onBusyTimeout: 'abort' })
    expect(out).toBe('sent')
    expect(sysdirMock.sendSystemDirective).toHaveBeenCalledTimes(1)
    const call = sysdirMock.sendSystemDirective.mock.calls[0]
    expect(call[0]).toBe('rcpt')
    expect(call[1]).toBe('agent-rcpt')
    expect(call[2]).toBe('RESUME TEXT')
    expect(call[3]).toBe(null)
    expect(call[4]).toEqual({ onBusyTimeout: 'abort' })
    expect(dbMock.markMessageDelivered).not.toHaveBeenCalled()
  })

  it('drains the pending rows into the attachment, keeps the directive body clean, and marks the rows delivered only after a sent outcome', async () => {
    dbMock.getPendingMessages.mockReturnValue([
      row({ id: 102, content: 'DRAIN-BETA' }),
      row({ id: 101, content: 'DRAIN-ALPHA' }),
      row({ id: 103, content: 'URGENT-GAMMA', urgent: 1 }),
    ])
    sysdirMock.sendSystemDirective.mockResolvedValue('sent')
    const out = await sendResumeWithDrain('rcpt', 'agent-rcpt', 'RESUME TEXT', null, {})
    expect(out).toBe('sent')
    expect(sysdirMock.sendSystemDirective).toHaveBeenCalledTimes(1)
    const call = sysdirMock.sendSystemDirective.mock.calls[0]
    // The directive TEXT stays exactly the caller's prompt: the drained rows
    // ride in opts.attachBeforeDirective, never inside the anchor row content.
    expect(call[2]).toBe('RESUME TEXT')
    const attach = call[4]?.attachBeforeDirective
    expect(typeof attach).toBe('string')
    expect(attach as string).toContain('[KOTEG: 2 uzenet')
    expect(attach as string).toContain('DRAIN-ALPHA')
    expect(attach as string).toContain('DRAIN-BETA')
    expect(attach as string).not.toContain('URGENT-GAMMA')
    // Per-row freshness must be computed by the drain for every drained row.
    expect(dbMock.countNewerMessagesFromSameSender).toHaveBeenCalledTimes(2)
    // Delivered marking happens for exactly the drained ids, ascending,
    // AFTER the send resolved.
    const markCalls = dbMock.markMessageDelivered.mock.calls.map((c) => c[0])
    expect(markCalls).toEqual([101, 102])
    const sendOrder = sysdirMock.sendSystemDirective.mock.invocationCallOrder[0]
    for (const mc of dbMock.markMessageDelivered.mock.invocationCallOrder) {
      expect(mc).toBeGreaterThan(sendOrder)
    }
  })

  it('on a non-sent outcome the rows stay pending: no delivered marking at all', async () => {
    dbMock.getPendingMessages.mockReturnValue([row({ id: 111, content: 'DRAIN-KEEP' })])
    sysdirMock.sendSystemDirective.mockResolvedValue('aborted-busy')
    const out = await sendResumeWithDrain('rcpt', 'agent-rcpt', 'RESUME TEXT', null, { onBusyTimeout: 'abort' })
    expect(out).toBe('aborted-busy')
    expect(sysdirMock.sendSystemDirective.mock.calls[0][4]?.attachBeforeDirective).toContain('DRAIN-KEEP')
    expect(dbMock.markMessageDelivered).not.toHaveBeenCalled()
  })

  it('drains only the lowest id in serial format when the recipient is not listed', async () => {
    vi.stubEnv('ROUTER_BATCH_INJECT_AGENTS', 'some-other-agent')
    dbMock.getPendingMessages.mockReturnValue([row({ id: 303 }), row({ id: 301 }), row({ id: 302 })])
    sysdirMock.sendSystemDirective.mockResolvedValue('sent')
    await sendResumeWithDrain('rcpt', 'agent-rcpt', 'RESUME TEXT')
    const attach = sysdirMock.sendSystemDirective.mock.calls[0][4]?.attachBeforeDirective
    expect(attach).toBe('[ENV 301 @peer] <CONTENT-301>')
    expect(attach).not.toContain('[KOTEG')
    expect(wrapMock.wrapAgentMessageForDelivery).toHaveBeenCalledTimes(1)
    expect(dbMock.markMessageDelivered).toHaveBeenCalledExactlyOnceWith(301)
  })

  it('honours the rollout batch cap and announces the remaining rows', async () => {
    vi.stubEnv('ROUTER_BATCH_INJECT_MAX', '3')
    dbMock.getPendingMessages.mockReturnValue(Array.from({ length: 5 }, (_, i) => row({ id: 401 + i })))
    sysdirMock.sendSystemDirective.mockResolvedValue('sent')
    await sendResumeWithDrain('rcpt', 'agent-rcpt', 'RESUME TEXT')
    const attach = sysdirMock.sendSystemDirective.mock.calls[0][4]?.attachBeforeDirective
    expect(attach).toContain('[KOTEG: 3 uzenet')
    expect(attach).toContain('[KOTEG-VEGE: 3 uzenet ment ki ebben az injektalasban, 2 tovabbi VAR')
    expect(attach).not.toContain('CONTENT-404')
    expect(dbMock.markMessageDelivered.mock.calls.map(([id]) => id)).toEqual([401, 402, 403])
  })

  it('matches listed recipients case-insensitively', async () => {
    vi.stubEnv('ROUTER_BATCH_INJECT_AGENTS', 'RCPT')
    dbMock.getPendingMessages.mockReturnValue([row({ id: 451 }), row({ id: 452 })])
    sysdirMock.sendSystemDirective.mockResolvedValue('sent')
    await sendResumeWithDrain('rcpt', 'agent-rcpt', 'RESUME TEXT')
    expect(sysdirMock.sendSystemDirective.mock.calls[0][4]?.attachBeforeDirective).toContain('[KOTEG: 2 uzenet')
    expect(dbMock.markMessageDelivered.mock.calls.map(([id]) => id)).toEqual([451, 452])
  })

  it('caps the drain at RESUME_DRAIN_MAX rows and announces the remainder in the batch tail', async () => {
    const total = RESUME_DRAIN_MAX + 4
    const rows = Array.from({ length: total }, (_, i) => row({ id: 500 + i, content: `CAP-${String(i).padStart(2, '0')}` }))
    dbMock.getPendingMessages.mockReturnValue(rows)
    sysdirMock.sendSystemDirective.mockResolvedValue('sent')
    await sendResumeWithDrain('rcpt', 'agent-rcpt', 'RESUME TEXT', null, {})
    const attach = sysdirMock.sendSystemDirective.mock.calls[0][4]?.attachBeforeDirective as string
    expect(attach).toContain(`[KOTEG: ${RESUME_DRAIN_MAX} uzenet`)
    expect(attach).toContain(`${4} tovabbi`)
    for (let i = 0; i < RESUME_DRAIN_MAX; i++) expect(attach).toContain(`CAP-${String(i).padStart(2, '0')}`)
    expect(dbMock.markMessageDelivered).toHaveBeenCalledTimes(RESUME_DRAIN_MAX)
  })
})

describe('sendSystemDirective attachBeforeDirective (anchor row stays clean)', () => {
  it('places the attachment before the directive header and keeps it out of the anchor row content', async () => {
    const real = await vi.importActual<typeof import('../web/system-directive.js')>('../web/system-directive.js')
    dbMock.createAgentMessage.mockReturnValue({ id: 777 })
    agentProcessMock.sendPromptToSession.mockResolvedValue('sent')
    const out = await real.sendSystemDirective('rcpt', 'agent-rcpt', 'DIRECTIVE BODY', null, {
      attachBeforeDirective: 'ATTACH-BLOCK',
    })
    expect(out).toBe('sent')
    // The queue anchor row carries the directive body ONLY.
    expect(dbMock.createAgentMessage).toHaveBeenCalledWith('system', 'rcpt', 'DIRECTIVE BODY')
    // The directive header and body end the injection.
    const text = agentProcessMock.sendPromptToSession.mock.calls[0][1] as unknown as string
    expect(text).toContain('msg_id:777')
    expect(text).toContain('DIRECTIVE BODY')
    expect(text).toContain('ATTACH-BLOCK')
    const envelope = real.systemDirectiveEnvelope(777)
    expect(text).toBe(`ATTACH-BLOCK\n\n${envelope}\nDIRECTIVE BODY`)
    expect(text.endsWith(`${envelope}\nDIRECTIVE BODY`)).toBe(true)
    expect(text.indexOf('ATTACH-BLOCK')).toBeLessThan(text.indexOf(envelope))
  })
})
