// Runtime belt for the 08fff6ba caller-opts narrowing of sendResumeWithDrain:
// the drain owns opts.attachBeforeDirective when there are drainable rows, so a
// caller-supplied value is overridden by the drain's own attachment and is
// never forwarded as-is -- while every other caller opt (here onBusyTimeout)
// survives untouched. The Omit<> on SendPromptOpts makes passing the key a
// compile error; this test pins the runtime behaviour for call sites that
// bypass the types anyway (JS callers, any-casts, older builds).
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

import { sendResumeWithDrain } from '../web/resume-queue-drain.js'

// Minimal AgentMessage fixtures: only the fields the drain reads.
function row(over: Partial<Record<string, unknown>> & { id: number }): Record<string, unknown> {
  return {
    from_agent: 'vega',
    to_agent: 'orion',
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
  // Envelope stub: makes the row's identity visible in the composed attachment.
  wrapMock.wrapAgentMessageForDelivery.mockImplementation(
    (_cat: unknown, _safeFrom: unknown, from: string, content: string, id?: number) => ({
      prefix: `[ENV ${id} @${from}] `,
      wrapped: `<${content}>`,
    }),
  )
})

describe('sendResumeWithDrain caller opts (08fff6ba)', () => {
  it('overrides a caller-supplied attachBeforeDirective with the drain attachment and keeps the rest of the caller opts', async () => {
    dbMock.getPendingMessages.mockReturnValue([row({ id: 4101, content: 'CALLER-OPTS-ROW' })])
    sysdirMock.sendSystemDirective.mockResolvedValue('sent')
    // The Omit<> on SendPromptOpts makes passing attachBeforeDirective a compile
    // error on purpose. The @ts-expect-error pins that under tsc --noEmit (it
    // turns into an "unused directive" error if the key ever becomes legal
    // again), while the call itself is the runtime belt for callers that bypass
    // the types (JS call sites, any-casts, older builds). Only the forbidden key
    // is exempted: onBusyTimeout stays type-checked.
    const out = await sendResumeWithDrain('orion', 'agent-orion', 'RESUME TEXT', null, {
      onBusyTimeout: 'abort',
      // @ts-expect-error -- attachBeforeDirective is omitted from SendPromptOpts
      attachBeforeDirective: 'CALLER-SUPPLIED-ATTACH',
    })
    expect(out).toBe('sent')
    expect(sysdirMock.sendSystemDirective).toHaveBeenCalledTimes(1)
    const forwarded = sysdirMock.sendSystemDirective.mock.calls[0][4] as Record<string, unknown>
    const attach = forwarded.attachBeforeDirective as string
    // The drain's own attachment wins: the drained row is in it, the caller's
    // value is never forwarded as-is.
    expect(attach).toContain('CALLER-OPTS-ROW')
    expect(attach).not.toContain('CALLER-SUPPLIED-ATTACH')
    // The drain overrides ONLY the attachment key: the rest of the caller
    // opts survive the forwarding untouched.
    expect(forwarded.onBusyTimeout).toBe('abort')
    // A 'sent' outcome marks exactly the drained row delivered.
    expect(dbMock.markMessageDelivered).toHaveBeenCalledTimes(1)
    expect(dbMock.markMessageDelivered).toHaveBeenCalledWith(4101)
  })
})
