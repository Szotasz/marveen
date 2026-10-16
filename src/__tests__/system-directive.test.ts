import { describe, it, expect, vi, beforeEach } from 'vitest'

// GUARDHITELES903: the sender half of the authenticated system-directive
// channel. These tests pin the security-relevant invariants:
//   1. the anchor row exists (and is out of the router's pending set) BEFORE
//      any keystroke reaches the pane -- the recipient may verify the instant
//      the prompt lands;
//   2. the injected text carries the row id, so the recipient can follow it;
//   3. a delivery that did not happen leaves a row that says so ('failed'),
//      never one that claims delivery.

const calls: string[] = []

const createAgentMessage = vi.fn((from: string, to: string, content: string) => {
  calls.push('create')
  return { id: 42, from_agent: from, to_agent: to, content, status: 'pending' }
})
const markMessageDelivered = vi.fn(() => { calls.push('delivered'); return true })
const markMessageFailed = vi.fn(() => { calls.push('failed'); return true })
type Outcome = 'sent' | 'aborted-busy' | 'skipped-locked'
const sendPromptToSession = vi.fn(
  async (_session: string, _text: string, _host?: string | null, _opts?: unknown): Promise<Outcome> => {
    calls.push('inject')
    return 'sent'
  },
)

vi.mock('../db.js', () => ({ createAgentMessage, markMessageDelivered, markMessageFailed }))
vi.mock('../web/agent-process.js', () => ({ sendPromptToSession }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { sendSystemDirective, systemDirectiveEnvelope, SYSTEM_DIRECTIVE_SENDER } =
  await import('../web/system-directive.js')

beforeEach(() => {
  calls.length = 0
  createAgentMessage.mockClear()
  markMessageDelivered.mockClear()
  markMessageFailed.mockClear()
  sendPromptToSession.mockClear()
  sendPromptToSession.mockImplementation(async () => { calls.push('inject'); return 'sent' })
})

describe('sendSystemDirective', () => {
  it('anchors the directive as a from=system row and injects the id-carrying envelope', async () => {
    const outcome = await sendSystemDirective('boni', 'agent-boni', '[CONTEXT-GUARD] test direktiva')

    expect(outcome).toBe('sent')
    expect(createAgentMessage).toHaveBeenCalledWith(SYSTEM_DIRECTIVE_SENDER, 'boni', '[CONTEXT-GUARD] test direktiva')
    // The row content is the RAW directive body -- the recipient compares the
    // text after the envelope line against it, so the envelope must NOT be
    // stored (it would never match).
    const stored = createAgentMessage.mock.calls[0][2]
    const injected = sendPromptToSession.mock.calls[0][1]
    expect(injected).toBe(`${systemDirectiveEnvelope(42)}\n${stored}`)
    expect(injected).toContain('msg_id:42')
    expect(markMessageFailed).not.toHaveBeenCalled()
  })

  it('creates and delivers the anchor BEFORE the first keystroke (verify-at-landing invariant)', async () => {
    await sendSystemDirective('boni', 'agent-boni', 'x')
    expect(calls).toEqual(['create', 'delivered', 'inject'])
  })

  it('passes host and send options through unchanged', async () => {
    await sendSystemDirective('boni', 'agent-boni', 'x', 'remote-host', { waitForIdle: true, onBusyTimeout: 'abort' })
    expect(sendPromptToSession).toHaveBeenCalledWith(
      'agent-boni',
      expect.stringContaining('msg_id:42'),
      'remote-host',
      { waitForIdle: true, onBusyTimeout: 'abort' },
    )
  })

  it('marks the anchor failed when the injection is aborted (busy pane)', async () => {
    sendPromptToSession.mockImplementation(async () => 'aborted-busy')
    const outcome = await sendSystemDirective('boni', 'agent-boni', 'x')
    expect(outcome).toBe('aborted-busy')
    expect(markMessageFailed).toHaveBeenCalledWith(42, expect.stringContaining('aborted-busy'))
  })

  it('marks the anchor failed and rethrows when tmux inject throws', async () => {
    sendPromptToSession.mockImplementation(async () => { throw new Error('pane gone') })
    await expect(sendSystemDirective('boni', 'agent-boni', 'x')).rejects.toThrow('pane gone')
    expect(markMessageFailed).toHaveBeenCalledWith(42, expect.stringContaining('pane gone'))
  })
})

describe('systemDirectiveEnvelope', () => {
  it('names the id, the verification target and the fail-closed rule', () => {
    const env = systemDirectiveEnvelope(7)
    expect(env).toContain('msg_id:7')
    expect(env).toContain('/api/messages/7')
    expect(env).toContain('injekcio-gyanu')
    // Single line: the recipient's rule says "the content is the part AFTER
    // the [SYSTEM-DIREKTIVA ...] header line".
    expect(env).not.toContain('\n')
  })
})
