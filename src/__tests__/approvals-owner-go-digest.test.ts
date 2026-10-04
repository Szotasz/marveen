// bc7c1e9d (b): the main agent's GO-cited email_send requests do not ping one by one; a daily
// digest to the owner lists them (only on a day that had such a request). Every other request pings at once.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const telegram = vi.hoisted(() => ({ sends: [] as Array<{ chatId: string; text: string }>, failNext: false }))
const ownerChat = vi.hoisted(() => ({ id: '111' as string | null }))

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'agent-main', TELEGRAM_BOT_TOKEN: 'test-token' }
})
vi.mock('../owner-chat.js', () => ({ resolveOwnerChatId: () => ownerChat.id }))
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async (_token: string, chatId: string, text: string) => {
    if (telegram.failNext) {
      telegram.failNext = false
      throw new Error('telegram down')
    }
    telegram.sends.push({ chatId, text })
    return 77
  }),
}))

import { initDatabase, getPendingMessages, type Approval } from '../db.js'
import {
  budapestMidnightUtcMs, buildOwnerGoDigestText, ownerGoDigestDayDue, sendOwnerGoDigestIfDue, tryHandleApprovals,
  OWNER_GO_DIGEST_RETRY_MS,
} from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'

const SECRET_CONTENT = 'Levél a vevőnek: ajánlat 12 345 678 Ft'

async function post(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL('http://localhost:3420/api/approvals')
  const bodyStr = JSON.stringify({ action_description: SECRET_CONTENT, ...body })
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  expect(await tryHandleApprovals({ req, res, path: url.pathname, method: 'POST', url } as RouteContext)).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0)) // notifyOwner is fire-and-forget
  return out
}

const at = (iso: string) => vi.setSystemTime(new Date(iso))

describe('bc7c1e9d (b): pure parts of the daily owner digest', () => {
  it('Budapest midnight in UTC follows the DST offset', () => {
    expect(new Date(budapestMidnightUtcMs('2026-09-23')).toISOString()).toBe('2026-09-22T22:00:00.000Z')
    expect(new Date(budapestMidnightUtcMs('2026-12-01')).toISOString()).toBe('2026-11-30T23:00:00.000Z')
    expect(new Date(budapestMidnightUtcMs('2026-10-25')).toISOString()).toBe('2026-10-24T22:00:00.000Z')
    expect(new Date(budapestMidnightUtcMs('2026-10-26')).toISOString()).toBe('2026-10-25T23:00:00.000Z')
  })

  it('the digest is due from 07:00 Budapest, for the oldest unsettled day, at most 7 days back', () => {
    const t = (iso: string) => new Date(iso).getTime()
    expect(ownerGoDigestDayDue(t('2026-09-24T04:59:00Z'), null)).toBeNull() // 06:59 CEST
    expect(ownerGoDigestDayDue(t('2026-09-24T05:00:00Z'), null)).toBe('2026-09-23') // 07:00 CEST, first run
    expect(ownerGoDigestDayDue(t('2026-09-24T05:00:00Z'), '2026-09-23')).toBeNull()
    expect(ownerGoDigestDayDue(t('2026-09-24T05:00:00Z'), '2026-09-20')).toBe('2026-09-21')
    expect(ownerGoDigestDayDue(t('2026-09-24T05:00:00Z'), '2026-09-01')).toBe('2026-09-17')
    expect(ownerGoDigestDayDue(t('2026-12-02T05:59:00Z'), null)).toBeNull() // 06:59 CET
    expect(ownerGoDigestDayDue(t('2026-12-02T06:00:00Z'), null)).toBe('2026-12-01')
  })

  it('a row shows time, requester, category, hash prefix, GO and state, never the content', () => {
    const base = {
      agent_id: 'agent-main', category: 'email_send', action_description: SECRET_CONTENT, action_payload: null,
      timeout_at: null, telegram_message_id: null, resolved_at: null, resolved_by: null, owner_go_ref: 'tesztelek-tg-101',
    }
    const rows: Approval[] = [
      { ...base, id: 'a1', status: 'pending', requested_at: Date.parse('2026-09-23T11:05:00Z') / 1000, content_hash: 'a'.repeat(64), consumed_at: null },
      { ...base, id: 'a2', status: 'approved', requested_at: Date.parse('2026-09-23T11:20:00Z') / 1000, content_hash: 'b'.repeat(64), consumed_at: 1 },
      { ...base, id: 'a3', status: 'approved', requested_at: Date.parse('2026-09-23T11:27:00Z') / 1000, content_hash: null, consumed_at: null },
    ]
    const text = buildOwnerGoDigestText('2026-09-23', rows)
    expect(text.split('\n')[0]).toBe('[NAPI ÖSSZESÍTŐ] 2026-09-23: a fő ügynök 3 email-jóváhagyási kérése meglévő tulajdonosi GO-ra hivatkozott')
    expect(text).toContain('13:05 | agent-main | email_send | boríték aaaaaaaaaaaa | GO: tesztelek-tg-101 | függőben')
    expect(text).toContain('13:20 | agent-main | email_send | boríték bbbbbbbbbbbb | GO: tesztelek-tg-101 | felhasználva')
    expect(text).toContain('13:27 | agent-main | email_send | boríték - | GO: tesztelek-tg-101 | jóváhagyva')
    expect(text).not.toContain('ajánlat')
    expect(text).not.toContain('a'.repeat(13))
  })
})

