import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getApproval } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

// notified_at, the route half: the column is only worth something if the owner-notification path writes it exactly
// when the request left for the owner, on every channel branch, and never when it did not. approvals-row-carries-the-
// fact.test.ts pins the db function; this drives the real POST /api/approvals and reads the row back.

let slack: { attempted: boolean; sent: boolean; error?: string } = { attempted: true, sent: true }
let ownerSent: { sent: boolean; reason?: string } = { sent: true }
let telegramFails = false
vi.mock('../notify.js', () => ({
  sendOwnerSlackDm: async () => slack,
  sendOwnerMessage: async () => ownerSent,
  notifyChannel: async () => {},
  notifyTelegram: async () => {},
  notifySecurityEvent: async () => {},
}))

vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: async () => { if (telegramFails) throw new Error('telegram down'); return 42 },
}))

let provider = 'telegram'
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return {
    ...real,
    MAIN_AGENT_ID: 'main-agent',
    TELEGRAM_BOT_TOKEN: 'tg-token',
    get CHANNEL_PROVIDER() { return provider },
    CHANNEL_TOKEN: 'tg-token',
    CHANNEL_CHAT_ID: '100000001',
    DASHBOARD_PUBLIC_URL: 'https://dashboard.example.com/',
  }
})

vi.mock('../owner-chat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../owner-chat.js')>()
  return { ...real, resolveOwnerChatId: () => '100000001' }
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

async function request(): Promise<string> {
  const { ctx, out } = fakePost('/api/approvals', {
    agent_id: 'main-agent',
    category: 'email_send',
    action_description: 'Mail to x@example.com, subject: test',
    timeout_seconds: 600,
  })
  await tryHandleApprovals(ctx)
  await new Promise((r) => setTimeout(r, 0))
  expect(out.status).toBe(201)
  const id = out.body?.id ?? out.body?.approval?.id
  expect(typeof id).toBe('string')
  return id as string
}

const notifiedAt = (id: string) => getApproval(id)!.notified_at ?? null

describe('notified_at is stamped by the branch that delivered, and only then', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    slack = { attempted: true, sent: true }
    ownerSent = { sent: true }
    telegramFails = false
    provider = 'telegram'
  })

  it('Slack DM delivered: stamped', async () => {
    const id = await request()
    expect(notifiedAt(id)).toEqual(expect.any(Number))
  })

  it('Slack DM failed (falls back in band): stays NULL', async () => {
    slack = { attempted: true, sent: false, error: 'boom' }
    expect(notifiedAt(await request())).toBeNull()
  })

  it('Telegram branch delivered: stamped', async () => {
    slack = { attempted: false, sent: false }
    expect(notifiedAt(await request())).toEqual(expect.any(Number))
  })

  it('Telegram branch threw: stays NULL', async () => {
    slack = { attempted: false, sent: false }
    telegramFails = true
    expect(notifiedAt(await request())).toBeNull()
  })

  it('provider path (non-Telegram) delivered: stamped; not sent: stays NULL', async () => {
    slack = { attempted: false, sent: false }
    provider = 'discord'
    expect(notifiedAt(await request())).toEqual(expect.any(Number))
    ownerSent = { sent: false, reason: 'no-token' }
    expect(notifiedAt(await request())).toBeNull()
  })
})
