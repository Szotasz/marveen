// T1 acceptance of PR-I2 (MIOAGENTINSTALL1114, plan 10.2 (4), mutant row 15): the device token never leaves remote.ts.
//
// Every route, on its ordinary and its broken inputs, is run against the fake server; every response body and header,
// and every ARGUMENT of every logger call (captured before the redactor: the logger is a recorder here), is searched
// for the test token AND for every 8-character piece of it (JSON.parse quotes the first characters of its input in
// its message, so a forwarded parse error is a partial leak). The test token has the real mdt_ shape.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-agent-package-leak-'))
const STORE = join(tmpRoot, 'store')
mkdirSync(STORE, { recursive: true })
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store') }))

const logged: unknown[][] = []
vi.mock('../logger.js', () => {
  const rec = (...args: unknown[]) => { logged.push(args) }
  const l: any = { info: rec, warn: rec, error: rec, debug: rec, trace: rec, fatal: rec }
  l.child = (...args: unknown[]) => { logged.push(args); return l }
  return { logger: l }
})

const { initDatabase, getDb, createDashboardUser } = await import('../db.js')
const { tryHandleAgentPackages } = await import('../web/routes/agent-packages.js')
const { makeRemote } = await import('../web/agent-package/remote.js')
import {
  TEST_DEVICE_ID, TEST_ORIGIN, TEST_TOKEN, callRoute, leaksIn, makeFakeServer, stringsIn, tokenPieces,
  type Answer, type CallOut, type FakeServer,
} from './helpers/agent-package-fake-server.js'
import type { RouteContext } from '../web/routes/types.js'

const CRED = join(STORE, 'agent-package-credential.json')
const SESSION: RouteContext['auth'] = { kind: 'session', user: 'owner' }
const STORED = { schema: 1, token: TEST_TOKEN, deviceTokenId: TEST_DEVICE_ID, label: 'Office Mac', connectedAt: '2026-11-01T08:00:00.000Z' }
const REDEEM_OK = { token: TEST_TOKEN, device_token_id: '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4', label: 'Home Mac', idle_expiry_days: 90 }
const CODE = { code: 'ABCD-EFGH2345' }

/** What is on disk before the call. */
const FILES: Record<string, string | null> = {
  none: null,
  valid: JSON.stringify(STORED),
  'bare token': TEST_TOKEN,
  'token unquoted in an object': `{"token":${TEST_TOKEN}}`,
  'cut-off object': JSON.stringify(STORED).slice(0, 60),
  'token of another shape': JSON.stringify({ ...STORED, token: TEST_TOKEN + 'x' }),
  'readable by others': JSON.stringify(STORED),
  'a directory where the file goes': '<dir>',
}

/** What the publishing side answers. */
const ANSWERS: Record<string, Answer> = {
  'redeem ok': { status: 200, body: JSON.stringify(REDEEM_OK) },
  'redeem body is the bare token': { status: 200, body: TEST_TOKEN },
  'redeem body is a cut-off object': { status: 200, body: JSON.stringify(REDEEM_OK).slice(0, 30) },
  'redeem body with the token unquoted': { status: 200, body: `{"token":${TEST_TOKEN}}` },
  'redeem token of another shape': { status: 200, body: JSON.stringify({ ...REDEEM_OK, token: TEST_TOKEN + 'x' }) },
  'catalog ok': { status: 200, body: JSON.stringify({ access: 'full', trial_pick: null, packages: [] }) },
  'catalog echoes the token': { status: 200, body: JSON.stringify({ access: 'full', echo: TEST_TOKEN }) },
  'catalog is the bare token': { status: 200, body: TEST_TOKEN },
  'error body is the bare token': { status: 500, body: TEST_TOKEN },
  '401 echoing the token': { status: 401, body: JSON.stringify({ error: 'invalid_token', token: TEST_TOKEN }) },
  '403 with the token as trial pick': { status: 403, body: JSON.stringify({ error: 'not_entitled', reason: 'free', trial_pick: TEST_TOKEN }) },
  '409 with the token as version': { status: 409, body: JSON.stringify({ error: 'incompatible', min_marveen_version: TEST_TOKEN }) },
  'redirect to a token URL': { status: 302, headers: { location: `https://elsewhere.test/${TEST_TOKEN}` } },
  '429 with the token as Retry-After': { status: 429, headers: { 'retry-after': TEST_TOKEN } },
  'too large': { status: 200, chunks: Array.from({ length: 40 }, () => Buffer.from(TEST_TOKEN.repeat(200))) },
}

const ROUTES: Array<[string, string, unknown]> = [
  ['GET', '/api/agent-packages/credential', undefined],
  ['POST', '/api/agent-packages/credential', CODE],
  ['POST', '/api/agent-packages/credential', TEST_TOKEN],
  ['POST', '/api/agent-packages/credential', `{"code":${TEST_TOKEN}}`],
  ['POST', '/api/agent-packages/credential', { code: TEST_TOKEN }],
  ['DELETE', '/api/agent-packages/credential', undefined],
  ['GET', '/api/agent-packages/catalog', undefined],
]

