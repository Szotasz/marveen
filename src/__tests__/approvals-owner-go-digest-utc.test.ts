// ISSUE1895 (#1895), b606226d: the daily owner digest keeps the install zone (APP_TZ). The zone-dependent
// cases of approvals-owner-go-digest.test.ts (pinned to Europe/Budapest) on a UTC install, the zone this
// fleet runs in: the digest goes out from 07:00Z, its day is the UTC day, and the row times are UTC.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const telegram = vi.hoisted(() => ({ sends: [] as Array<{ chatId: string; text: string }> }))

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'agent-main', TELEGRAM_BOT_TOKEN: 'test-token', APP_TZ: 'UTC' }
})
vi.mock('../owner-chat.js', () => ({ resolveOwnerChatId: () => '111' }))
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async (_token: string, chatId: string, text: string) => {
    telegram.sends.push({ chatId, text })
    return 77
  }),
}))

import { initDatabase, type Approval } from '../db.js'
import {
  installMidnightUtcMs, buildOwnerGoDigestText, ownerGoDigestDayDue, ownerGoDigestDaysDue, sendOwnerGoDigestIfDue,
  tryHandleApprovals, _resetOwnerGoDigestStateForTest,
} from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'

async function post(body: Record<string, unknown>): Promise<number> {
  let status = 0
  const res: any = { writeHead(s: number) { status = s; return res }, end() {} }
  const url = new URL('http://localhost:3420/api/approvals')
  const bodyStr = JSON.stringify({ action_description: 'Levél a vevőnek', ...body })
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  expect(await tryHandleApprovals({ req, res, path: url.pathname, method: 'POST', url } as RouteContext)).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0)) // notifyOwner is fire-and-forget
  return status
}

const t = (iso: string) => new Date(iso).getTime()

describe('ISSUE1895: the owner digest on a UTC install (pure parts)', () => {
  it('the install-zone midnight is the UTC midnight, also on a European DST day', () => {
    expect(new Date(installMidnightUtcMs('2026-09-23')).toISOString()).toBe('2026-09-23T00:00:00.000Z')
    expect(new Date(installMidnightUtcMs('2026-10-25')).toISOString()).toBe('2026-10-25T00:00:00.000Z')
    expect(new Date(installMidnightUtcMs('2026-10-26')).toISOString()).toBe('2026-10-26T00:00:00.000Z')
  })

  it('the digest is due from 07:00Z, no longer from 07:00 Budapest (05:00Z in summer)', () => {
    expect(ownerGoDigestDayDue(t('2026-09-24T05:00:00Z'), null)).toBeNull()
    expect(ownerGoDigestDayDue(t('2026-09-24T06:59:00Z'), null)).toBeNull()
    expect(ownerGoDigestDayDue(t('2026-09-24T07:00:00Z'), null)).toBe('2026-09-23')
    expect(ownerGoDigestDayDue(t('2026-09-24T07:00:00Z'), '2026-09-20')).toBe('2026-09-21')
    expect(ownerGoDigestDaysDue(t('2026-10-04T06:59:00Z'), '2026-09-29')).toEqual([])
    expect(ownerGoDigestDaysDue(t('2026-10-04T07:01:00Z'), '2026-09-29')).toEqual(['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'])
  })

  it('a row shows its UTC time', () => {
    const row: Approval = {
      id: 'a1', agent_id: 'agent-main', category: 'email_send', action_description: 'x', action_payload: null,
      status: 'pending', requested_at: Date.parse('2026-09-23T11:05:00Z') / 1000, timeout_at: null,
      telegram_message_id: null, resolved_at: null, resolved_by: null, content_hash: 'a'.repeat(64), consumed_at: null,
      owner_go_ref: 'tesztelek-tg-101',
    }
    expect(buildOwnerGoDigestText([{ day: '2026-09-23', rows: [row] }]))
      .toContain('11:05 | agent-main | email_send | boríték aaaaaaaaaaaa | GO: tesztelek-tg-101 | függőben')
  })
})

describe('ISSUE1895: the owner digest on a UTC install, end to end', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    _resetOwnerGoDigestStateForTest()
    telegram.sends.length = 0
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => vi.useRealTimers())

  it('a request just before UTC midnight belongs to that day, one just after to the next; each goes out from 07:00Z', async () => {
    vi.setSystemTime(new Date('2026-09-23T23:59:00Z'))
    expect(await post({ agent_id: 'agent-main', category: 'email_send', owner_go_ref: 'mintamari-tg-1', content_hash: 'e'.repeat(64) })).toBe(201)
    vi.setSystemTime(new Date('2026-09-24T00:01:00Z'))
    expect(await post({ agent_id: 'agent-main', category: 'email_send', owner_go_ref: 'mintamari-tg-2', content_hash: 'f'.repeat(64) })).toBe(201)
    expect(telegram.sends).toHaveLength(0)

    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-24T05:01:00Z'))).toBe('none')
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-24T07:01:00Z'))).toBe('telegram')
    const first = telegram.sends.at(-1)!.text
    expect(first.split('\n')[0]).toBe('[NAPI ÖSSZESÍTŐ] 2026-09-23: a fő ügynök 1 email-jóváhagyási kérése meglévő tulajdonosi GO-ra hivatkozott')
    expect(first).toContain('23:59 | agent-main | email_send | boríték eeeeeeeeeeee | GO: mintamari-tg-1 | függőben')
    expect(first).not.toContain('GO: mintamari-tg-2')

    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-25T07:01:00Z'))).toBe('telegram')
    expect(telegram.sends.at(-1)!.text).toContain('00:01 | agent-main | email_send | boríték ffffffffffff | GO: mintamari-tg-2 | függőben')
  })
})
