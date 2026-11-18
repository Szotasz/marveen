// GMAILDRAFT1116 (PR #2824 review B1 + N1): POST /api/gmail/draft writes a draft inside the dashboard process with a
// mocked Gmail (no network). Covered here: the happy path and the read-back, the closed request list (drafts.create,
// drafts.get of the new draft and the token endpoint only; no send route), CR/LF refusal in every header value, the
// store/outbox/ allow-list (../, absolute, symlink escape, symlinked outbox, hidden and secret names, size), the
// principal matrix, the owner-CC and recipient-ledger checks, the owner-only credential routes, and the audit line.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, truncateSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const ROOT = mkdtempSync(join(tmpdir(), 'gmail-draft-endpoint-'))
const STORE = join(ROOT, 'store')
mkdirSync(STORE, { recursive: true })
const OUTSIDE = mkdtempSync(join(tmpdir(), 'gmail-draft-outside-'))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()), STORE_DIR: STORE, PROJECT_ROOT: ROOT, MAIN_AGENT_ID: 'marveen',
}))
const logSpy = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: logSpy, PRETTY_OPTIONS: {} }))
vi.mock('../db.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../db.js')>()), countDashboardUsers: () => 1 }))
const notifySpy = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../notify.js', () => ({ notifySecurityEvent: notifySpy, notifyOwner: vi.fn(), notifyChannel: vi.fn() }))

const vaultMem = vi.hoisted(() => new Map<string, string>())
vi.mock('../web/vault.js', () => ({
  listSecrets: () => [], setSecret: () => undefined, getSecret: () => null, deleteSecret: () => false, getSecretsForEnv: () => ({}),
  reservedVaultAccess: {
    read: (id: string) => vaultMem.get(id) ?? null,
    present: (id: string) => vaultMem.has(id),
    write: (id: string, _l: string, v: string) => { vaultMem.set(id, v) },
    remove: (id: string) => vaultMem.delete(id),
  },
}))

const savedEnvDir = process.env.CLAUDECLAW_ENV_DIR
process.env.CLAUDECLAW_ENV_DIR = ROOT
const gd = await import('../web/gmail-draft.js')
const { tryHandleGmailDraft } = await import('../web/routes/gmail-draft.js')
const { setOverride, clearOverride } = await import('../settings-store.js')
const { agentScopeDenial, requiresAuth } = await import('../web/auth-gate.js')

afterAll(() => {
  if (savedEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = savedEnvDir
  gd._setGmailFetchForTest(null)
  gd._setLedgerLoaderForTest(null)
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
})

// ---- a mocked Gmail -------------------------------------------------------------------------------------------------
type Call = { method: string; url: string; body?: string; headers: Record<string, string> }
let calls: Call[] = []
let lastRaw = ''
let readbackDrop: string | null = null
function mockGmail() {
  gd._setGmailFetchForTest(async (url, init) => {
    calls.push({ method: init.method, url, body: init.body, headers: init.headers })
    const ok = (j: unknown) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) })
    if (url === gd.TOKEN_URL) return ok({ access_token: 'AT-test-1', expires_in: 3600 })
    if (init.method === 'POST' && url === gd.DRAFTS_URL) {
      lastRaw = Buffer.from(JSON.parse(init.body as string).message.raw, 'base64url').toString('utf8')
      return ok({ id: 'r-123', message: { id: 'm-1', threadId: 't-1' } })
    }
    if (init.method === 'GET' && url === `${gd.DRAFTS_URL}/r-123?format=full`) {
      const header = (n: string) => (lastRaw.match(new RegExp(`^${n}: (.*)$`, 'mi')) ?? [])[1] ?? ''
      const files = [...lastRaw.matchAll(/filename="([^"]+)"/g)].map(m => m[1]).filter(f => f !== readbackDrop)
      return ok({ message: { payload: { headers: [{ name: 'To', value: header('To') }, { name: 'Cc', value: header('Cc') }], parts: files.map(f => ({ filename: f })) } } })
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not mocked' }
  })
}

