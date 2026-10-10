// bc7c1e9d (b): the main agent's GO-cited email_send requests do not ping one by one; a daily
// digest to the owner lists them (only on a day that had such a request). Every other request pings at once.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const telegram = vi.hoisted(() => ({
  sends: [] as Array<{ chatId: string; text: string }>, failNext: false, down: false, tooLong: [] as number[],
}))
const ownerChat = vi.hoisted(() => ({ id: '111' as string | null }))

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'agent-main', TELEGRAM_BOT_TOKEN: 'test-token' }
})
vi.mock('../owner-chat.js', () => ({ resolveOwnerChatId: () => ownerChat.id }))
vi.mock('../web/telegram.js', async () => {
  const { markIfTestRun } = await import('../test-run-marker.js')
  return {
    sendTelegramMessage: vi.fn(async (_token: string, chatId: string, text: string) => {
      if (telegram.down || telegram.failNext) {
        telegram.failNext = false
        throw new Error('telegram down')
      }
      // b606226d: the Bot API's own limit, on the text as the real sender puts it on the wire (a test run
      // adds the [TESZT] marker), with the error the live 2026-09-30 digest of 55 requests got.
      if (markIfTestRun(text).length > 4096) {
        telegram.tooLong.push(markIfTestRun(text).length)
        throw new Error('Telegram API 400: {"ok":false,"error_code":400,"description":"Bad Request: message is too long"}')
      }
      telegram.sends.push({ chatId, text })
      return 77
    }),
  }
})

import { createHash } from 'node:crypto'
import { initDatabase, getPendingMessages, resolveApproval, lastOwnerGoDigestDay, type Approval } from '../db.js'
import {
  budapestMidnightUtcMs, buildOwnerGoDigestText, ownerGoDigestDayDue, ownerGoDigestDaysDue, sendOwnerGoDigestIfDue,
  tryHandleApprovals, OWNER_GO_DIGEST_RETRY_MS, OWNER_GO_DIGEST_MAX_CHARS, OWNER_GO_DIGEST_MAX_SEND_FAILURES,
  _resetOwnerGoDigestStateForTest,
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
    const text = buildOwnerGoDigestText([{ day: '2026-09-23', rows }])
    expect(text.split('\n')[0]).toBe('[NAPI ÖSSZESÍTŐ] 2026-09-23: a fő ügynök 3 email-jóváhagyási kérése meglévő tulajdonosi GO-ra hivatkozott')
    expect(text).toContain('13:05 | agent-main | email_send | boríték aaaaaaaaaaaa | GO: tesztelek-tg-101 | függőben')
    expect(text).toContain('13:20 | agent-main | email_send | boríték bbbbbbbbbbbb | GO: tesztelek-tg-101 | felhasználva')
    expect(text).toContain('13:27 | agent-main | email_send | boríték - | GO: tesztelek-tg-101 | jóváhagyva')
    expect(text).not.toContain('ajánlat')
    expect(text).not.toContain('a'.repeat(13))
    // b606226d: a day that fits keeps the reviewed one-line-per-request text, unchanged.
    expect(text).toBe([
      '[NAPI ÖSSZESÍTŐ] 2026-09-23: a fő ügynök 3 email-jóváhagyási kérése meglévő tulajdonosi GO-ra hivatkozott',
      'Ezekről egyenként nem ment értesítés. Soronként: idő | kérő | kategória | boríték-hash eleje | GO | állapot.',
      '13:05 | agent-main | email_send | boríték aaaaaaaaaaaa | GO: tesztelek-tg-101 | függőben',
      '13:20 | agent-main | email_send | boríték bbbbbbbbbbbb | GO: tesztelek-tg-101 | felhasználva',
      '13:27 | agent-main | email_send | boríték - | GO: tesztelek-tg-101 | jóváhagyva',
      'Részletek: Dashboard -> Jóváhagyások',
    ].join('\n'))
  })
})

