import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  marveenApprovalCallback,
  MARVEEN_APV_CALLBACK_RE,
  MARVEEN_APV_TOAST,
  type MarveenApvCtx,
  type MarveenApvDeps,
} from '../telegram-plugin-patches/approval-callback.js'
import {
  APPROVAL_CALLBACK_RE,
  buildCallbackData,
  newCallbackNonce,
  parseCallbackData,
} from '../web/approval-callback-data.js'

// The plugin block for the email-approval buttons, driven
// with a fake grammY ctx and fake fs/fetch: no network, no live plugin, no
// live install. The block's own rule set: shape, allowlisted sender id, private
// chat of the sender, then exactly one POST to /api/approvals/:id/telegram
// (never the legacy PATCH: an older dashboard would decide that without the
// nonce); every failure is fail-closed, an older dashboard's 404 included.

const INSTALL = '/srv/marveen-apv-test'
const STATE_DIR = `${INSTALL}/.claude/channels/telegram`
const TOKEN_PATH = `${INSTALL}/store/.dashboard-token`
const ENV_PATH = `${INSTALL}/.env`
const TOKEN = 'apv-test-dashboard-token-' + 'c0ffee'.repeat(6)
const OWNER = 424242001
const OTHER = 424242002
const UUID = '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b'
const ID32 = UUID.replace(/-/g, '')
// 16 bytes, base64url, no padding
const NONCE = Buffer.from('0123456789abcdef').toString('base64url')
const DATA_A = `apv:a:${ID32}:${NONCE}`
const DATA_R = `apv:r:${ID32}:${NONCE}`
const MSG_ID = 4711
const MSG_TEXT = 'Jóváhagyás kérése: levél küldése\nCímzett: valaki@example.com'
const OUTCOME_A = '✅ Jóváhagyva: 2026. 10. 15. 10:12:33 (Budapest). A levél 30 percen belül, egyszer küldhető el.'
const OUTCOME_R = '❌ Elutasítva: 2026. 10. 15. 10:12:33 (Budapest).'
const NO_BUTTONS = { reply_markup: { inline_keyboard: [] } }

type FetchArgs = Parameters<typeof fetch>
type Message = NonNullable<MarveenApvCtx['callbackQuery']['message']>

interface Rec {
  answers: unknown[]
  edits: { text: string; other: unknown }[]
  markups: unknown[]
}

function makeCtx(o: {
  from?: Record<string, unknown> | null
  message?: Partial<Message> | null
  text?: string | null
} = {}): { ctx: MarveenApvCtx; rec: Rec } {
  const rec: Rec = { answers: [], edits: [], markups: [] }
  const from = o.from === undefined ? { id: OWNER } : o.from
  const base: Message = { message_id: MSG_ID, chat: { id: OWNER, type: 'private' } }
  const text = o.text === undefined ? MSG_TEXT : o.text
  const message = o.message === null ? undefined : { ...base, ...(text === null ? {} : { text }), ...(o.message ?? {}) }
  const ctx = {
    ...(from === null ? {} : { from }),
    callbackQuery: { message },
    answerCallbackQuery: vi.fn(async (other?: { text?: string }) => { rec.answers.push(other) }),
    editMessageText: vi.fn(async (t: string, other?: unknown) => { rec.edits.push({ text: t, other }) }),
    editMessageReplyMarkup: vi.fn(async (other?: unknown) => { rec.markups.push(other) }),
  } as MarveenApvCtx
  return { ctx, rec }
}