let fake: FakeServer
const outs: CallOut[] = []
const texts = (): string[] => [
  ...outs.flatMap((o) => [o.raw, ...o.headers]),
  ...logged.flatMap((a) => stringsIn(a)),
]

function setFile(name: string): void {
  rmSync(CRED, { recursive: true, force: true })
  const content = FILES[name]
  if (content === null) return
  if (content === '<dir>') { mkdirSync(join(CRED, 'blocker'), { recursive: true }); return }
  writeFileSync(CRED, content, { mode: 0o600 })
  chmodSync(CRED, name === 'readable by others' ? 0o644 : 0o600)
}

async function run(method: string, path: string, body: unknown, file: string, answer: Answer | 'network-error'): Promise<CallOut> {
  setFile(file)
  if (answer === 'network-error') fake.fail(new TypeError(`fetch failed for ${TEST_TOKEN}`))
  else fake.answer(answer)
  const deps = { keys: [], fetchImpl: fake.fetchImpl, now: () => new Date('2026-11-16T10:00:00.000Z'), remote: makeRemote(TEST_ORIGIN) }
  const { handled, out } = await callRoute((ctx) => tryHandleAgentPackages(ctx, deps), method, path, SESSION, body)
  expect(handled).toBe(true)
  outs.push(out)
  return out
}

beforeAll(() => {
  initDatabase(':memory:')
  getDb().exec('DELETE FROM dashboard_users')
  createDashboardUser('owner', 'x'.repeat(60))
})
beforeEach(() => {
  for (const f of readdirSync(STORE)) rmSync(join(STORE, f), { recursive: true, force: true })
  logged.length = 0
  outs.length = 0
  fake = makeFakeServer()
})
afterAll(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

describe('the sweep instrument', () => {
  it('the test token has the real shape, and the search sees a quoted parse-error fragment', () => {
    expect(TEST_TOKEN).toMatch(/^mdt_[A-Za-z0-9_-]{43}$/)
    expect(tokenPieces(TEST_TOKEN).length).toBe(TEST_TOKEN.length - 8 + 1 + 1)
    let msg = ''
    try { JSON.parse(TEST_TOKEN) } catch (e) { msg = (e as Error).message }
    expect(leaksIn([msg], TEST_TOKEN).length).toBeGreaterThan(0)
    expect(leaksIn(stringsIn([{ err: new SyntaxError(msg) }]), TEST_TOKEN).length).toBeGreaterThan(0)
  })

  it('positive control: the token IS in the stored file and in the outgoing Authorization header', async () => {
    await run('GET', '/api/agent-packages/catalog', undefined, 'valid', ANSWERS['catalog ok'])
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${TEST_TOKEN}`)
    expect(leaksIn(texts(), TEST_TOKEN)).toEqual([])
  })
})

describe('every route, every file state, every answer: no piece of the token in a response or a log argument', () => {
  const combos: Array<[string, string, string, unknown, string, string]> = []
  for (const [method, path, body] of ROUTES) {
    for (const file of Object.keys(FILES)) {
      for (const answer of [...Object.keys(ANSWERS), 'network-error']) {
        const bodyName = body === undefined ? '-' : typeof body === 'string' ? `raw ${body.length}B` : JSON.stringify(body).slice(0, 30)
        combos.push([`${method} ${path} body=${bodyName} file=${file} answer=${answer}`, method, path, body, file, answer])
      }
    }
  }

  it.each(combos)('%s', async (_name, method, path, body, file, answer) => {
    await run(method, path, body, file, answer === 'network-error' ? 'network-error' : ANSWERS[answer])
    expect(leaksIn(texts(), TEST_TOKEN)).toEqual([])
  })
})

describe('the broken inputs reach the code paths they are meant for', () => {
  it('a bare-token redeem body is refused as redeem_failed upstream', async () => {
    const out = await run('POST', '/api/agent-packages/credential', CODE, 'none', ANSWERS['redeem body is the bare token'])
    expect(out.body).toEqual({ error: 'redeem_failed', reason: 'upstream' })
    expect(fake.requests).toHaveLength(1)
  })

  it('a corrupt credential file reads as not connected, and a log line says so in fixed words', async () => {
    const out = await run('GET', '/api/agent-packages/credential', undefined, 'token unquoted in an object', ANSWERS['catalog ok'])
    expect(out.body).toEqual({ connected: false })
    expect(logged.length).toBeGreaterThan(0)
  })

  it('a store failure after a redeem is credential_store_failed (the sweep covers that path too)', async () => {
    const out = await run('POST', '/api/agent-packages/credential', CODE, 'a directory where the file goes', ANSWERS['redeem ok'])
    expect(out).toMatchObject({ status: 500, body: { error: 'credential_store_failed' } })
  })

  it('a successful redeem stores the token (so the sweep above ran with the token on disk)', async () => {
    const out = await run('POST', '/api/agent-packages/credential', CODE, 'none', ANSWERS['redeem ok'])
    expect(out.status).toBe(200)
    expect(readdirSync(STORE)).toContain('agent-package-credential.json')
  })
})