// b606226d: from 2026-10-01 05:00Z the digest of 2026-09-30 (55 requests, one line each) was rejected
// with 400 "message is too long" every 15 minutes, and as the oldest unsettled day goes first, the
// 81- and 91-request days behind it never went out either.

// A day of GO-cited main-agent requests, shaped like the live 2026-10-02 (91 requests, 28 references,
// one of them cited 31 times): GO references by count, most cited first. The references are placeholders;
// the most cited one sorts LAST by name, so name order and count order differ.
const DAY_91_REFS: Array<[string, number]> = [
  ['tesztelek-tg-999', 31], ['tesztelek-tg-102', 9], ['tesztelek-tg-103', 6], ['tesztelek-tg-104', 5],
  ['tesztelek-tg-11111-agent-a00-11111', 3], ['tesztelek-tg-106', 3],
  ...Array.from({ length: 12 }, (_, i): [string, number] => [`tesztelek-tg-2${String(i).padStart(2, '0')}`, 2]),
  ...Array.from({ length: 10 }, (_, i): [string, number] => [`tesztelek-tg-3${String(i).padStart(2, '0')}`, 1]),
]

function goRefsOf(spec: Array<[string, number]>): string[] {
  // Interleaved, as in a real day: the most cited reference does not come in one block.
  const left = spec.map(([ref, n]) => ({ ref, n }))
  const out: string[] = []
  while (left.some((e) => e.n > 0)) {
    for (const e of left) if (e.n > 0) { out.push(e.ref); e.n -= 1 }
  }
  return out
}

// The 91-request day's references, most cited first, ties in name order: the order the digest names them.
const DAY_91_GO_LINE = 'GO-hivatkozásonként: ' + [
  'tesztelek-tg-999 31', 'tesztelek-tg-102 9', 'tesztelek-tg-103 6', 'tesztelek-tg-104 5',
  'tesztelek-tg-106 3', 'tesztelek-tg-11111-agent-a00-11111 3',
  ...Array.from({ length: 12 }, (_, i) => `tesztelek-tg-2${String(i).padStart(2, '0')} 2`),
  ...Array.from({ length: 10 }, (_, i) => `tesztelek-tg-3${String(i).padStart(2, '0')} 1`),
].join(', ')

// Requests from 08:00 Budapest time on `day`, one every 7 minutes, each with its own envelope hash.
function makeRows(day: string, refs: string[]): Approval[] {
  const start = budapestMidnightUtcMs(day) / 1000 + 8 * 3600
  return refs.map((ref, i): Approval => ({
    id: `${day}-${i}`, agent_id: 'agent-main', category: 'email_send', action_description: SECRET_CONTENT,
    action_payload: null, status: 'pending', requested_at: start + i * 420, timeout_at: null, telegram_message_id: null,
    resolved_at: null, resolved_by: null, content_hash: createHash('sha256').update(`${day}-${i}`).digest('hex'),
    consumed_at: null, owner_go_ref: ref,
  }))
}