function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: test`), { code })
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function okBody(status: 'approved' | 'rejected', outcome?: string): Record<string, unknown> {
  return { ok: true, approval: { id: UUID, status }, ...(outcome === undefined ? {} : { outcome_text: outcome }) }
}

function makeDeps(o: {
  stateDir?: string
  files?: Record<string, string | Error>
  allowFrom?: string[]
  respond?: (...args: FetchArgs) => Promise<Response>
  env?: Record<string, string | undefined>
  envAtLoad?: Record<string, string | undefined>
} = {}) {
  const files: Record<string, string | Error> = o.files ?? { [TOKEN_PATH]: `${TOKEN}\n` }
  const readFileSync = vi.fn((p: string, _enc: 'utf8'): string => {
    const v = files[p]
    if (v === undefined) throw fsError('ENOENT')
    if (v instanceof Error) throw v
    return v
  })
  const fetchMock = vi.fn(o.respond ?? (async (..._args: FetchArgs) => jsonResponse(200, okBody('approved', OUTCOME_A))))
  const deps: MarveenApvDeps = {
    stateDir: o.stateDir ?? STATE_DIR,
    readFileSync,
    fetch: fetchMock as unknown as typeof fetch,
    loadAccess: () => ({ allowFrom: o.allowFrom ?? [String(OWNER)] }),
    env: o.env ?? {},
    envAtLoad: o.envAtLoad ?? {},
  }
  return { deps, fetchMock, readFileSync }
}

function sentInit(fetchMock: ReturnType<typeof makeDeps>['fetchMock']): RequestInit {
  const init = fetchMock.mock.calls[0]?.[1]
  if (!init) throw new Error('no fetch init recorded')
  return init
}

let consoleSpies: unknown[] = []

beforeEach(() => {
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(k =>
    vi.spyOn(console, k).mockImplementation(() => {}),
  )
})

afterEach(() => {
  for (const s of consoleSpies) expect(s).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

// A pre-check refusal: one toast, and nothing else happened.
function expectRefusedBeforeHttp(rec: Rec, d: ReturnType<typeof makeDeps>, toast: string): void {
  expect(rec.answers).toEqual([{ text: toast }])
  expect(d.fetchMock).not.toHaveBeenCalled()
  expect(rec.edits).toEqual([])
  expect(rec.markups).toEqual([])
}

describe('approval callback block: callback_data shape (no HTTP, no edit)', () => {
  it('the vectors are what their names say', () => {
    expect(Buffer.byteLength(DATA_A)).toBe(61)
    expect(Buffer.byteLength(`apv:a:${ID32}:${NONCE}xx`)).toBe(63)
    expect(Buffer.byteLength(`apv:a:${ID32}:${NONCE}xxxx`)).toBe(65)
    expect(NONCE).toHaveLength(22)
  })

  const BAD: [string, string][] = [
    ['perm allow', 'perm:allow:abcde'],
    ['perm deny', 'perm:deny:abcde'],
    ['perm more', 'perm:more:abcde'],
    ['uppercase hex', `apv:a:${ID32.toUpperCase()}:${NONCE}`],
    ['31 hex', `apv:a:${ID32.slice(1)}:${NONCE}`],
    ['33 hex', `apv:a:${ID32}0:${NONCE}`],
    ['dashed uuid', `apv:a:${UUID}:${NONCE}`],
    ['63 bytes', `apv:a:${ID32}:${NONCE}xx`],
    ['65 bytes', `apv:a:${ID32}:${NONCE}xxxx`],
    ['21-char nonce', `apv:a:${ID32}:${NONCE.slice(1)}`],
    ['padding', `apv:a:${ID32}:${NONCE.slice(0, 21)}=`],
    ['standard base64 +', `apv:a:${ID32}:${NONCE.slice(0, 21)}+`],
    ['standard base64 /', `apv:a:${ID32}:${NONCE.slice(0, 21)}/`],
    ['unknown action', `apv:x:${ID32}:${NONCE}`],
    ['uppercase action', `apv:A:${ID32}:${NONCE}`],
    ['trailing newline', `${DATA_A}\n`],
    ['trailing space', `${DATA_A} `],
    ['leading space', ` ${DATA_A}`],
    ['cyrillic lookalike', DATA_A.replace('apv', 'аpv')],
    ['fullwidth colon', DATA_A.replace('apv:', 'apv：')],
    ['no nonce (pre-A3 shape)', `apv:a:${ID32}`],
    ['prefix only', 'apv:'],
    ['empty', ''],
  ]

  it.each(BAD)('%s -> "Érvénytelen gomb.", no file read, no fetch', async (_name, data) => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps()
    await marveenApprovalCallback(ctx, data, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.invalid)
    expect(d.readFileSync).not.toHaveBeenCalled()
  })

  it('non-string data is refused the same way', async () => {
    for (const data of [undefined, null, 61, { data: DATA_A }]) {
      const { ctx, rec } = makeCtx()
      const d = makeDeps()
      await marveenApprovalCallback(ctx, data as unknown as string, d.deps)
      expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.invalid)
    }
  })
})

describe('approval callback block: sender and chat (no HTTP, no edit)', () => {
  it('a sender not on allowFrom -> "Nem engedélyezett."', async () => {
    const { ctx, rec } = makeCtx({ from: { id: OTHER }, message: { chat: { id: OTHER, type: 'private' } } })
    const d = makeDeps()
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.forbidden)
  })

  it('the display name does not count: owner-looking names with a foreign id are refused', async () => {
    const { ctx, rec } = makeCtx({
      from: { id: OTHER, first_name: 'Owner', username: 'owner', is_bot: false },
      message: { chat: { id: OTHER, type: 'private' } },
    })
    const d = makeDeps()
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.forbidden)
  })

  it.each([
    ['no from', null],
    ['id 0', { id: 0 }],
    ['negative id', { id: -OWNER }],
    ['fractional id', { id: OWNER + 0.5 }],
    ['string id', { id: String(OWNER) }],
  ])('%s -> "Nem engedélyezett."', async (_name, from) => {
    const { ctx, rec } = makeCtx({ from: from as Record<string, unknown> | null })
    const d = makeDeps({ allowFrom: [String(OWNER), '0', String(-OWNER)] })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.forbidden)
  })

  it('an empty allowlist refuses everyone', async () => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({ allowFrom: [] })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.forbidden)
  })

  it('a throwing loadAccess is fail-closed', async () => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps()
    d.deps.loadAccess = () => { throw new Error('access.json unreadable') }
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.unavailable)
  })

  it('no callbackQuery.message -> "Érvénytelen gomb."', async () => {
    const { ctx, rec } = makeCtx({ message: null })
    const d = makeDeps()
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.invalid)
  })

  it.each(['group', 'supergroup', 'channel'])('a %s chat is refused even when its id equals the sender', async type => {
    const { ctx, rec } = makeCtx({ message: { chat: { id: OWNER, type } } })
    const d = makeDeps()
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.forbidden)
  })

  it('a private chat that is not the sender\'s -> "Nem engedélyezett."', async () => {
    const { ctx, rec } = makeCtx({ message: { chat: { id: OTHER, type: 'private' } } })
    const d = makeDeps({ allowFrom: [String(OWNER), String(OTHER)] })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.forbidden)
  })

  it.each([0, -1, 1.5])('message_id %s -> "Érvénytelen gomb."', async message_id => {
    const { ctx, rec } = makeCtx({ message: { message_id } })
    const d = makeDeps()
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.invalid)
  })
})

describe('approval callback block: dashboard resolution is fail-closed', () => {
  it.each([
    ['other suffix', `${INSTALL}/.claude/channels/telegram-other`],
    ['not under .claude', `${INSTALL}/channels/telegram`],
    ['other provider', `${INSTALL}/.claude/channels/slack`],
    ['relative', 'srv/marveen-apv-test/.claude/channels/telegram'],
    ['no install root', '/.claude/channels/telegram'],
    ['dot-dot segment', `${INSTALL}/../etc/.claude/channels/telegram`],
    ['dot segment', `${INSTALL}/./.claude/channels/telegram`],
    ['NUL byte', `/srv/a\0b/.claude/channels/telegram`],
    ['sub-agent with its own bot', `${INSTALL}/agents/helper-bot/.claude/channels/telegram`],
    ['sub-agent, trailing slash', `${INSTALL}/agents/helper-bot/.claude/channels/telegram/`],
    ['empty', ''],
  ])('state dir %s -> no file read, no fetch', async (_name, stateDir) => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({ stateDir })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.unavailable)
    expect(d.readFileSync).not.toHaveBeenCalled()
  })

  it('a sub-agent state dir is refused even when a token file sits there', async () => {
    const sub = `${INSTALL}/agents/helper-bot`
    const { ctx, rec } = makeCtx()
    const d = makeDeps({
      stateDir: `${sub}/.claude/channels/telegram`,
      files: { [`${sub}/store/.dashboard-token`]: TOKEN, [`${sub}/.env`]: 'WEB_PORT=3555\n', [TOKEN_PATH]: TOKEN },
    })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.unavailable)
    expect(d.readFileSync).not.toHaveBeenCalled()
  })

  it('an install root that is itself named agents still resolves', async () => {
    const inst = '/srv/agents'
    const { ctx } = makeCtx()
    const d = makeDeps({ stateDir: `${inst}/.claude/channels/telegram`, files: { [`${inst}/store/.dashboard-token`]: TOKEN } })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(d.fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing', fsError('ENOENT')],
    ['unreadable', fsError('EACCES')],
    ['empty', ''],
    ['whitespace only', '  \n'],
    ['inner space', 'abc def'],
    ['inner newline', 'abc\ndef'],
    ['non-ASCII', 'tökéletes-token'],
  ])('dashboard token %s -> no fetch', async (_name, token) => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({ files: { [TOKEN_PATH]: token } })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.unavailable)
  })

  it('reads the token and the .env of the install the state dir names, nothing else', async () => {
    const { ctx } = makeCtx()
    const d = makeDeps()
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(d.readFileSync.mock.calls.map(c => c[0])).toEqual([TOKEN_PATH, ENV_PATH])
  })

  it.each<{ name: string; env?: string; port: number; stateDir?: string }>([
    { name: 'no .env', port: 3420 },
    { name: '.env without WEB_PORT', env: 'TELEGRAM_BOT_TOKEN=x\nMAIN_AGENT_ID=marveen\n', port: 3420 },
    { name: 'WEB_PORT=3555', env: 'MAIN_AGENT_ID=marveen\nWEB_PORT=3555\n', port: 3555 },
    { name: 'CRLF line', env: 'WEB_PORT=3555\r\nX=1\r\n', port: 3555 },
    { name: 'commented out', env: '# WEB_PORT=1\n', port: 3420 },
    { name: 'export-prefixed (the dashboard ignores it too)', env: 'export WEB_PORT=3555\n', port: 3420 },
    { name: 'state dir with trailing slash', env: 'WEB_PORT=3556\n', port: 3556, stateDir: `${STATE_DIR}/` },
  ])('port: $name -> $port', async ({ env, port, stateDir }) => {
    const { ctx } = makeCtx()
    const files: Record<string, string | Error> = { [TOKEN_PATH]: TOKEN }
    if (env !== undefined) files[ENV_PATH] = env
    const d = makeDeps({ files, stateDir })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(d.fetchMock).toHaveBeenCalledTimes(1)
    expect(d.fetchMock.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:${port}/api/approvals/${UUID}/telegram`)
  })

  it.each([
    ['quoted', 'WEB_PORT="3555"\n'],
    ['spaced', 'WEB_PORT = 3555\n'],
    ['trailing comment', 'WEB_PORT=3555 # dashboard\n'],
    ['out of range', 'WEB_PORT=99999\n'],
    ['one digit', 'WEB_PORT=8\n'],
    ['empty', 'WEB_PORT=\n'],
    ['not a number', 'WEB_PORT=http\n'],
    ['two lines', 'WEB_PORT=3555\nWEB_PORT=3556\n'],
    ['unreadable .env', fsError('EACCES')],
  ])('port in doubt (%s) -> the token is not sent anywhere', async (_name, env) => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({ files: { [TOKEN_PATH]: TOKEN, [ENV_PATH]: env } })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.unavailable)
  })
})

