import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

// The owner notification used to go out over Telegram unconditionally. On an
// install that speaks another provider there is no TELEGRAM_BOT_TOKEN, so the
// branch logged a warning and returned -- the owner was told nothing about an
// approval request, while the main agent (often the requester itself) was.
// These tests pin the provider-agnostic path.

const sent: string[] = []
vi.mock('../notify.js', () => ({
  notifyChannel: async (text: string) => { sent.push(text) },
  notifyTelegram: async () => {},
  notifySecurityEvent: async () => {},
}))

const telegramSends: unknown[] = []
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: async (...args: unknown[]) => { telegramSends.push(args); return 42 },
}))

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return {
    ...real,
    MAIN_AGENT_ID: 'fo-agens',
    // A Discord install: no Telegram token, a channel token and chat that do exist.
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

async function kerest(agentId: string) {
  const { ctx, out } = fakePost('/api/approvals', {
    agent_id: agentId,
    category: 'email_send',
    action_description: 'proba',
    timeout_seconds: 600,
  })
  await tryHandleApprovals(ctx)
  // notifyOwner is fire-and-forget; let the microtask queue drain.
  await new Promise((r) => setTimeout(r, 0))
  return out
}

describe('approval owner notification uses the CONFIGURED channel', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    sent.length = 0
    telegramSends.length = 0
  })

  it('reaches the owner on a non-Telegram install', async () => {
    const out = await kerest('valamelyik-agens')
    expect(out.status).toBe(201)
    // The regression this pins: before the fix `sent` stayed empty here,
    // because the only path out was Telegram.
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('valamelyik-agens')
  })

  it('does NOT fall back to Telegram when the provider is not Telegram', async () => {
    await kerest('valamelyik-agens')
    expect(telegramSends.length).toBe(0)
  })

  it('notifies the owner for a request from the MAIN agent too', async () => {
    // The in-band fallback only fires for main-agent requests, so before the
    // fix this was the one case that left any trace at all -- in the main
    // agent's own queue, never with the owner.
    const out = await kerest('fo-agens')
    expect(out.status).toBe(201)
    expect(sent.length).toBe(1)
  })

  it('names the requesting agent and the category in the text', async () => {
    await kerest('design')
    expect(sent[0]).toContain('design')
    expect(sent[0]).toContain('email_send')
  })
})