const CLIENT = JSON.stringify({ installed: { client_id: 'cid.apps.googleusercontent.com', client_secret: 'csecret-test' } })
const REFRESH = '1//refresh-token-test-value'

beforeEach(() => {
  calls = []; lastRaw = ''; readbackDrop = null
  logSpy.info.mockClear(); logSpy.warn.mockClear(); notifySpy.mockClear()
  vaultMem.clear()
  vaultMem.set(gd.GMAIL_DRAFT_CLIENT_ID, CLIENT)
  vaultMem.set(gd.GMAIL_DRAFT_REFRESH_ID, REFRESH)
  clearOverride('GMAIL_DRAFT_AGENTS')
  rmSync(join(ROOT, '.env'), { force: true })
  rmSync(join(STORE, 'outbox'), { recursive: true, force: true })
  mkdirSync(join(STORE, 'outbox', 'offers'), { recursive: true })
  writeFileSync(join(STORE, 'outbox', 'offers', 'ajanlat.pdf'), '%PDF-1.4 test')
  writeFileSync(join(STORE, 'outbox', 'logo.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8), Buffer.from([0, 0, 0, 120, 0, 0, 0, 60])]))
  delete process.env.NODE_USE_ENV_PROXY
  delete process.env.NODE_EXTRA_CA_CERTS
  gd._resetGmailDraftStateForTest()
  mockGmail()
})

// ---- calling the route ------------------------------------------------------------------------------------------------
type Auth = RouteContext['auth']
const SESSION: Auth = { kind: 'session', user: 'owner' }
const MAIN: Auth = { kind: 'token' }
const MAIN_CLAIM: Auth = { kind: 'token', agent: 'marveen' }
const CLAIM_SUB: Auth = { kind: 'token', agent: 'grafit' }
const SUB_TOKEN: Auth = { kind: 'token', agent: 'grafit', tokenAgent: 'grafit' }
const DEVICE: Auth = { kind: 'device', device: 'phone', deviceId: 1, scope: 'full' }
const FED: Auth = { kind: 'federation', peer: 'peer-a' }

function mkRes() {
  const r = {
    statusCode: 200, body: '', headers: {} as Record<string, string>,
    writeHead(c: number, h?: Record<string, string>) { r.statusCode = c; Object.assign(r.headers, h ?? {}) },
    end(b?: string) { r.body = b ?? '' },
    setHeader(k: string, v: string) { r.headers[k] = v },
    getHeader(k: string) { return r.headers[k] },
  }
  return r
}
async function call(method: string, path: string, auth: Auth, body?: unknown) {
  const res = mkRes()
  const raw = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  const req = (raw !== undefined ? Readable.from([Buffer.from(raw)]) : Readable.from([])) as unknown as http.IncomingMessage
  Object.assign(req, { headers: {}, method, url: path })
  const ctx: RouteContext = { req, res: res as unknown as http.ServerResponse, path, method, url: new URL(`http://127.0.0.1:3420${path}`), auth }
  const handled = await tryHandleGmailDraft(ctx)
  return { handled, status: res.statusCode, body: res.body, json: () => JSON.parse(res.body) }
}
const draft = (body: unknown, auth: Auth = MAIN) => call('POST', '/api/gmail/draft', auth, body)
const BASE = { to: 'Kovács Anna <anna@example.com>', cc: ['owner@example.com'], subject: 'Ajánlat: TV most', text: 'Szia Anna,\n\nmellékelem.\n' }
const auditRows = () => [...logSpy.info.mock.calls, ...logSpy.warn.mock.calls].map(c => c[0]).filter(f => f?.event === 'gmail-draft')

describe('happy path (mocked Gmail, no network)', () => {
  it('D1 writes one draft, reads it back, and calls only the token endpoint, drafts.create and drafts.get', async () => {
    const r = await draft({ ...BASE, html: '<p>Szia</p><img src="cid:logo.png">', inline: ['logo.png'], attachments: ['offers/ajanlat.pdf'], alsoAttach: true, threadId: 't-1', inReplyTo: '<orig@mail.example.com>' })
    expect(r.status).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, draftId: 'r-123', readback: { ok: true, problems: [] } })
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      `POST ${gd.TOKEN_URL}`, `POST ${gd.DRAFTS_URL}`, `GET ${gd.DRAFTS_URL}/r-123?format=full`,
    ])
    expect(calls[1].headers.Authorization).toBe('Bearer AT-test-1')
    expect(JSON.parse(calls[1].body as string).message.threadId).toBe('t-1')
    expect(lastRaw).toMatch(/^To: =\?UTF-8\?B\?[^?]+\?= <anna@example\.com>$/m)
    expect(lastRaw).toMatch(/^Cc: owner@example\.com$/m)
    expect(lastRaw).toMatch(/^Subject: =\?UTF-8\?B\?/m)
    expect(lastRaw).toMatch(/^In-Reply-To: <orig@mail\.example\.com>$/m)
    expect(lastRaw).toMatch(/X-Attachment-Id: ii_[a-z0-9]{10}/)
    expect(lastRaw).toMatch(/Content-Type: application\/pdf; name="ajanlat\.pdf"/)
    // the HTML refers to the inline image by Gmail's id, with its size
    const htmlPart = [...lastRaw.matchAll(/Content-Type: text\/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)][0][1]
    const html = Buffer.from(htmlPart.replace(/\r\n/g, ''), 'base64').toString('utf8')
    expect(html).toMatch(/<img src="cid:ii_[a-z0-9]{10}" width="120" height="60">/)
    expect(lastRaw).not.toMatch(/\r\nBcc:/)
  })

  it('D2 the audit line names who, the counts, the subject hash and the draft id, never the body, subject or an address', async () => {
    await draft(BASE)
    const rows = auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'written', kind: 'main-token', to_count: 1, cc_count: 1, bcc_count: 0, draft_id: 'r-123', subject_sha256: gd.subjectHash(BASE.subject) })
    const logged = JSON.stringify([...logSpy.info.mock.calls, ...logSpy.warn.mock.calls])
    for (const s of ['anna@example.com', 'Ajánlat', 'mellékelem', REFRESH, 'csecret-test', 'AT-test-1']) expect(logged).not.toContain(s)
  })

  it('D3 the access token is cached: a second draft does not refresh again', async () => {
    await draft(BASE)
    await draft(BASE)
    expect(calls.filter(c => c.url === gd.TOKEN_URL)).toHaveLength(1)
    expect(calls.filter(c => c.url === gd.DRAFTS_URL)).toHaveLength(2)
  })

  it('D4 a read-back that misses a file says so (the client verb exits 1 on it)', async () => {
    readbackDrop = 'ajanlat.pdf'
    gd._setGmailFetchForTest(null); mockGmail()
    const r = await draft({ ...BASE, attachments: ['offers/ajanlat.pdf'] })
    expect(r.status).toBe(200)
    expect(r.json().readback).toMatchObject({ ok: false, problems: ['missing attachment: ajanlat.pdf'] })
  })

  it('D5 not configured -> 409, nothing sent to Google', async () => {
    vaultMem.clear()
    const r = await draft(BASE)
    expect(r.status).toBe(409)
    expect(r.json().code).toBe('not-configured')
    expect(calls).toHaveLength(0)
  })

  it('D6 the response never carries a credential or the access token', async () => {
    const r = await draft(BASE)
    for (const s of [REFRESH, 'csecret-test', 'AT-test-1']) expect(r.body).not.toContain(s)
  })
})

