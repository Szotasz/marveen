import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, listAgentMessages } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

// PR1655 review, ask 3: the two pre-checks in notifyOwner (no token, no owner
// chat) could be deleted without a single test going red, and ask 2's failure
// branch was UNREACHABLE on a non-Telegram install -- the funnel swallowed
// every provider exception, so a failed Discord send looked like a delivered
// notification. These tests pin the send-result branches (delivered,
// send-failed, partial) by OBSERVABLE behaviour (the in-band message to the
// main agent), not by reading source. The no-token / no-owner-chat branches,
// and the Telegram branch, are in approvals-owner-notify-branches.test.ts.

// The in-band fallback writes a real row through db.createAgentMessage, so the
// test reads it back from the in-memory database instead of mocking it: that
// way the assertion covers the path the route actually takes.
// The channel sender is the unit under test's dependency: each case decides
// what it reports back.
let sendResult: { sent: boolean; reason?: string } = { sent: true }
const sent: string[] = []
vi.mock('../notify.js', () => ({
  sendOwnerMessage: async (text: string) => { sent.push(text); return sendResult },
  notifyChannel: async (text: string) => { sent.push(text) },
  notifyTelegram: async () => {},
  notifySecurityEvent: async () => {},
}))

vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: async () => 42,
}))

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return {
    ...real,
    MAIN_AGENT_ID: 'fo-agens',
    TELEGRAM_BOT_TOKEN: '',
    CHANNEL_PROVIDER: 'discord',
    CHANNEL_TOKEN: 'discord-token',
    CHANNEL_CHAT_ID: '1551541958927978526',
  }
})

const { tryHandleApprovals } = await import('../web/routes/approvals.js')

function fakePost(path: string, body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path: url.pathname, method: 'POST', url } as RouteContext, out }
}

/** The in-band fallback rows, as the main agent would receive them. */
function ownerUnreached(): string[] {
  return listAgentMessages(100)
    .map((m) => m.content)
    .filter((c) => c.includes('[OWNER_UNREACHED'))
}

async function kerest(agentId = 'fo-agens') {
  const { ctx, out } = fakePost('/api/approvals', {
    agent_id: agentId,
    category: 'email_send',
    action_description: 'proba',
    timeout_seconds: 600,
  })
  await tryHandleApprovals(ctx)
  await new Promise((r) => setTimeout(r, 0))
  return out
}

describe('the owner-notify fallback fires on a FAILED send, not only on a missing config', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    sent.length = 0
    sendResult = { sent: true }
  })

  it('a delivered send leaves NO in-band fallback', async () => {
    const out = await kerest()
    expect(out.status).toBe(201)
    expect(sent.length).toBe(1)
    expect(ownerUnreached()).toHaveLength(0)
  })

  // This is the case that was unreachable before: the provider accepted the
  // call and then failed. Without the reported result the route logged
  // "notification sent" and the owner heard nothing.
  it('a send that FAILS falls back in band', async () => {
    sendResult = { sent: false, reason: 'send-failed' }
    const out = await kerest()
    expect(out.status).toBe(201)
    expect(sent.length).toBe(1)
    const fallbacks = ownerUnreached()
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toContain('email_send')
    expect(fallbacks[0]).toContain('send-failed')
  })

  it('a PARTIAL send also falls back: half a notification is not a notification', async () => {
    sendResult = { sent: false, reason: 'partial' }
    await kerest()
    expect(ownerUnreached()).toHaveLength(1)
  })
})