describe('approval callback block: the request', () => {
  it('approve: exactly one POST to the Telegram decision endpoint with the bearer token and the A3 body', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const { ctx } = makeCtx()
    const d = makeDeps()
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(d.fetchMock).toHaveBeenCalledTimes(1)
    expect(d.fetchMock.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:3420/api/approvals/${UUID}/telegram`)
    const init = sentInit(d.fetchMock)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` })
    expect(JSON.parse(String(init.body))).toEqual({
      status: 'approved',
      resolved_by: `owner:telegram:${OWNER}`,
      telegram_message_id: MSG_ID,
      telegram_chat_id: String(OWNER),
      telegram_chat_type: 'private',
      callback_nonce: NONCE,
      callback_protocol: 1,
    })
    expect(timeoutSpy).toHaveBeenCalledTimes(1)
    expect(timeoutSpy).toHaveBeenCalledWith(10_000)
    expect(init.signal).toBe(timeoutSpy.mock.results[0]?.value)
  })

  it('reject: status "rejected", everything else the same', async () => {
    const { ctx } = makeCtx()
    const d = makeDeps({ respond: async () => jsonResponse(200, okBody('rejected', OUTCOME_R)) })
    await marveenApprovalCallback(ctx, DATA_R, d.deps)
    expect(d.fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(sentInit(d.fetchMock).body))
    expect(body.status).toBe('rejected')
    expect(body.resolved_by).toBe(`owner:telegram:${OWNER}`)
  })

  it('the timeout signal is wired: an abort ends the wait, buttons stay, no retry', async () => {
    const ac = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(ac.signal)
    const { ctx, rec } = makeCtx()
    const d = makeDeps({
      respond: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')))
      }),
    })
    const done = marveenApprovalCallback(ctx, DATA_A, d.deps)
    await vi.waitFor(() => expect(d.fetchMock).toHaveBeenCalledTimes(1))
    ac.abort()
    await done
    expect(d.fetchMock).toHaveBeenCalledTimes(1)
    expect(rec.answers).toEqual([{ text: MARVEEN_APV_TOAST.unavailable }])
    expect(rec.edits).toEqual([])
    expect(rec.markups).toEqual([])
  })
})

