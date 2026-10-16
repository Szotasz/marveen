// The main agent often files an approval only AFTER the owner already said yes
// to the exact action in the chat ("2. mehet"), then PATCHes it approved. POST
// still sent the owner the approval QUESTION, so the owner answered "mehet" a
// second time -- four times in one day on a live install. The main agent can
// now pass the owner's approving chat message id on POST: the row is born
// approved and the owner gets an informative note instead of a question. The
// field is rejected for any other declared agent_id: a sub-agent that declares
// its own name is refused. The check rests on the self-declared agent_id, so
// any holder of the shared token can still send the main agent's name.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const sendSpy = vi.hoisted(() => vi.fn(async (_token: string, _chatId: string, _text: string): Promise<number | null> => 4242))

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'agent-a', TELEGRAM_BOT_TOKEN: 'test-token', CHANNEL_PROVIDER: 'telegram' }
})
vi.mock('../owner-chat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../owner-chat.js')>()
  return { ...real, resolveOwnerChatId: () => '777' }
})
vi.mock('../web/telegram.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/telegram.js')>()
  return { ...real, sendTelegramMessage: sendSpy }
})

import { initDatabase, getApproval, listApprovals, getPendingMessages } from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeReq(method: 'POST' | 'PATCH', path: string, body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
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
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

async function post(body: unknown) {
  const { ctx, out } = fakeReq('POST', '/api/approvals', body)
  expect(await tryHandleApprovals(ctx)).toBe(true)
  // notifyOwner is fire-and-forget: let its async body run to completion.
  await new Promise(r => setImmediate(r))
  return out
}

function sentTexts(): string[] {
  return sendSpy.mock.calls.map(c => c[2])
}

describe('POST /api/approvals with owner_approved_message_id', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    sendSpy.mockClear()
  })

  it('(a) main agent + field: the row is born approved, and the owner gets a note, not a question', async () => {
    const out = await post({
      agent_id: 'agent-a',
      category: 'email_send',
      action_description: 'Heti összefoglaló küldése a csapatnak',
      owner_approved_message_id: 4001,
    })
    expect(out.status).toBe(201)
    expect(out.body.status).toBe('approved')
    expect(out.body.resolved_by).toBe('telegram_text')
    expect(out.body.telegram_message_id).toBe(4001)
    expect(out.body.resolved_at).toBeGreaterThan(0)

    const row = getApproval(out.body.id)!
    expect(row.status).toBe('approved')
    expect(row.resolved_by).toBe('telegram_text')
    expect(row.telegram_message_id).toBe(4001)

    const texts = sentTexts()
    expect(texts.length).toBe(1)
    expect(sendSpy.mock.calls[0][1]).toBe('777')
    expect(texts[0]).toContain('JÓVÁHAGYVA A CHATBEN')
    expect(texts[0]).toContain('4001')
    expect(texts[0]).toContain('Heti összefoglaló küldése a csapatnak')
    expect(texts[0]).toContain('Nincs további teendőd')
    // No question: neither the header nor the "decide on the dashboard" line.
    expect(texts[0]).not.toContain('JÓVÁHAGYÁS KELL')
    expect(texts[0]).not.toContain('Döntés:')

    // The owner's approving message id stays on the row: the note's own
    // message id must not overwrite it.
    expect(getApproval(out.body.id)!.telegram_message_id).toBe(4001)
  })

  it('(b) a sub-agent that declares its own name is refused: 400, no row, nothing sent', async () => {
    const out = await post({
      agent_id: 'agent-b',
      category: 'email_send',
      action_description: 'Send report',
      owner_approved_message_id: 4002,
    })
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/owner_approved_message_id/)
    expect(listApprovals({}).length).toBe(0)
    expect(sentTexts().length).toBe(0)
    expect(getPendingMessages('agent-a').length).toBe(0)
  })

  it('main agent + malformed field: 400, no row (never silently falls back)', async () => {
    for (const bad of [0, -3, 1.5, true, {}, [4002]]) {
      const out = await post({
        agent_id: 'agent-a',
        category: 'email_send',
        action_description: 'x',
        owner_approved_message_id: bad,
      })
      expect(out.status).toBe(400)
    }
    for (const bad of ['', 'x'.repeat(65), 'has space', 'semi;colon']) {
      const out = await post({
        agent_id: 'agent-a',
        category: 'email_send',
        action_description: 'x',
        owner_approved_message_id: bad,
      })
      expect(out.status).toBe(400)
    }
    expect(listApprovals({}).length).toBe(0)
    expect(sentTexts().length).toBe(0)
  })

  it('main agent + a string message id (non-integer provider ids): approved, id named in the note, column left empty', async () => {
    const out = await post({
      agent_id: 'agent-a',
      category: 'email_send',
      action_description: 'Send weekly digest',
      owner_approved_message_id: '1712345678.123456',
    })
    expect(out.status).toBe(201)
    expect(out.body.status).toBe('approved')
    expect(out.body.resolved_by).toBe('telegram_text')
    // telegram_message_id is an INTEGER column: a string id is not forced into it.
    expect(getApproval(out.body.id)!.telegram_message_id).toBeNull()
    const texts = sentTexts()
    expect(texts.length).toBe(1)
    expect(texts[0]).toContain('JÓVÁHAGYVA A CHATBEN')
    expect(texts[0]).toContain('1712345678.123456')
  })

  it('(c) no field: unchanged -- pending row, the owner gets the question', async () => {
    const out = await post({
      agent_id: 'agent-a',
      category: 'email_send',
      action_description: 'Send weekly digest',
    })
    expect(out.status).toBe(201)
    expect(out.body.status).toBe('pending')
    expect(out.body.resolved_by).toBeNull()
    const texts = sentTexts()
    expect(texts.length).toBe(1)
    expect(texts[0]).toContain('[JÓVÁHAGYÁS KELL]')
    expect(texts[0]).not.toContain('JÓVÁHAGYVA A CHATBEN')
    // The question's message id is stamped onto the pending row, as before.
    expect(getApproval(out.body.id)!.telegram_message_id).toBe(4242)
  })

  it('(c) no field, sub-agent: unchanged -- pending, question sent, main agent notified', async () => {
    const out = await post({
      agent_id: 'agent-b',
      category: 'email_send',
      action_description: 'Send report',
    })
    expect(out.status).toBe(201)
    expect(out.body.status).toBe('pending')
    expect(sentTexts()[0]).toContain('[JÓVÁHAGYÁS KELL]')
    expect(getPendingMessages('agent-a')[0].content).toContain('[APPROVAL_REQUEST]')
  })
})