describe('b606226d: the digest always fits one Telegram message', () => {
  it('the limit leaves room for the test-run marker; 3 failed sends in a row settle in-band', () => {
    expect(OWNER_GO_DIGEST_MAX_CHARS).toBe(4096 - '[TESZT] '.length)
    expect(OWNER_GO_DIGEST_MAX_SEND_FAILURES).toBe(3)
  })

  it('the 91-request day does not fit as one line per request (the fixture really needs the compact form)', () => {
    const rows = makeRows('2026-10-02', goRefsOf(DAY_91_REFS))
    const full = buildOwnerGoDigestText([{ day: '2026-10-02', rows }], Number.POSITIVE_INFINITY)
    expect(full.split('\n').filter((l) => l.includes(' | GO: '))).toHaveLength(91)
    expect(full.length).toBeGreaterThan(4096)
  })

  it('a 91-request day turns compact: counts per state and per GO reference, the first and last time, no rows', () => {
    // As live (2026-09-30..10-03: all 229 used up): most requests already consumed by the send.
    const rows = makeRows('2026-10-02', goRefsOf(DAY_91_REFS))
      .map((row, i): Approval => (i < 60 ? { ...row, status: 'approved', consumed_at: row.requested_at + 60 } : row))
    expect(rows).toHaveLength(91)
    const text = buildOwnerGoDigestText([{ day: '2026-10-02', rows }])
    expect(text.length).toBeLessThanOrEqual(OWNER_GO_DIGEST_MAX_CHARS)
    expect(text.split('\n')).toEqual([
      '[NAPI ÖSSZESÍTŐ] 2026-10-02: a fő ügynök 91 email-jóváhagyási kérése meglévő tulajdonosi GO-ra hivatkozott',
      'Ezekről egyenként nem ment értesítés. A soros lista nem fér egy üzenetbe, ezért itt csak a darabszámok állnak.',
      'Idő: az első 08:00-kor, az utolsó 18:30-kor',
      'Állapot szerint: felhasználva 60, függőben 31',
      DAY_91_GO_LINE,
      'A soros lista: Dashboard -> Jóváhagyások',
    ])
    expect(text).not.toContain('ajánlat')
  })

  it('the largest day turns compact first: an earlier, smaller day that fits keeps its rows', () => {
    const small = makeRows('2026-10-01', goRefsOf(DAY_91_REFS).slice(0, 20))
    const big = makeRows('2026-10-02', goRefsOf(DAY_91_REFS))
    const text = buildOwnerGoDigestText([{ day: '2026-10-01', rows: small }, { day: '2026-10-02', rows: big }])
    expect(text.length).toBeLessThanOrEqual(OWNER_GO_DIGEST_MAX_CHARS)
    const lines = text.split('\n')
    expect(lines.filter((l) => l.includes(' | GO: '))).toHaveLength(20)
    expect(lines).toContain('2026-10-01: 20 kérés')
    expect(lines).toContain('2026-10-02: 91 kérés, az első 08:00-kor, az utolsó 18:30-kor')
    expect(lines).toContain(DAY_91_GO_LINE)
  })

  it('many long GO references: fewer are named, the rest are summed, the counts still add up', () => {
    const refs = Array.from({ length: 91 }, (_, i) => `R${String(i).padStart(3, '0')}-${'x'.repeat(115)}`)
    const text = buildOwnerGoDigestText([{ day: '2026-10-02', rows: makeRows('2026-10-02', refs) }])
    expect(text.length).toBeLessThanOrEqual(OWNER_GO_DIGEST_MAX_CHARS)
    const goLine = text.split('\n').find((l) => l.startsWith('GO-hivatkozásonként: '))!
    const m = /, és még (\d+) hivatkozás összesen (\d+) kéréssel$/.exec(goLine)
    expect(m).not.toBeNull()
    const named = goLine.slice('GO-hivatkozásonként: '.length, m!.index).split(', ')
    expect(named.length).toBeGreaterThan(0)
    expect(named.length + Number(m![1])).toBe(91)
    expect(named.reduce((s, e) => s + Number(e.split(' ')[1]), 0) + Number(m![2])).toBe(91)
  })

  it('an input far beyond the catch-up window is cut at a whole line, still one message under the limit', () => {
    const days = Array.from({ length: 40 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString().slice(0, 10)
      return { day, rows: makeRows(day, [`R-${'y'.repeat(100)}`]) }
    })
    const text = buildOwnerGoDigestText(days)
    expect(text.length).toBeLessThanOrEqual(OWNER_GO_DIGEST_MAX_CHARS)
    expect(text.split('\n').slice(-2)).toEqual(['(A többi nem fér egy üzenetbe.)', 'A soros lista: Dashboard -> Jóváhagyások'])
  })

  it('the days due at once: from the oldest unsettled one to yesterday, at most 7 days back', () => {
    const t = (iso: string) => new Date(iso).getTime()
    expect(ownerGoDigestDaysDue(t('2026-10-04T04:59:00Z'), '2026-09-29')).toEqual([])
    expect(ownerGoDigestDaysDue(t('2026-10-04T05:01:00Z'), null)).toEqual(['2026-10-03'])
    expect(ownerGoDigestDaysDue(t('2026-10-04T05:01:00Z'), '2026-10-03')).toEqual([])
    expect(ownerGoDigestDaysDue(t('2026-10-04T05:01:00Z'), '2026-09-29')).toEqual(['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'])
    expect(ownerGoDigestDaysDue(t('2026-10-05T14:00:00Z'), '2026-09-01'))
      .toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
  })
})