describe('approval callback block: server answers', () => {
  it('200 approve -> buttons off, outcome appended, toast', async () => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps()
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(rec.edits).toEqual([{ text: `${MSG_TEXT}\n\n${OUTCOME_A}`, other: undefined }])
    expect(rec.markups).toEqual([])
    expect(rec.answers).toEqual([{ text: MARVEEN_APV_TOAST.approved }])
  })

  it('200 reject -> buttons off, outcome appended, toast', async () => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({ respond: async () => jsonResponse(200, okBody('rejected', OUTCOME_R)) })
    await marveenApprovalCallback(ctx, DATA_R, d.deps)
    expect(rec.edits).toEqual([{ text: `${MSG_TEXT}\n\n${OUTCOME_R}`, other: undefined }])
    expect(rec.answers).toEqual([{ text: MARVEEN_APV_TOAST.rejected }])
  })

  it.each([
    ['no outcome_text', jsonResponse(200, okBody('approved'))],
    ['outcome_text too long', jsonResponse(200, okBody('approved', 'x'.repeat(301)))],
    ['outcome_text not a string', jsonResponse(200, { ok: true, approval: { status: 'approved' }, outcome_text: 42 })],
  ])('200 with %s -> buttons still come off, with the local label', async (_name, response) => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({ respond: async () => response })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(rec.edits).toEqual([{ text: `${MSG_TEXT}\n\n${MARVEEN_APV_TOAST.approved}`, other: undefined }])
    expect(rec.answers).toEqual([{ text: MARVEEN_APV_TOAST.approved }])
  })

  it('409 already_resolved (second press) -> buttons off with the server outcome', async () => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({
      respond: async () => jsonResponse(409, { ok: false, reason: 'already_resolved', status: 'approved', outcome_text: OUTCOME_A }),
    })
    await marveenApprovalCallback(ctx, DATA_R, d.deps)
    expect(rec.edits).toEqual([{ text: `${MSG_TEXT}\n\n${OUTCOME_A}`, other: undefined }])
    expect(rec.answers).toEqual([{ text: MARVEEN_APV_TOAST.alreadyResolved }])
  })

  it.each([
    ['expired', MARVEEN_APV_TOAST.expired],
    ['not_bound', MARVEEN_APV_TOAST.notBound],
  ])('409 %s -> buttons off, the local reason line appended (a server line is not taken) and toasted', async (reason, line) => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({ respond: async () => jsonResponse(409, { ok: false, reason, outcome_text: 'injected line' }) })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(rec.edits).toEqual([{ text: `${MSG_TEXT}\n\n${line}`, other: undefined }])
    expect(rec.answers).toEqual([{ text: line }])
  })

  it('a text that would pass 4096 -> only the buttons come off', async () => {
    const text = 'x'.repeat(4096 - 2 - OUTCOME_A.length + 1)
    const { ctx, rec } = makeCtx({ text })
    const d = makeDeps()
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(rec.edits).toEqual([])
    expect(rec.markups).toEqual([NO_BUTTONS])
    expect(rec.answers).toEqual([{ text: MARVEEN_APV_TOAST.approved }])
  })

  it('a text that lands exactly on 4096 is still edited', async () => {
    const text = 'x'.repeat(4096 - 2 - OUTCOME_A.length)
    const { ctx, rec } = makeCtx({ text })
    const d = makeDeps()
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(rec.edits).toHaveLength(1)
    expect(rec.edits[0]?.text.length).toBe(4096)
    expect(rec.markups).toEqual([])
  })

  it('a message without text -> only the buttons come off', async () => {
    const { ctx, rec } = makeCtx({ text: null })
    const d = makeDeps()
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(rec.edits).toEqual([])
    expect(rec.markups).toEqual([NO_BUTTONS])
  })

  it('a failed text edit falls back to removing the buttons', async () => {
    const { ctx, rec } = makeCtx()
    ctx.editMessageText = vi.fn(() => { throw new Error('Bad Request: message can\'t be edited') })
    const d = makeDeps()
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(rec.markups).toEqual([NO_BUTTONS])
    expect(rec.answers).toEqual([{ text: MARVEEN_APV_TOAST.approved }])
  })

  const TOAST_ONLY: [string, () => Response, string][] = [
    ['403 bad_nonce', () => jsonResponse(403, { ok: false, reason: 'bad_nonce' }), MARVEEN_APV_TOAST.invalid],
    ['403 message_mismatch', () => jsonResponse(403, { ok: false, reason: 'message_mismatch' }), MARVEEN_APV_TOAST.invalid],
    ['403 not_owner', () => jsonResponse(403, { ok: false, reason: 'not_owner' }), MARVEEN_APV_TOAST.forbidden],
    ['403 chat_mismatch', () => jsonResponse(403, { ok: false, reason: 'chat_mismatch' }), MARVEEN_APV_TOAST.forbidden],
    ['400 bad_request', () => jsonResponse(400, { ok: false, reason: 'bad_request' }), MARVEEN_APV_TOAST.unavailable],
    ['401', () => jsonResponse(401, { error: 'unauthorized' }), MARVEEN_APV_TOAST.unavailable],
    ['404 not_found', () => jsonResponse(404, { ok: false, reason: 'not_found' }), MARVEEN_APV_TOAST.notFound],
    // A dashboard older than this block has no such endpoint; its router
    // answers a bare 404 "Not found" (src/web.ts). Nothing is decided there.
    ['404 from a dashboard without the endpoint', () => new Response('Not found', { status: 404 }), MARVEEN_APV_TOAST.unavailable],
    ['404 JSON without the not_found reason', () => jsonResponse(404, { error: 'Not found' }), MARVEEN_APV_TOAST.unavailable],
    ['404 not_found without ok:false', () => jsonResponse(404, { reason: 'not_found' }), MARVEEN_APV_TOAST.unavailable],
    ['409 wrong_category', () => jsonResponse(409, { ok: false, reason: 'wrong_category' }), MARVEEN_APV_TOAST.invalid],
    ['409 unknown reason', () => jsonResponse(409, { ok: false, reason: 'something_new' }), MARVEEN_APV_TOAST.unavailable],
    ['409 without body', () => new Response('', { status: 409 }), MARVEEN_APV_TOAST.unavailable],
    ['500', () => jsonResponse(500, { error: 'internal' }), MARVEEN_APV_TOAST.unavailable],
    ['502 HTML', () => new Response('<html>bad gateway</html>', { status: 502 }), MARVEEN_APV_TOAST.unavailable],
    ['302 redirect', () => new Response('', { status: 302, headers: { location: 'http://evil.example/' } }), MARVEEN_APV_TOAST.unavailable],
    // Only the dashboard's full answer decides; a proxy or a stranger's empty 200 does not
    ['200 empty body', () => new Response('', { status: 200 }), MARVEEN_APV_TOAST.unavailable],
    ['200 body not JSON', () => new Response('ok', { status: 200 }), MARVEEN_APV_TOAST.unavailable],
    ['200 {}', () => jsonResponse(200, {}), MARVEEN_APV_TOAST.unavailable],
    ['200 ok without approval', () => jsonResponse(200, { ok: true, outcome_text: OUTCOME_A }), MARVEEN_APV_TOAST.unavailable],
    ['200 ok as a string', () => jsonResponse(200, { ok: 'true', approval: { status: 'approved' } }), MARVEEN_APV_TOAST.unavailable],
    ['200 ok:false', () => jsonResponse(200, { ok: false, approval: { status: 'approved' } }), MARVEEN_APV_TOAST.unavailable],
    ['200 approval null', () => jsonResponse(200, { ok: true, approval: null }), MARVEEN_APV_TOAST.unavailable],
    ['200 status other than asked', () => jsonResponse(200, okBody('rejected', OUTCOME_R)), MARVEEN_APV_TOAST.unavailable],
    ['200 status pending', () => jsonResponse(200, { ok: true, approval: { status: 'pending' } }), MARVEEN_APV_TOAST.unavailable],
    ['409 already_resolved without status', () => jsonResponse(409, { ok: false, reason: 'already_resolved', outcome_text: OUTCOME_A }), MARVEEN_APV_TOAST.unavailable],
    ['409 already_resolved, status pending', () => jsonResponse(409, { ok: false, reason: 'already_resolved', status: 'pending' }), MARVEEN_APV_TOAST.unavailable],
    ['409 already_resolved without ok:false', () => jsonResponse(409, { reason: 'already_resolved', status: 'approved' }), MARVEEN_APV_TOAST.unavailable],
    ['409 expired with ok:true', () => jsonResponse(409, { ok: true, reason: 'expired' }), MARVEEN_APV_TOAST.unavailable],
    ['409 not_bound without ok', () => jsonResponse(409, { reason: 'not_bound' }), MARVEEN_APV_TOAST.unavailable],
    ['409 reason not a string', () => jsonResponse(409, { ok: false, reason: ['expired'] }), MARVEEN_APV_TOAST.unavailable],
  ]

  it.each(TOAST_ONLY)('%s -> toast only, the buttons stay, no retry', async (_name, response, toast) => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({ respond: async () => response() })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(d.fetchMock).toHaveBeenCalledTimes(1)
    expect(rec.answers).toEqual([{ text: toast }])
    expect(rec.edits).toEqual([])
    expect(rec.markups).toEqual([])
  })

  it.each<[string, () => unknown]>([
    ['network error', () => new TypeError('fetch failed')],
    ['timeout', () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
  ])('%s -> toast only, the buttons stay, no retry', async (_name, err) => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({ respond: async () => { throw err() } })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(d.fetchMock).toHaveBeenCalledTimes(1)
    expect(rec.answers).toEqual([{ text: MARVEEN_APV_TOAST.unavailable }])
    expect(rec.edits).toEqual([])
    expect(rec.markups).toEqual([])
  })
})

