import { expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { tryHandleApprovals } from '../../web/routes/approvals.js'
import { ragPayloadContentHash } from '../../web/rag-approval-payload.js'
import { parseCallbackData } from '../../web/approval-callback-data.js'
import type { RouteContext } from '../../web/routes/types.js'

// Shared plumbing of the permission-bot route tests (card 9a77b3e5). The
// vi.mock blocks stay in each test file (they must be hoisted there); this file
// holds the fake Telegram, the fake request/response and the request helpers.
// Nothing here touches the network: fetch is replaced by the fake below.

export const OWNER = '1000000001'
export const MAIN_BOT = '7000000001'
export const PERM_BOT = '7000000002'
export const MAIN_TOKEN = `${MAIN_BOT}:AAmainSECRETpartABC`
export const MAIN_CHANNEL_TOKEN = `${MAIN_BOT}:AAchannelSECRETpartDEF`
export const PERM_TOKEN = `${PERM_BOT}:AApermSECRETpartXYZ`
// Every secret fragment that must never show up in a log, a response or a message.
export const SECRET_PARTS = ['AAmainSECRETpartABC', 'AAchannelSECRETpartDEF', 'AApermSECRETpartXYZ']
export const PKG = 'ab'.repeat(32)
export const RUN = '0123456789abcdef0123456789abcdef'

export const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

export type TgCall = { url: string; rawBody: string; body: { chat_id: string; message_id?: number; text?: string; reply_markup?: any } }

export interface FakeTelegram {
  calls: TgCall[]
  fetch: ReturnType<typeof vi.fn>
  nextMessageId: number
  // 'ok' answers every call; 'send500' refuses sendMessage with a body that
  // echoes the bot URL (a token-bearing error text); 'edit500' refuses the edit.
  mode: 'ok' | 'send500' | 'edit500'
  reset(): void
  sends(): TgCall[]
  edits(): TgCall[]
}

export function createFakeTelegram(): FakeTelegram {
  const t: FakeTelegram = {
    calls: [],
    nextMessageId: 1000,
    mode: 'ok',
    fetch: vi.fn(),
    reset() { t.calls = []; t.nextMessageId = 1000; t.mode = 'ok'; t.fetch.mockClear() },
    sends: () => t.calls.filter(c => c.url.endsWith('/sendMessage')),
    edits: () => t.calls.filter(c => c.url.endsWith('/editMessageReplyMarkup')),
  }
  t.fetch.mockImplementation(async (url: string, init: { body: string }) => {
    const call: TgCall = { url, rawBody: init.body, body: JSON.parse(init.body) }
    t.calls.push(call)
    const isEdit = url.endsWith('/editMessageReplyMarkup')
    if ((isEdit && t.mode === 'edit500') || (!isEdit && t.mode === 'send500')) {
      const body = `upstream said: ${url}`
      return { ok: false, status: 500, text: async () => body, json: async () => ({}) }
    }
    const result = isEdit ? true : { message_id: t.nextMessageId++ }
    return { ok: true, status: 200, text: async () => '', json: async () => ({ ok: true, result }) }
  })
  return t
}

export function fakeReq(body: unknown) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
}

export async function route(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<{ status: number; body: any; raw: string }> {
  const out = { status: 0, body: null as any, raw: '' }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { out.raw = chunk; out.body = JSON.parse(chunk) } },
  }
  const url = new URL(`http://localhost:3420${path}`)
  expect(await tryHandleApprovals({ req: fakeReq(body ?? {}), res, path, method, url } as unknown as RouteContext)).toBe(true)
  return out
}

export function canonical(over: Partial<{ kind: string; pkg: string; run: string; start: number; end: number }> & { start: number; end: number }): string {
  return JSON.stringify({
    kind: over.kind ?? 'rag_production_d',
    package_sha256: over.pkg ?? PKG,
    run_id: over.run ?? RUN,
    write_window_start: over.start,
    write_window_end: over.end,
  })
}

export function requestBody(payload: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const kind = (JSON.parse(payload) as { kind: string }).kind
  return {
    agent_id: 'fejleszto',
    category: kind,
    action_description: 'RAG production run',
    action_payload: payload,
    content_hash: ragPayloadContentHash(payload),
    timeout_seconds: 600,
    ...over,
  }
}

// The nonces and the message id the owner's button message carried.
export function buttonsOf(call: TgCall, approvalId: string): { approve: string; reject: string } {
  const kb = call.body.reply_markup
  expect(kb.inline_keyboard).toHaveLength(1)
  const [a, r] = kb.inline_keyboard[0]
  const pa = parseCallbackData(a.callback_data)
  const pr = parseCallbackData(r.callback_data)
  expect(pa).toMatchObject({ decision: 'approved', approvalId })
  expect(pr).toMatchObject({ decision: 'rejected', approvalId })
  expect(pa!.nonce).not.toBe(pr!.nonce)
  return { approve: pa!.nonce, reject: pr!.nonce }
}

export function dumpLogs(logged: unknown[][]): string {
  return JSON.stringify(logged, (_k, v) => v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v)
}