describe('bc7c1e9d (b): immediate pings and the daily digest, end to end', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    // The backoff and the failure count live in the module: a test that stops on a failure must not leave
    // them to the next one. Optional so the same file also runs on a2bdd31fc (the negative control).
    _resetOwnerGoDigestStateForTest?.()
    telegram.sends.length = 0
    telegram.tooLong.length = 0
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
    expect(inBand[0].content).toContain('reason=no-telegram-path')
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

describe('b606226d: the digest end to end, through the request route and the Telegram sender', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    // The backoff and the failure count live in the module: a test that stops on a failure must not leave
    // them to the next one. Optional so the same file also runs on a2bdd31fc (the negative control).
    _resetOwnerGoDigestStateForTest?.()
    telegram.sends.length = 0
    telegram.tooLong.length = 0
    telegram.failNext = false
    telegram.down = false
    ownerChat.id = '111'
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => vi.useRealTimers())

  // GO-cited main-agent requests through POST /api/approvals, from 08:00 Budapest time on `day`, one every
  // 7 minutes. Returns the request ids.
  async function postGoDay(day: string, refs: string[]): Promise<string[]> {
    const start = budapestMidnightUtcMs(day) + 8 * 3_600_000
    const ids: string[] = []
    for (let i = 0; i < refs.length; i++) {
      at(new Date(start + i * 420_000).toISOString())
      const res = await post({
        agent_id: 'agent-main', category: 'email_send', owner_go_ref: refs[i],
        content_hash: createHash('sha256').update(`${day}-${i}`).digest('hex'),
      })
      expect(res.status).toBe(201)
      ids.push(res.body.id)
    }
    return ids
  }

  it('a 91-request day goes out as one message under the limit, with its counts (red on a2bdd31fc: 400 too long)', async () => {
    const ids = await postGoDay('2026-10-02', goRefsOf(DAY_91_REFS))
    for (const id of ids.slice(0, 10)) resolveApproval(id, 'approved', 'owner')
    for (const id of ids.slice(10, 12)) resolveApproval(id, 'rejected', 'owner')
    expect(telegram.sends).toHaveLength(0)

    const result = await sendOwnerGoDigestIfDue(Date.parse('2026-10-03T05:01:00Z'))
    // First the cause: on a2bdd31fc the one-line-per-request text is rejected as too long (its length lands here).
    expect(telegram.tooLong).toEqual([])
    expect(result).toBe('telegram')
    expect(telegram.sends).toHaveLength(1)
    const text = telegram.sends[0].text
    expect(text.length).toBeLessThanOrEqual(OWNER_GO_DIGEST_MAX_CHARS)
    expect(text.split('\n')).toEqual([
      '[NAPI ÖSSZESÍTŐ] 2026-10-02: a fő ügynök 91 email-jóváhagyási kérése meglévő tulajdonosi GO-ra hivatkozott',
      'Ezekről egyenként nem ment értesítés. A soros lista nem fér egy üzenetbe, ezért itt csak a darabszámok állnak.',
      'Idő: az első 08:00-kor, az utolsó 18:30-kor',
      'Állapot szerint: függőben 79, jóváhagyva 10, elutasítva 2',
      DAY_91_GO_LINE,
      'A soros lista: Dashboard -> Jóváhagyások',
    ])
    expect(text).not.toContain('ajánlat')
    expect(lastOwnerGoDigestDay()).toBe('2026-10-02')
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-10-03T05:20:00Z'))).toBe('none')
    expect(telegram.sends).toHaveLength(1)
  })

  it('the stuck mornings, caught up: every due day in one message, the largest compact first, a small day keeps its rows', async () => {
    await postGoDay('2026-09-29', ['tesztelek-tg-90'])
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-30T05:01:00Z'))).toBe('telegram')
    // The live days behind the stuck one: 55, 81, 91 and 2 requests (b606226d).
    const refs = goRefsOf(DAY_91_REFS)
    await postGoDay('2026-09-30', refs.slice(0, 55))
    await postGoDay('2026-10-01', refs.slice(0, 81))
    await postGoDay('2026-10-02', refs)
    await postGoDay('2026-10-03', ['tesztelek-tg-401', 'tesztelek-tg-402'])

    const result = await sendOwnerGoDigestIfDue(Date.parse('2026-10-04T05:01:00Z'))
    expect(telegram.tooLong).toEqual([])
    expect(result).toBe('telegram')
    expect(telegram.sends).toHaveLength(2)
    const text = telegram.sends[1].text
    expect(text.length).toBeLessThanOrEqual(OWNER_GO_DIGEST_MAX_CHARS)
    const lines = text.split('\n')
    expect(lines[0]).toBe('[NAPI ÖSSZESÍTŐ] 2026-09-30 és 2026-10-03 között 4 napon: a fő ügynök 229 email-jóváhagyási kérése meglévő tulajdonosi GO-ra hivatkozott')
    expect(lines[1]).toBe('Ezekről egyenként nem ment értesítés. Ahol a soros lista nem fér egy üzenetbe, ott csak a darabszámok állnak. Soronként: idő | kérő | kategória | boríték-hash eleje | GO | állapot.')
    expect(lines.filter((l) => /^\d{4}-\d{2}-\d{2}: /.test(l))).toEqual([
      '2026-09-30: 55 kérés, az első 08:00-kor, az utolsó 14:18-kor',
      '2026-10-01: 81 kérés, az első 08:00-kor, az utolsó 17:20-kor',
      '2026-10-02: 91 kérés, az első 08:00-kor, az utolsó 18:30-kor',
      '2026-10-03: 2 kérés',
    ])
    const rowLines = lines.filter((l) => l.includes(' | GO: '))
    expect(rowLines).toHaveLength(2)
    expect(rowLines[0]).toMatch(/^08:00 \| agent-main \| email_send \| boríték [0-9a-f]{12} \| GO: tesztelek-tg-401 \| függőben$/)
    expect(rowLines[1]).toMatch(/^08:07 \| agent-main \| email_send \| boríték [0-9a-f]{12} \| GO: tesztelek-tg-402 \| függőben$/)
    expect(lines.filter((l) => l.startsWith('GO-hivatkozásonként: '))).toHaveLength(3)
    expect(lines.at(-1)).toBe('A soros lista: Dashboard -> Jóváhagyások')
    expect(lastOwnerGoDigestDay()).toBe('2026-10-03')
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-10-04T05:20:00Z'))).toBe('none')
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-10-05T05:01:00Z'))).toBe('empty')
    expect(lastOwnerGoDigestDay()).toBe('2026-10-04')
    expect(telegram.sends).toHaveLength(2)
  })

  it('an empty day inside the due days is settled with them and left out of the text', async () => {
    await postGoDay('2026-09-27', ['tesztelek-tg-90'])
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-28T05:01:00Z'))).toBe('telegram')
    await postGoDay('2026-09-29', ['tesztelek-tg-91'])
    expect(await sendOwnerGoDigestIfDue(Date.parse('2026-09-30T05:01:00Z'))).toBe('telegram')
    expect(telegram.sends[1].text.split('\n')[0]).toBe('[NAPI ÖSSZESÍTŐ] 2026-09-29: a fő ügynök 1 email-jóváhagyási kérése meglévő tulajdonosi GO-ra hivatkozott')
    expect(lastOwnerGoDigestDay()).toBe('2026-09-29')
  })

  it('a send that keeps failing is settled in-band at the 3rd failure in a row, and the next day goes out (red on a2bdd31fc)', async () => {
    await postGoDay('2026-09-23', ['tesztelek-tg-101'])
    await postGoDay('2026-09-24', ['tesztelek-tg-102'])
    telegram.down = true
    const t0 = Date.parse('2026-09-24T05:01:00Z')
    expect(await sendOwnerGoDigestIfDue(t0)).toBe('failed')
    expect(await sendOwnerGoDigestIfDue(t0 + 60_000)).toBe('none')
    expect(await sendOwnerGoDigestIfDue(t0 + OWNER_GO_DIGEST_RETRY_MS)).toBe('failed')
    expect(await sendOwnerGoDigestIfDue(t0 + 2 * OWNER_GO_DIGEST_RETRY_MS)).toBe('in_band')
    const inBand = getPendingMessages('agent-main').filter((m) => m.content.startsWith('[OWNER_UNREACHED owner-go-digest]'))
    expect(inBand).toHaveLength(1)
    expect(inBand[0].content).toContain('reason=send-failed failures=3')
    expect(inBand[0].content).toContain('[NAPI ÖSSZESÍTŐ] 2026-09-23: a fő ügynök 1 email-jóváhagyási kérése')
    expect(inBand[0].content).toContain('GO: tesztelek-tg-101')
    expect(lastOwnerGoDigestDay()).toBe('2026-09-23')
    expect(await sendOwnerGoDigestIfDue(t0 + 2 * OWNER_GO_DIGEST_RETRY_MS + 60_000)).toBe('none')

    // The next morning starts the count again: its first failure is retried, not settled in-band at once.
    const t1 = Date.parse('2026-09-25T05:01:00Z')
    expect(await sendOwnerGoDigestIfDue(t1)).toBe('failed')
    telegram.down = false
    expect(await sendOwnerGoDigestIfDue(t1 + OWNER_GO_DIGEST_RETRY_MS)).toBe('telegram')
    expect(telegram.sends).toHaveLength(1)
    expect(telegram.sends[0].text.split('\n')[0]).toBe('[NAPI ÖSSZESÍTŐ] 2026-09-24: a fő ügynök 1 email-jóváhagyási kérése meglévő tulajdonosi GO-ra hivatkozott')
    expect(telegram.sends[0].text).toContain('GO: tesztelek-tg-102')
  })

  it('only failures in a row count: a sent digest starts the count again', async () => {
    await postGoDay('2026-09-23', ['tesztelek-tg-101'])
    await postGoDay('2026-09-24', ['tesztelek-tg-102'])
    const t0 = Date.parse('2026-09-24T05:01:00Z')
    telegram.down = true
    expect(await sendOwnerGoDigestIfDue(t0)).toBe('failed')
    expect(await sendOwnerGoDigestIfDue(t0 + OWNER_GO_DIGEST_RETRY_MS)).toBe('failed')
    telegram.down = false
    expect(await sendOwnerGoDigestIfDue(t0 + 2 * OWNER_GO_DIGEST_RETRY_MS)).toBe('telegram')
    const t1 = Date.parse('2026-09-25T05:01:00Z')
    telegram.down = true
    expect(await sendOwnerGoDigestIfDue(t1)).toBe('failed')
    expect(await sendOwnerGoDigestIfDue(t1 + OWNER_GO_DIGEST_RETRY_MS)).toBe('failed')
    expect(await sendOwnerGoDigestIfDue(t1 + 2 * OWNER_GO_DIGEST_RETRY_MS)).toBe('in_band')
    expect(telegram.sends).toHaveLength(1)
  })
})