describe('approval callback block: a proxy in the path means no request', () => {
  it.each<[string, Record<string, string>]>([
    ['HTTP_PROXY', { HTTP_PROXY: 'http://proxy.test:8080' }],
    ['http_proxy', { http_proxy: 'http://proxy.test:8080' }],
    ['HTTPS_PROXY', { HTTPS_PROXY: 'http://proxy.test:8080' }],
    ['https_proxy', { https_proxy: 'http://proxy.test:8080' }],
    ['ALL_PROXY', { ALL_PROXY: 'socks5://proxy.test:1080' }],
    ['all_proxy', { all_proxy: 'socks5://proxy.test:1080' }],
    ['NO_PROXY=localhost (bun still proxies 127.0.0.1)', { HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: 'localhost' }],
    ['NO_PROXY=127.0.0.0/8 (no CIDR in bun)', { HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: '127.0.0.0/8' }],
    ['NO_PROXY=127.0.0.1:3420', { HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: '127.0.0.1:3420' }],
    ['NO_PROXY=*', { HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: '*' }],
    ['NO_PROXY=127.0.0.1 but no_proxy=other (bun reads no_proxy)', { HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: '127.0.0.1', no_proxy: 'other.test' }],
    // 2nd round: presence is untrimmed, and only outer spaces and tabs are cut from an entry (measured on bun 1.4.2)
    ['NO_PROXY=127.0.0.1 but a blank no_proxy (bun takes it as set)', { HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: '127.0.0.1', no_proxy: '  ' }],
    ['a blank HTTP_PROXY (bun tries it as a proxy)', { HTTP_PROXY: '  ' }],
    ['NBSP before 127.0.0.1', { HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: '\u00a0127.0.0.1' }],
    ['U+2028 after 127.0.0.1', { HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: '127.0.0.1\u2028' }],
    ['a blank NO_PROXY', { HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: ' \t ' }],
  ])('%s -> "unavailable", no file read, no fetch', async (_name, env) => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({ env })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.unavailable)
    expect(d.readFileSync).not.toHaveBeenCalled()
  })

  it.each<[string, unknown]>([
    ['missing', undefined],
    ['null', null],
    ['a string', 'HTTP_PROXY=x'],
  ])('an unusable env (%s) counts as proxied', async (_name, env) => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps()
    ;(d.deps as { env: unknown }).env = env
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.unavailable)
  })

  it.each<[string, Record<string, string>]>([
    ['no proxy variable', { PATH: '/usr/bin', HOME: '/home/x' }],
    ['empty proxy variables', { HTTP_PROXY: '', http_proxy: '' }],
    ['spaces and tabs around the entry', { HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: 'x.test,\t 127.0.0.1 \t,y.test' }],
    ['NO_PROXY=127.0.0.1', { HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: '127.0.0.1' }],
    ['no_proxy list with spaces', { http_proxy: 'http://proxy.test:8080', no_proxy: 'x.test, 127.0.0.1 ,y.test' }],
    ['both spellings list it', { HTTPS_PROXY: 'http://proxy.test:8080', NO_PROXY: '127.0.0.1', no_proxy: 'a.test,127.0.0.1' }],
  ])('%s -> the request goes out', async (_name, env) => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({ env })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(d.fetchMock).toHaveBeenCalledTimes(1)
    expect(rec.answers).toEqual([{ text: MARVEEN_APV_TOAST.approved }])
  })
})