// The email-approval-gate hook must accept a chat-approved row exactly like a
// PATCH-approved one. Driven end-to-end: the real route writes a real SQLite
// file, the real hook reads it.
describe('email-approval-gate accepts a chat-approved row', () => {
  const ROOT = join(__dirname, '..', '..')
  const GATE = join(ROOT, 'scripts', 'hooks', 'email-approval-gate.py')
  let td: string
  let store: string

  beforeEach(() => {
    td = mkdtempSync(join(tmpdir(), 'chat-approved-'))
    store = join(td, 'store')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify({
      version: 1,
      categories: [{ key: 'email_send', label: 'Email', level: 2, locked: false }],
    }))
    initDatabase(join(store, 'claudeclaw.db'))
    sendSpy.mockClear()
  })

  afterEach(() => {
    initDatabase(':memory:')
    rmSync(td, { recursive: true, force: true })
  })

  function runGate(subject: string) {
    const payload = {
      tool_name: 'mcp__server-gmail-autoauth-mcp__send_email',
      tool_input: { to: ['a@b.hu'], subject, body: 'Kedves Ügyfelünk! Törzs.' },
    }
    return spawnSync('python3', [GATE], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      env: {
        ...process.env,
        EMAIL_APPROVAL_GATE_STORE: store,
        EMAIL_APPROVAL_WINDOW_S: '1800',
        OUTGOING_COPY_GATE_RULES: join(store, 'no-rules.json'),
      },
      timeout: 60_000,
    })
  }

  function anchorFor(subject: string): string {
    const denied = runGate(subject)
    expect(denied.status).toBe(2)
    const m = denied.stderr.match(/\b([0-9a-f]{64})\b/)
    expect(m).not.toBeNull()
    return m![1]
  }

  it('chat-approved (POST) and PATCH-approved rows both let the send through, once', async () => {
    // Path 1: born approved on POST.
    const anchor1 = anchorFor('Chatben jóváhagyva')
    const created = await post({
      agent_id: 'agent-a',
      category: 'email_send',
      action_description: 'Email: Chatben jóváhagyva',
      content_hash: anchor1,
      owner_approved_message_id: 4003,
    })
    expect(created.status).toBe(201)
    const ok1 = runGate('Chatben jóváhagyva')
    expect(ok1.status, ok1.stderr).toBe(0)
    expect(getApproval(created.body.id)!.consumed_at).not.toBeNull()
    expect(runGate('Chatben jóváhagyva').status).toBe(2) // one-shot, as for any approval

    // Path 2: the pre-existing POST pending + PATCH approved route.
    const anchor2 = anchorFor('Patch-el jóváhagyva')
    const pending = await post({
      agent_id: 'agent-a',
      category: 'email_send',
      action_description: 'Email: Patch-el jóváhagyva',
      content_hash: anchor2,
    })
    const { ctx, out } = fakeReq('PATCH', `/api/approvals/${pending.body.id}`, {
      status: 'approved', resolved_by: 'telegram_text', telegram_message_id: 4004,
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    const ok2 = runGate('Patch-el jóváhagyva')
    expect(ok2.status, ok2.stderr).toBe(0)

    // Same shape on the fields the gate reads.
    const a = getApproval(created.body.id)!
    const b = getApproval(pending.body.id)!
    for (const r of [a, b]) {
      expect(r.status).toBe('approved')
      expect(r.resolved_by).toBe('telegram_text')
      expect(r.resolved_at).toBeGreaterThan(0)
      expect(r.category).toBe('email_send')
    }
  })
})