describe('bc7c1e9d (b): immediate pings and the daily digest, end to end', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    telegram.sends.length = 0
    telegram.failNext = false
    ownerChat.id = '111'
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => vi.useRealTimers())

  it('NEGATÍV: a sub-agent and a GO-less main-agent request ping at once; a GO-cited one waits for the digest', async () => {
    at('2026-09-23T11:05:00Z')
    await post({ agent_id: 'agent-main', category: 'email_send', owner_go_ref: 'tesztelek-tg-101', content_hash: 'a'.repeat(64) })
    expect(telegram.sends).toHaveLength(0)
    await post({ agent_id: 'agent-b', category: 'email_send', owner_go_ref: 'tesztelek-tg-101', content_hash: 'c'.repeat(64) })
    await post({ agent_id: 'agent-main', category: 'email_send', content_hash: 'd'.repeat(64) })
    expect(telegram.sends.map((s) => s.text.split('\n')[0])).toEqual([
      '[JÓVÁHAGYÁS KELL] agent-b | email_send',
      '[JÓVÁHAGYÁS KELL] agent-main | email_send',
    ])

    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-24T04:59:00Z'))).toBe('none')
    expect(telegram.sends).toHaveLength(2)
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-24T05:01:00Z'))).toBe('telegram')
    expect(telegram.sends).toHaveLength(3)
    const digest = telegram.sends[2]
    expect(digest.chatId).toBe('111')
    const lines = digest.text.split('\n')
    expect(lines[0]).toBe('[NAPI ÖSSZESÍTŐ] 2026-09-23: a fő ügynök 1 email-jóváhagyási kérése meglévő tulajdonosi GO-ra hivatkozott')
    expect(lines.filter((l) => l.includes(' | GO: '))).toEqual(['13:05 | agent-main | email_send | boríték aaaaaaaaaaaa | GO: tesztelek-tg-101 | függőben'])
    expect(digest.text).not.toContain('ajánlat')

    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-24T09:00:00Z'))).toBe('none')
    expect(telegram.sends).toHaveLength(3)
  })

  it('NEGATÍV: an empty day is settled without a message', async () => {
    at('2026-09-23T11:05:00Z')
    await post({ agent_id: 'agent-b', category: 'email_send', content_hash: 'c'.repeat(64) })
    expect(telegram.sends).toHaveLength(1)
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-24T05:01:00Z'))).toBe('empty')
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-24T05:02:00Z'))).toBe('none')
    expect(telegram.sends).toHaveLength(1)
  })

  it('a request just before Budapest midnight belongs to that day, one just after to the next', async () => {
    at('2026-09-23T21:59:00Z') // 23:59 CEST, 09-23
    await post({ agent_id: 'agent-main', category: 'email_send', owner_go_ref: 'mintamari-tg-1', content_hash: 'e'.repeat(64) })
    at('2026-09-23T22:01:00Z') // 00:01 CEST, 09-24
    await post({ agent_id: 'agent-main', category: 'email_send', owner_go_ref: 'mintamari-tg-2', content_hash: 'f'.repeat(64) })
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-24T05:01:00Z'))).toBe('telegram')
    expect(telegram.sends.at(-1)!.text).toContain('GO: mintamari-tg-1')
    expect(telegram.sends.at(-1)!.text).not.toContain('GO: mintamari-tg-2')
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-25T05:01:00Z'))).toBe('telegram')
    expect(telegram.sends.at(-1)!.text).toContain('GO: mintamari-tg-2')
  })

  it('without an owner chat the digest goes in-band to the main agent and the day is settled', async () => {
    at('2026-09-23T11:05:00Z')
    await post({ agent_id: 'agent-main', category: 'email_send', owner_go_ref: 'peldapal-tg-9', content_hash: 'a'.repeat(64) })
    ownerChat.id = null
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-24T05:01:00Z'))).toBe('in_band')
    expect(telegram.sends).toHaveLength(0)
    const inBand = getPendingMessages('agent-main').filter((m) => m.content.startsWith('[OWNER_UNREACHED owner-go-digest]'))
    expect(inBand).toHaveLength(1)
    expect(inBand[0].content).toContain('GO: peldapal-tg-9')
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-24T05:02:00Z'))).toBe('none')
  })

  it('a failed send is not settled: retried after the backoff, not on every tick', async () => {
    at('2026-09-23T11:05:00Z')
    await post({ agent_id: 'agent-main', category: 'email_send', owner_go_ref: 'tesztelek-tg-101', content_hash: 'a'.repeat(64) })
    telegram.failNext = true
    const t0 = Date.parse('2026-09-24T05:01:00Z')
    expect(await sendOwnerGoDigestIfDue(t0)).toBe('failed')
    expect(await sendOwnerGoDigestIfDue(t0 + 60_000)).toBe('none')
    expect(await sendOwnerGoDigestIfDue(t0 + OWNER_GO_DIGEST_RETRY_MS)).toBe('telegram')
    expect(telegram.sends).toHaveLength(1)
  })
})