describe('approval callback block: the env the plugin loaded with counts too', () => {
  it('a proxy only in the load-time snapshot (deleted since) -> no request', async () => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({ env: {}, envAtLoad: { HTTP_PROXY: 'http://proxy.test:8080' } })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.unavailable)
  })

  it('NO_PROXY=127.0.0.1 now does not clear a proxy the snapshot has uncovered', async () => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({
      env: { HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: '127.0.0.1' },
      envAtLoad: { HTTP_PROXY: 'http://proxy.test:8080' },
    })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.unavailable)
  })

  it.each<[string, unknown]>([['missing', undefined], ['null', null]])('an unusable snapshot (%s) counts as proxied', async (_name, snap) => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps()
    ;(d.deps as { envAtLoad: unknown }).envAtLoad = snap
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.unavailable)
  })

  it('both covered by NO_PROXY=127.0.0.1 -> the request goes out', async () => {
    const env = { HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: '127.0.0.1' }
    const { ctx } = makeCtx()
    const d = makeDeps({ env, envAtLoad: { ...env } })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expect(d.fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('approval callback block: never throws, answers once', () => {
  it('a rejecting or throwing answerCallbackQuery does not escape', async () => {
    for (const answer of [
      vi.fn(async () => { throw new Error('query is too old') }),
      vi.fn(() => { throw new Error('sync throw') }),
    ]) {
      const { ctx } = makeCtx()
      ctx.answerCallbackQuery = answer as unknown as MarveenApvCtx['answerCallbackQuery']
      const d = makeDeps()
      await expect(marveenApprovalCallback(ctx, DATA_A, d.deps)).resolves.toBeUndefined()
      expect(answer).toHaveBeenCalledTimes(1)
    }
  })

  it('both edits failing still ends in one toast', async () => {
    const { ctx, rec } = makeCtx()
    ctx.editMessageText = vi.fn(async () => { throw new Error('edit failed') })
    ctx.editMessageReplyMarkup = vi.fn(async () => { throw new Error('edit failed') })
    const d = makeDeps()
    await expect(marveenApprovalCallback(ctx, DATA_A, d.deps)).resolves.toBeUndefined()
    expect(rec.answers).toEqual([{ text: MARVEEN_APV_TOAST.approved }])
  })

  it('a non-Error thrown by the file read is fail-closed', async () => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps()
    d.deps.readFileSync = () => { throw 'boom' }
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    expectRefusedBeforeHttp(rec, d, MARVEEN_APV_TOAST.unavailable)
  })
})

describe('approval callback block: secrets never surface', () => {
  const SCENARIOS: [string, () => Promise<Response>][] = [
    ['200', async () => jsonResponse(200, okBody('approved', OUTCOME_A))],
    ['409', async () => jsonResponse(409, { ok: false, reason: 'already_resolved', outcome_text: OUTCOME_A })],
    ['403', async () => jsonResponse(403, { ok: false, reason: 'bad_nonce' })],
    ['500', async () => jsonResponse(500, { error: 'internal' })],
    ['network error', async () => { throw new TypeError(`fetch failed for ${TOKEN}`) }],
  ]

  it.each(SCENARIOS)('%s: no token, nonce or callback_data in any toast or edit', async (_name, respond) => {
    const { ctx, rec } = makeCtx()
    const d = makeDeps({ respond })
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    const surfaced = JSON.stringify(rec)
    expect(surfaced).not.toContain(TOKEN)
    expect(surfaced).not.toContain(NONCE)
    expect(surfaced).not.toContain(ID32)
    // console spies are checked in afterEach
  })

  it('the token goes only into the Authorization header of the one request', async () => {
    const { ctx } = makeCtx()
    const d = makeDeps()
    await marveenApprovalCallback(ctx, DATA_A, d.deps)
    const [url, init] = d.fetchMock.mock.calls[0] ?? []
    expect(String(url)).not.toContain(TOKEN)
    expect(String(init?.body)).not.toContain(TOKEN)
  })
})

describe('approval callback block: perm:* stays with the plugin', () => {
  // The call line the patcher puts in front of the perm: regex (blueprint 4.6).
  async function pluginHandler(ctx: MarveenApvCtx, data: string, deps: MarveenApvDeps, permBranch: (d: string) => Promise<void>) {
    if (data.startsWith('apv:')) { await marveenApprovalCallback(ctx, data, deps); return }
    await permBranch(data)
  }

  it('a perm: press reaches the perm branch untouched; an apv: press never does', async () => {
    const perm = vi.fn(async (_d: string) => {})
    for (const data of ['perm:allow:abcde', 'perm:deny:abcde', 'perm:more:abcde']) {
      const { ctx, rec } = makeCtx()
      const d = makeDeps()
      await pluginHandler(ctx, data, d.deps, perm)
      expect(rec.answers).toEqual([])
      expect(d.fetchMock).not.toHaveBeenCalled()
    }
    expect(perm.mock.calls.map(c => c[0])).toEqual(['perm:allow:abcde', 'perm:deny:abcde', 'perm:more:abcde'])

    perm.mockClear()
    const { ctx } = makeCtx()
    const d = makeDeps()
    await pluginHandler(ctx, DATA_A, d.deps, perm)
    expect(perm).not.toHaveBeenCalled()
    expect(d.fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('approval callback block: source contract (it is inlined into server.ts)', () => {
  const src = readFileSync(new URL('../telegram-plugin-patches/approval-callback.ts', import.meta.url), 'utf-8')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  // The same list scripts/patch-telegram-plugin.py refuses a source on (APV_DENY).
  const DENY: RegExp[] = [
    /\bimport\b/, /\brequire\b/, /mcp/i, /notification/i, /console\./, /\bprocess\b/, /\beval\b/, /\bFunction\b/,
    /\bBun\b/, /child_process|\bexecFile|\bexecSync|\bspawn/, /globalThis/,
  ]

  it('loads nothing and cannot reach the model, a log, the process or a shell', () => {
    for (const rx of DENY) expect(src).not.toMatch(rx)
  })

  it('every export is a line-leading declaration the patcher can cut to plain code', () => {
    expect(code).not.toMatch(/export\s+default/)
    expect(code).not.toMatch(/^export\s*\{/m)
    for (const line of code.split('\n')) {
      if (/\bexport\b/.test(line)) expect(line).toMatch(/^export (async function|function|const|interface|type) /)
    }
  })

  it('every top-level name is prefixed, so it cannot collide with a plugin name', () => {
    const names = [...code.matchAll(/^(?:export )?(?:async )?(?:function|const|let|var|class|interface|type) ([A-Za-z_$][\w$]*)/gm)].map(m => m[1])
    expect(names.length).toBeGreaterThan(5)
    for (const name of names) {
      expect(name).toMatch(/^(marveenApv|MarveenApv|MARVEEN_APV_)|^marveenApprovalCallback$/)
    }
    expect(names).toContain('marveenApprovalCallback')
    expect(marveenApprovalCallback.length).toBe(3)
  })
})

describe('approval callback block: codec parity with src/web/approval-callback-data.ts', () => {
  it('the regex is the blueprint 4.2 contract and the server codec\'s, byte for byte', () => {
    expect(MARVEEN_APV_CALLBACK_RE.source).toBe('^apv:([ar]):([0-9a-f]{32}):([A-Za-z0-9_-]{22})$')
    expect(MARVEEN_APV_CALLBACK_RE.source).toBe(APPROVAL_CALLBACK_RE.source)
    expect(MARVEEN_APV_CALLBACK_RE.flags).toBe(APPROVAL_CALLBACK_RE.flags)
  })

  it('a server-built button is accepted, and maps back to the same approval and nonce', async () => {
    for (let i = 0; i < 20; i++) {
      const uuid = randomUUID()
      for (const decision of ['approved', 'rejected'] as const) {
        // one nonce per button, as the notifier mints them
        const nonce = newCallbackNonce()
        const data = buildCallbackData(decision, uuid, nonce)
        const { ctx } = makeCtx()
        const d = makeDeps({ respond: async () => jsonResponse(200, okBody(decision, OUTCOME_A)) })
        await marveenApprovalCallback(ctx, data, d.deps)
        expect(d.fetchMock).toHaveBeenCalledTimes(1)
        expect(d.fetchMock.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:3420/api/approvals/${parseCallbackData(data)?.approvalId}/telegram`)
        expect(parseCallbackData(data)?.approvalId).toBe(uuid)
        const body = JSON.parse(String(sentInit(d.fetchMock).body))
        expect(body.status).toBe(decision)
        expect(body.callback_nonce).toBe(nonce)
      }
    }
  })
})
