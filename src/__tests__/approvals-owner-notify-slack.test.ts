import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, listAgentMessages } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

// APPROVALSLACK1030 (owner, 2026-10-30: "Ne telegramon küldd a levél jóváhagyásokat!"). On an install whose owner
// moved to Slack (a NOTIFY_SLACK_TARGET) while the channel provider stays Telegram, both of that day's requests went
// out over the Telegram branch. These tests pin, by observable behaviour, that a Slack owner gets the request in the
// Slack DM, that Telegram and the provider path are never used then, and that a Slack miss falls back IN BAND.

let slack: { attempted: boolean; sent: boolean; error?: string } = { attempted: true, sent: true }
const slackTexts: string[] = []
const ownerSends: string[] = []
vi.mock('../notify.js', () => ({
  sendOwnerSlackDm: async (text: string) => { slackTexts.push(text); return slack },
  sendOwnerMessage: async (text: string) => { ownerSends.push(text); return { sent: true } },
  notifyChannel: async () => {},
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
    // The measured install: the provider is still Telegram, with a token and an owner chat.
    TELEGRAM_BOT_TOKEN: 'tg-token',
    CHANNEL_PROVIDER: 'telegram',
    CHANNEL_TOKEN: 'tg-token',
    CHANNEL_CHAT_ID: '1268077055',
    DASHBOARD_PUBLIC_URL: 'https://marveen.example.com/',
  }
})

vi.mock('../owner-chat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../owner-chat.js')>()
  return { ...real, resolveOwnerChatId: () => '1268077055' }
})

const { tryHandleApprovals, approvalsPageUrl } = await import('../web/routes/approvals.js')
const { setActiveApprovalBotForTest } = await import('../approval-bot.js')

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

function ownerUnreached(): string[] {
  return listAgentMessages(100).map((m) => m.content).filter((c) => c.includes('[OWNER_UNREACHED'))
}

async function kerest(agentId = 'fo-agens') {
  const { ctx, out } = fakePost('/api/approvals', {
    agent_id: agentId,
    category: 'email_send',
    action_description: 'Levél: x@example.com, tárgy: proba',
    timeout_seconds: 600,
  })
  await tryHandleApprovals(ctx)
  await new Promise((r) => setTimeout(r, 0))
  return out
}

describe('a Slack owner gets the approval request in the Slack DM, never on Telegram', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    slack = { attempted: true, sent: true }
    slackTexts.length = 0
    ownerSends.length = 0
    telegramSends.length = 0
  })

  it('delivered in the DM: no Telegram, no provider send, no in-band fallback; the text links the Approvals page', async () => {
    const out = await kerest()
    expect(out.status).toBe(201)
    expect(slackTexts).toHaveLength(1)
    expect(slackTexts[0]).toContain('[JÓVÁHAGYÁS KELL] fo-agens | email_send')
    expect(slackTexts[0]).toContain('https://marveen.example.com/#approvals')
    expect(telegramSends).toHaveLength(0)
    expect(ownerSends).toHaveLength(0)
    expect(ownerUnreached()).toHaveLength(0)
  })

  for (const [error, reason] of [['boom', 'send-failed'], ['no_slack_token', 'no-token'], ['unresolved_target:dm', 'no-owner-chat']] as const) {
    it(`a Slack miss (${error}) falls back in band as ${reason}, and Telegram still gets nothing`, async () => {
      slack = { attempted: true, sent: false, error }
      await kerest()
      expect(telegramSends).toHaveLength(0)
      expect(ownerSends).toHaveLength(0)
      const fallbacks = ownerUnreached()
      expect(fallbacks).toHaveLength(1)
      expect(fallbacks[0]).toContain(reason)
    })
  }

  // 2026-11-18: with a Slack target set, the paired approval bot never got a request. A paired bot is the owner's
  // later choice, so it goes first; unpaired, the Slack DM as before.
  for (const paired of [true, false]) {
    it(`approval bot on, ${paired ? 'paired: the bot carries it, Slack gets nothing' : 'unpaired: the Slack DM as before'}`, async () => {
      const botSends: unknown[] = []
      setActiveApprovalBotForTest({
        token: '1:' + 'a'.repeat(35), key: Buffer.alloc(32, 7), now: () => Math.floor(Date.now() / 1000),
        pairing: () => (paired ? { fromId: '1268077055', chatId: '1268077055' } : null),
        api: { async sendMessage(...a: unknown[]) { botSends.push(a); return 501 }, async editMessageText() {}, async answerCallbackQuery() {} },
      } as any)
      try {
        await kerest()
        expect(botSends).toHaveLength(paired ? 1 : 0)
        expect(slackTexts).toHaveLength(paired ? 0 : 1)
        expect(telegramSends).toHaveLength(0)
        expect(ownerUnreached()).toHaveLength(0)
      } finally { setActiveApprovalBotForTest(undefined) }
    })
  }

  it('no Slack target on the install: the provider path as before (here Telegram)', async () => {
    slack = { attempted: false, sent: false }
    await kerest()
    expect(telegramSends).toHaveLength(1)
  })

  it('the Approvals page: the public URL without a trailing slash, else this host', () => {
    expect(approvalsPageUrl('https://m.example.com//', 3420)).toBe('https://m.example.com/#approvals')
    expect(approvalsPageUrl('', 3421)).toBe('http://localhost:3421/#approvals')
    expect(approvalsPageUrl('  ', 3420)).toBe('http://localhost:3420/#approvals')
  })
})