describe('the closed request list: no send route is reachable', () => {
  it('N1 only the token endpoint, drafts.create and drafts.get(<id>, format=full) are allowed', () => {
    expect(gd.isAllowedGmailRequest('POST', gd.TOKEN_URL)).toBe(true)
    expect(gd.isAllowedGmailRequest('POST', gd.DRAFTS_URL)).toBe(true)
    expect(gd.isAllowedGmailRequest('GET', `${gd.DRAFTS_URL}/r-123?format=full`)).toBe(true)
    const G = 'https://gmail.googleapis.com/gmail/v1/users/me'
    for (const [m, u] of [
      ['POST', `${G}/drafts/send`], ['POST', `${G}/messages/send`], ['POST', `${G}/messages`], ['POST', `${G}/messages/import`],
      ['POST', `${G}/messages/insert`], ['PUT', `${G}/drafts/r-123`], ['POST', `${G}/drafts/r-123`], ['DELETE', `${G}/drafts/r-123`],
      ['GET', `${G}/drafts/send?format=full`.replace('send', 'a/../send')], ['GET', `${G}/drafts/r-123`], ['GET', `${G}/messages/m-1?format=full`],
      ['GET', gd.TOKEN_URL], ['POST', 'http://gmail.googleapis.com/gmail/v1/users/me/drafts'], ['POST', `${gd.DRAFTS_URL}?uploadType=media`],
      ['POST', 'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts'], ['POST', 'https://evil.example/token'],
      ['POST', `${G}/drafts/`], ['GET', `${G}/drafts/r-123?format=full&x=1`], ['POST', 'https://www.googleapis.com/gmail/v1/users/me/messages/send'],
      ['POST', 'https://gmail.googleapis.com/batch/gmail/v1'],
    ] as const) expect(gd.isAllowedGmailRequest(m, u), `${m} ${u}`).toBe(false)
  })

  it('N2 source scan: every URL the writer names is the token endpoint or the drafts collection; no send path is written in it', () => {
    const src = readFileSync(new URL('../web/gmail-draft.ts', import.meta.url), 'utf8')
    const urls = [...src.matchAll(/https?:\/\/[^\s'"`)]+/g)].map(m => m[0])
    expect(urls.sort()).toEqual([gd.TOKEN_URL, gd.DRAFTS_URL].sort())
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\/\*\*|\*)/.test(l)).join('\n')
    expect(code).not.toMatch(/\/send\b|messages\/|\.send\(/)
    // one network primitive, behind the list
    expect(code.match(/fetchImpl\(/g)).toHaveLength(1)
  })

  it('N3 a proxy or extra CA roots in the environment: refused before any request', async () => {
    process.env.NODE_USE_ENV_PROXY = '1'
    const r = await draft(BASE)
    expect(r.status).toBe(500)
    expect(r.json().code).toBe('unsafe-network-env')
    expect(calls).toHaveLength(0)
    delete process.env.NODE_USE_ENV_PROXY
    process.env.NODE_EXTRA_CA_CERTS = '/tmp/ca.pem'
    expect((await draft(BASE)).json().code).toBe('unsafe-network-env')
    expect(calls).toHaveLength(0)
  })
})

describe('header injection: a line break in any header value is refused, nothing goes out', () => {
  for (const [field, value] of [
    ['subject', 'Hi\r\nBcc: evil@example.com'], ['subject', 'Hi\nX: y'], ['to', 'a@example.com\r\nBcc: evil@example.com'],
    ['cc', ['ok@example.com', 'b@example.com\nBcc: e@example.com']], ['bcc', 'c@example.com\r'], ['inReplyTo', '<id@x>\r\nBcc: e@example.com'],
  ] as const) {
    it(`H ${field} = ${JSON.stringify(value).slice(0, 40)}`, async () => {
      const r = await draft({ ...BASE, [field]: value })
      expect(r.status).toBe(400)
      expect(r.json().code).toBe('header-line-break')
      expect(calls).toHaveLength(0)
    })
  }
  it('H other control characters, bad addresses, unknown fields and a bad thread id are refused too', async () => {
    for (const [body, code] of [
      [{ ...BASE, subject: 'a\u0000b' }, 'header-control-char'],
      [{ ...BASE, to: 'not-an-address' }, 'bad-address'],
      [{ ...BASE, to: 'a@example.com b@example.com' }, 'bad-address'],
      [{ ...BASE, to: '"Evil, <x@y.z>" <a@example.com>' }, 'bad-address'],
      [{ ...BASE, to: 'Name "quoted" <a@example.com>' }, 'bad-address'],
      [{ ...BASE, raw: 'x' }, 'unknown-field'],
      [{ ...BASE, threadId: '../send' }, 'bad-thread-id'],
      [{ ...BASE, inline: ['logo.png'] }, 'inline-needs-html'],
    ] as const) {
      const r = await draft(body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.json().code).toBe(code)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('attachments only from store/outbox/ (review N1)', () => {
  const refused = async (name: string) => {
    const r = await draft({ ...BASE, attachments: [name] })
    expect(r.status, name).toBe(400)
    expect(calls, name).toHaveLength(0)
    return r.json().code as string
  }
  it('A1 a nested file inside the outbox is attached', async () => {
    expect((await draft({ ...BASE, attachments: ['offers/ajanlat.pdf'] })).status).toBe(200)
  })
  it('A2 ../, absolute, backslash, empty and dot components are refused', async () => {
    writeFileSync(join(STORE, 'claudeclaw.db'), 'db')
    for (const n of ['../claudeclaw.db', 'offers/../../claudeclaw.db', join(STORE, 'claudeclaw.db'), '/etc/passwd', 'offers\\ajanlat.pdf', '', './logo.png', 'offers//ajanlat.pdf']) {
      expect(await refused(n)).toBe('outbox-file-refused')
    }
  })
  it('A3 a symlink inside the outbox pointing out of it is refused (also a plain-named one to a secret)', async () => {
    writeFileSync(join(OUTSIDE, 'secret.txt'), 'x')
    symlinkSync(join(OUTSIDE, 'secret.txt'), join(STORE, 'outbox', 'report.pdf'))
    writeFileSync(join(STORE, '.dashboard-token'), 'tok')
    symlinkSync(join(STORE, '.dashboard-token'), join(STORE, 'outbox', 'notes.txt'))
    symlinkSync(OUTSIDE, join(STORE, 'outbox', 'dir'))
    expect(await refused('report.pdf')).toBe('outbox-file-refused')
    expect(await refused('notes.txt')).toBe('outbox-file-refused')
    expect(await refused('dir/secret.txt')).toBe('outbox-file-refused')
  })
  it('A4 a store/outbox that is itself a symlink is refused', async () => {
    rmSync(join(STORE, 'outbox'), { recursive: true, force: true })
    writeFileSync(join(OUTSIDE, 'a.pdf'), 'x')
    symlinkSync(OUTSIDE, join(STORE, 'outbox'))
    expect(await refused('a.pdf')).toBe('outbox-file-refused')
  })
  it('A5 the deny list stays as a second line: hidden and secret-looking names inside the outbox', async () => {
    for (const n of ['.env', '.hidden/a.pdf', 'api-token.txt', 'vault.json', 'my-secret.pdf', 'credentials.json', 'passwords.xlsx', 'server.pem', 'id_ed25519', 'x.key']) {
      const p = join(STORE, 'outbox', n)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, 'x')
      expect(await refused(n)).toBe('outbox-file-refused')
    }
  })
  it('A6 a directory, a missing file, a file over 25 MB and a missing outbox are refused', async () => {
    expect(await refused('offers')).toBe('outbox-file-refused')
    expect(await refused('nope.pdf')).toBe('outbox-file-refused')
    writeFileSync(join(STORE, 'outbox', 'big.pdf'), '')
    truncateSync(join(STORE, 'outbox', 'big.pdf'), 25 * 1024 * 1024 + 1)
    expect(await refused('big.pdf')).toBe('outbox-file-refused')
    rmSync(join(STORE, 'outbox'), { recursive: true, force: true })
    expect(await refused('a.pdf')).toBe('outbox-missing')
  })
})

describe('principal matrix', () => {
  it('P1 owner session, the main token, and the main token claiming the main agent may write', async () => {
    for (const a of [SESSION, MAIN, MAIN_CLAIM]) expect((await draft(BASE, a)).status).toBe(200)
  })
  it('P2 a sub-agent own token is refused unless GMAIL_DRAFT_AGENTS lists it; listed, it may', async () => {
    let r = await draft(BASE, SUB_TOKEN)
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('gmail-draft-agent-not-listed')
    expect(calls).toHaveLength(0)
    expect(setOverride('GMAIL_DRAFT_AGENTS', 'grafit').ok).toBe(true)
    gd._setLedgerLoaderForTest(async () => ({ inspectLedger: () => ({ ledger: { recipients: {} }, missing: false, reason: null }), isVerifiedIn: () => true }))
    r = await draft(BASE, SUB_TOKEN)
    expect(r.status).toBe(200)
    gd._setLedgerLoaderForTest(null)
  })
  it('P3 a shared-token caller that claims an unlisted sub-agent is held to the same list', async () => {
    const r = await draft(BASE, CLAIM_SUB)
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('gmail-draft-agent-not-listed')
  })
  it('P4 a device key without the owner session, a federation peer, and no credential are refused', async () => {
    expect((await draft(BASE, DEVICE)).status).toBe(403)
    expect((await draft(BASE, FED)).status).toBe(403)
    expect((await call('POST', '/api/gmail/draft', undefined, BASE)).status).toBe(401)
    expect(calls).toHaveLength(0)
  })
  it('P5 the auth gate: the path is gated, and a sub-agent token reaches it only when listed', () => {
    expect(requiresAuth('/api/gmail/draft')).toBe(true)
    const deny = () => agentScopeDenial({ kind: 'token', tokenAgent: 'grafit', agent: 'grafit' }, '/api/gmail/draft', 'POST', 'marveen', () => ({}))
    expect(deny()?.status).toBe(403)
    setOverride('GMAIL_DRAFT_AGENTS', 'grafit')
    expect(deny()).toBeNull()
    expect(agentScopeDenial({ kind: 'token', tokenAgent: 'other', agent: 'other' }, '/api/gmail/draft', 'POST', 'marveen', () => ({}))?.status).toBe(403)
    for (const p of ['/api/gmail/draft/credentials', '/api/gmail/draft/status']) {
      expect(agentScopeDenial({ kind: 'token', tokenAgent: 'grafit', agent: 'grafit' }, p, 'PUT', 'marveen', () => ({}))?.status).toBe(403)
    }
  })
  it('P6 adding a name to GMAIL_DRAFT_AGENTS is a loosening (owner only), removing one is not', async () => {
    const { SETTINGS_REGISTRY } = await import('../config-registry.js') as unknown as { SETTINGS_REGISTRY: Array<{ key: string; loosens?: (a: string, b: string) => boolean; validate?: (v: string) => string | null }> }
    const def = SETTINGS_REGISTRY.find(d => d.key === 'GMAIL_DRAFT_AGENTS')!
    expect(def.loosens!('', 'grafit')).toBe(true)
    expect(def.loosens!('grafit,vizit', 'grafit')).toBe(false)
    expect(def.validate!('grafit, vizit')).toBeNull()
    expect(def.validate!('../x')).not.toBeNull()
  })
})

describe('owner copy and recipient ledger', () => {
  it('C1 MAIL_OWNER_CC set: an agent draft without the owner is refused; with the owner it passes; the owner session is not held to it', async () => {
    writeFileSync(join(ROOT, '.env'), 'MAIL_OWNER_CC=boss@example.com\n')
    let r = await draft(BASE)
    expect(r.status).toBe(400)
    expect(r.json().code).toBe('owner-cc-missing')
    r = await draft({ ...BASE, bcc: 'Boss@Example.com' })
    expect(r.status).toBe(200)
    expect((await draft(BASE, SESSION)).status).toBe(200)
  })
  it('C2 the ledger binds a sub-agent (always) and the main agent when its switch is on; fail-closed when the module does not load', async () => {
    setOverride('GMAIL_DRAFT_AGENTS', 'grafit')
    gd._setLedgerLoaderForTest(async () => ({ inspectLedger: () => ({ ledger: { recipients: { 'owner@example.com': {} } }, missing: false, reason: null }), isVerifiedIn: (l: any, a: string) => Object.hasOwn(l.recipients, a.toLowerCase()) }))
    let r = await draft(BASE, SUB_TOKEN)
    expect(r.status).toBe(400)
    expect(r.json()).toMatchObject({ code: 'recipient-not-verified' })
    expect(r.json().error).toContain('anna@example.com')
    expect((await draft(BASE, MAIN)).status).toBe(200)
    writeFileSync(join(ROOT, '.env'), 'MAIN_AGENT_RECIPIENT_LEDGER=1\n')
    expect((await draft(BASE, MAIN)).status).toBe(400)
    gd._setLedgerLoaderForTest(async () => { throw new Error('no module') })
    r = await draft(BASE, SUB_TOKEN)
    expect(r.status).toBe(500)
    expect(r.json().code).toBe('ledger-unavailable')
    gd._setLedgerLoaderForTest(null)
    expect(calls.filter(c => c.url === gd.DRAFTS_URL)).toHaveLength(1)
  })
  it('C3 the real recipient-ledger.mjs loads and fails closed on a missing ledger', async () => {
    gd._setLedgerLoaderForTest(async () => await import('../../scripts/recipient-ledger.mjs') as any)
    setOverride('GMAIL_DRAFT_AGENTS', 'grafit')
    const r = await draft(BASE, SUB_TOKEN)
    expect(r.status).toBe(400)
    expect(r.json().code).toBe('ledger-unusable')
    gd._setLedgerLoaderForTest(null)
  })
})

describe('credential routes: owner only, never read back', () => {
  it('K1 PUT by the shared token, a sub-agent token or a device without the owner is refused; nothing is written', async () => {
    vaultMem.clear()
    for (const a of [MAIN, MAIN_CLAIM, SUB_TOKEN, DEVICE, FED]) {
      const r = await call('PUT', '/api/gmail/draft/credentials', a, { client: CLIENT, refreshToken: REFRESH })
      expect(r.status).toBe(403)
    }
    expect(vaultMem.size).toBe(0)
    expect((await call('DELETE', '/api/gmail/draft/credentials', MAIN)).status).toBe(403)
  })
  it('K2 the owner stores and removes it; the answer carries no value; the owner is told', async () => {
    vaultMem.clear()
    const r = await call('PUT', '/api/gmail/draft/credentials', SESSION, { client: CLIENT, refreshToken: REFRESH })
    expect(r.status).toBe(200)
    expect(r.json()).toEqual({ ok: true, configured: true })
    expect(vaultMem.get(gd.GMAIL_DRAFT_REFRESH_ID)).toBe(REFRESH)
    expect(notifySpy).toHaveBeenCalledTimes(1)
    const bad = await call('PUT', '/api/gmail/draft/credentials', SESSION, { client: '{"x":1}', refreshToken: REFRESH })
    expect(bad.status).toBe(400)
    const st = await call('GET', '/api/gmail/draft/status', MAIN)
    expect(st.json()).toEqual({ configured: true, agents: [] })
    expect(st.body).not.toContain(REFRESH)
    expect((await call('DELETE', '/api/gmail/draft/credentials', SESSION)).json()).toEqual({ ok: true, removed: true })
    expect(vaultMem.size).toBe(0)
  })
  it('K3 the legacy ids of the first PR version are used as a fallback (they are reserved too)', async () => {
    vaultMem.clear()
    vaultMem.set('GMAIL_DRAFT_OAUTH_CLIENT', CLIENT)
    vaultMem.set('GMAIL_DRAFT_COMPOSE_REFRESH', REFRESH)
    expect((await draft(BASE)).status).toBe(200)
  })
})
