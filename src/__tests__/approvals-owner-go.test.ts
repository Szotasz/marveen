// bc7c1e9d: an email_send request of the main agent that
// cites a written owner GO must not ping the owner a second time. Every other
// request still notifies the owner, unchanged. The reference silences only the
// ping: the request stays pending, and the one-shot hash gate is untouched.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const telegram = vi.hoisted(() => ({ sends: [] as Array<{ chatId: string; text: string }> }))

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'agent-main', TELEGRAM_BOT_TOKEN: 'test-token' }
})
vi.mock('../owner-chat.js', () => ({ resolveOwnerChatId: () => '111' }))
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async (_token: string, chatId: string, text: string) => {
    telegram.sends.push({ chatId, text })
    return 42
  }),
}))

import { initDatabase, getApproval, getPendingMessages } from '../db.js'
import { ownerGoCoversRequest, tryHandleApprovals } from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'

function fakePost(body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL('http://localhost:3420/api/approvals')
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path: url.pathname, method: 'POST', url } as RouteContext, out }
}

async function post(body: Record<string, unknown>) {
  const { ctx, out } = fakePost({ action_description: 'Levél a vevőnek: ajánlat', ...body })
  expect(await tryHandleApprovals(ctx)).toBe(true)
  // notifyOwner is fire-and-forget: let its promise chain settle before counting.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return out
}

describe('bc7c1e9d: a cited owner GO silences only the owner ping of the main agent email_send', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    telegram.sends.length = 0
  })

  it('main agent + email_send + owner_go_ref: no owner Telegram, the reference is stored, the request stays pending', async () => {
    const out = await post({ agent_id: 'agent-main', category: 'email_send', owner_go_ref: 'tesztelek-tg-101', content_hash: 'a'.repeat(64) })
    expect(out.status).toBe(201)
    expect(telegram.sends).toHaveLength(0)
    const row = getApproval(out.body.id)!
    expect(row.owner_go_ref).toBe('tesztelek-tg-101')
    expect(row.status).toBe('pending')
    expect(row.consumed_at).toBeNull()
    expect(row.content_hash).toBe('a'.repeat(64))
  })

  it('CONTROL: the same request without the reference pings the owner (the harness can see a send)', async () => {
    const out = await post({ agent_id: 'agent-main', category: 'email_send', content_hash: 'a'.repeat(64) })
    expect(out.status).toBe(201)
    expect(telegram.sends).toHaveLength(1)
    expect(telegram.sends[0].chatId).toBe('111')
    expect(telegram.sends[0].text).toContain('[JÓVÁHAGYÁS KELL] agent-main | email_send')
    expect(getApproval(out.body.id)!.owner_go_ref).toBeNull()
  })

  it('NEGATIVE: a sub-agent email_send still pings the owner and the main agent, with or without a reference', async () => {
    for (const extra of [{}, { owner_go_ref: 'tesztelek-tg-101' }]) {
      initDatabase(':memory:')
      telegram.sends.length = 0
      const out = await post({ agent_id: 'agent-sub', category: 'email_send', ...extra })
      expect(out.status).toBe(201)
      expect(telegram.sends).toHaveLength(1)
      expect(getApproval(out.body.id)!.owner_go_ref).toBeNull()
      expect(getPendingMessages('agent-main').map((m) => m.content).join('\n')).toContain(`id=${out.body.id}`)
    }
  })

  it('NEGATIVE: a main agent request of any other category still pings, and the reference is not stored', async () => {
    const out = await post({ agent_id: 'agent-main', category: 'skill_patch', owner_go_ref: 'tesztelek-tg-101' })
    expect(out.status).toBe(201)
    expect(telegram.sends).toHaveLength(1)
    expect(getApproval(out.body.id)!.owner_go_ref).toBeNull()
  })

  it('a malformed reference is rejected, not stored and not honoured', async () => {
    for (const bad of [101, '', '   ', 'tesztélek-tg-101', 'tesztelek tg 101', '-tg-101', 'x'.repeat(121), 'a\nb']) {
      const out = await post({ agent_id: 'agent-main', category: 'email_send', owner_go_ref: bad })
      expect(out.status, JSON.stringify(bad)).toBe(400)
      expect(out.body.error).toMatch(/owner_go_ref/)
    }
    expect(telegram.sends).toHaveLength(0)
    const ok = await post({ agent_id: 'agent-main', category: 'email_send', owner_go_ref: ' mintamari-tg-102 ' })
    expect(getApproval(ok.body.id)!.owner_go_ref).toBe('mintamari-tg-102')
  })

  it('ownerGoCoversRequest: all three conditions, none alone', () => {
    const base = { agent_id: 'agent-main', category: 'email_send', owner_go_ref: 'peldapal-tg-103' }
    expect(ownerGoCoversRequest(base)).toBe(true)
    expect(ownerGoCoversRequest({ ...base, agent_id: 'agent-sub' })).toBe(false)
    expect(ownerGoCoversRequest({ ...base, category: 'skill_patch' })).toBe(false)
    expect(ownerGoCoversRequest({ ...base, owner_go_ref: null })).toBe(false)
    expect(ownerGoCoversRequest({ ...base, owner_go_ref: '' })).toBe(false)
  })
})
