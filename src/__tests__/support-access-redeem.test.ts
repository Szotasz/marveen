import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { createServer as createPlainServer, type Server as PlainServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifySupportCode,
  createHttpsRedeemTransport,
  redeemSupportCode,
  SUPPORT_REDEEM_MAX_BODY_BYTES,
  SUPPORT_REDEEM_PATH,
  SUPPORT_REDEEM_TIMEOUT_MS,
  SUPPORT_SERVICE_ORIGIN,
  type RedeemRequest,
  type RedeemResponse,
  type RedeemTransport,
} from '../support-access-redeem.js'

// TEST ONLY values: the right shape, issued by nobody.
const CODE = 'msc_' + 'TESTONLY'.repeat(4)
const TOKEN = 'mst_' + 'TESTONLY'.repeat(5) + '_-0'

function recording(answer: RedeemResponse | Error): { transport: RedeemTransport; calls: RedeemRequest[] } {
  const calls: RedeemRequest[] = []
  return {
    calls,
    transport: async (req) => {
      calls.push(req)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

describe('classifySupportCode', () => {
  it('accepts the code shape, with pasted white space around it', () => {
    expect(classifySupportCode(CODE)).toEqual({ ok: true, code: CODE })
    expect(classifySupportCode('  ' + CODE + '\n')).toEqual({ ok: true, code: CODE })
  })

  it('says a licence key is not accepted, whatever follows the prefix', () => {
    expect(classifySupportCode('mrv_' + 'A'.repeat(32))).toEqual({ ok: false, problem: 'license_key_not_accepted' })
    expect(classifySupportCode(' mrv_x')).toEqual({ ok: false, problem: 'license_key_not_accepted' })
  })

  it.each([undefined, null, 42, {}, '', '   ', '\n'])('asks for a code when given %j', (input) => {
    expect(classifySupportCode(input)).toEqual({ ok: false, problem: 'code_required' })
  })

  it.each([
    ['one character short', 'msc_' + 'A'.repeat(31)],
    ['one character long', 'msc_' + 'A'.repeat(33)],
    ['another prefix', 'mst_' + 'A'.repeat(32)],
    ['upper case prefix', 'MSC_' + 'A'.repeat(32)],
    ['a plus sign', 'msc_' + 'A'.repeat(31) + '+'],
    ['a space inside', 'msc_' + 'A'.repeat(15) + ' ' + 'A'.repeat(16)],
    ['a quote', 'msc_' + 'A'.repeat(31) + '"'],
    ['two codes', CODE + ' ' + CODE],
    ['a code with a line after it', CODE + '\nmsc_x'],
  ])('refuses %s', (_label, input) => {
    expect(classifySupportCode(input)).toEqual({ ok: false, problem: 'code_shape' })
  })
})

describe('redeemSupportCode', () => {
  it('sends ONE request of the frozen shape to the frozen address and returns the token', async () => {
    const { transport, calls } = recording({ status: 200, body: '{"token":"' + TOKEN + '"}' })
    expect(await redeemSupportCode(CODE, { transport })).toEqual({ ok: true, token: TOKEN })
    expect(calls).toEqual([
      {
        origin: 'https://api.marveen.io',
        path: '/support/v1/code-redeem',
        body: '{"code":"' + CODE + '","purpose":"support"}',
        timeoutMs: 10_000,
        maxBodyBytes: 1024,
      },
    ])
    expect(SUPPORT_SERVICE_ORIGIN).toBe('https://api.marveen.io')
    expect(SUPPORT_REDEEM_PATH).toBe('/support/v1/code-redeem')
  })

  it('has no way to be pointed at another service: not by the caller, not by the environment', async () => {
    const saved = { ...process.env }
    try {
      for (const name of ['SUPPORT_SERVICE_ORIGIN', 'MARVEEN_SUPPORT_ORIGIN', 'MARVEEN_API_ORIGIN', 'SUPABASE_URL', 'HTTPS_PROXY']) {
        process.env[name] = 'https://elsewhere.example'
      }
      const { transport, calls } = recording({ status: 200, body: '{"token":"' + TOKEN + '"}' })
      const deps = { transport, origin: 'https://elsewhere.example' } as { transport: RedeemTransport }
      await redeemSupportCode(CODE, deps)
      expect(calls.map((c) => c.origin + c.path)).toEqual(['https://api.marveen.io/support/v1/code-redeem'])
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
      Object.assign(process.env, saved)
    }
    expect(SUPPORT_REDEEM_TIMEOUT_MS).toBe(10_000)
    expect(SUPPORT_REDEEM_MAX_BODY_BYTES).toBe(1024)
  })

  it('maps 401 to "the code is not good" and 429 to "wait"', async () => {
    expect(await redeemSupportCode(CODE, { transport: recording({ status: 401, body: '{"error":"x"}' }).transport })).toEqual({
      ok: false,
      problem: 'code_rejected',
    })
    expect(await redeemSupportCode(CODE, { transport: recording({ status: 429, body: '' }).transport })).toEqual({
      ok: false,
      problem: 'rate_limited',
    })
  })

  it.each([0, 201, 204, 301, 302, 307, 400, 403, 404, 500, 503])('treats status %i as "not available", even with a token in the body', async (status) => {
    const { transport } = recording({ status, body: '{"token":"' + TOKEN + '"}' })
    expect(await redeemSupportCode(CODE, { transport })).toEqual({ ok: false, problem: 'service_unavailable' })
  })

  it.each([
    ['not JSON', 'ok'],
    ['an empty body', ''],
    ['a second key', '{"token":"' + TOKEN + '","extra":1}'],
    ['another key', '{"jwt":"' + TOKEN + '"}'],
    ['a token of another shape', '{"token":"mrv_' + 'A'.repeat(43) + '"}'],
    ['a token one character short', '{"token":"' + TOKEN.slice(0, -1) + '"}'],
    ['a token that is not a string', '{"token":["' + TOKEN + '"]}'],
    ['an array', '["' + TOKEN + '"]'],
    ['a bare string', '"' + TOKEN + '"'],
    ['null', 'null'],
  ])('answers "unreadable" for a 200 with %s', async (_label, body) => {
    const { transport } = recording({ status: 200, body })
    expect(await redeemSupportCode(CODE, { transport })).toEqual({ ok: false, problem: 'answer_unreadable' })
  })

  it('answers "not available" when the transport fails, and does NOT retry', async () => {
    const { transport, calls } = recording(new Error('boom with ' + CODE))
    expect(await redeemSupportCode(CODE, { transport })).toEqual({ ok: false, problem: 'service_unavailable' })
    expect(calls.length).toBe(1)
  })

  it('never returns the code, a response body or a transport error text in a failure', async () => {
    const leaky = [
      recording(new Error('ECONNRESET while sending ' + CODE)),
      recording({ status: 401, body: 'your code ' + CODE + ' is wrong' }),
      recording({ status: 500, body: CODE }),
      recording({ status: 200, body: '{"token":"nope","code":"' + CODE + '"}' }),
    ]
    for (const { transport } of leaky) {
      const out = await redeemSupportCode(CODE, { transport })
      expect(out.ok).toBe(false)
      expect(JSON.stringify(out)).not.toContain('TESTONLY')
    }
  })

  it('refuses an unchecked value with a message that does not quote it, and sends nothing', async () => {
    const { transport, calls } = recording({ status: 200, body: '{"token":"' + TOKEN + '"}' })
    for (const bad of ['mrv_' + 'SECRETVALUE'.repeat(3), ' ' + CODE, CODE + '\n', '']) {
      let message = 'no error'
      try {
        await redeemSupportCode(bad, { transport })
      } catch (err) {
        message = String((err as Error).message)
      }
      expect(message).toMatch(/classifySupportCode/)
      expect(message).not.toContain('SECRETVALUE')
      expect(message).not.toContain('TESTONLY')
    }
    expect(calls).toEqual([])
  })
})

// The real transport against a local TLS server with a certificate made for this run.
function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const OPENSSL = hasOpenssl()

describe('createHttpsRedeemTransport', () => {
  let dir: string
  let cert = ''
  let server: Server
  let plain: PlainServer
  let origin = ''
  let plainOrigin = ''
  let mode: 'ok' | 'big' | 'slow' | 'redirect' = 'ok'
  let seen: { method?: string; url?: string; type?: string; body: string }[] = []
  const savedEnv = process.env['NODE_TLS_REJECT_UNAUTHORIZED']

  beforeAll(async () => {
    if (!OPENSSL) return
    dir = mkdtempSync(join(tmpdir(), 'support-redeem-tls-'))
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')],
      { stdio: 'ignore' },
    )
    cert = readFileSync(join(dir, 'cert.pem'), 'utf8')
    const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString('utf8')))
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body })
        if (mode === 'slow') return // never answers
        if (mode === 'redirect') {
          res.writeHead(307, { location: plainOrigin + '/elsewhere' })
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(mode === 'big' ? 'x'.repeat(5000) : '{"token":"' + TOKEN + '"}')
      })
    }
    server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, handler)
    plain = createPlainServer(handler)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r))
    origin = 'https://127.0.0.1:' + (server.address() as AddressInfo).port
    plainOrigin = 'http://127.0.0.1:' + (plain.address() as AddressInfo).port
  })
  afterAll(async () => {
    if (savedEnv === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED']
    else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = savedEnv
    if (!OPENSSL) return
    server.closeAllConnections()
    plain.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    await new Promise<void>((r) => plain.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  const req = (over: Partial<RedeemRequest> = {}): RedeemRequest => ({
    origin,
    path: SUPPORT_REDEEM_PATH,
    body: '{"code":"' + CODE + '","purpose":"support"}',
    timeoutMs: 3000,
    maxBodyBytes: 1024,
    ...over,
  })

  it('this suite must not be skipped on CI: openssl is there', () => {
    if (process.env['CI']) expect(OPENSSL).toBe(true)
  })

  it.skipIf(!OPENSSL)('posts the body as JSON over TLS and returns the status and the body (control, with the test root trusted)', async () => {
    mode = 'ok'
    seen = []
    const out = await createHttpsRedeemTransport({ extraCa: cert })(req())
    expect(out).toEqual({ status: 200, body: '{"token":"' + TOKEN + '"}' })
    expect(seen).toEqual([
      { method: 'POST', url: SUPPORT_REDEEM_PATH, type: 'application/json', body: '{"code":"' + CODE + '","purpose":"support"}' },
    ])
  })

  it.skipIf(!OPENSSL)('REFUSES a certificate it cannot verify, and the request body never reaches the server', async () => {
    mode = 'ok'
    seen = []
    await expect(createHttpsRedeemTransport()(req())).rejects.toThrow('the request failed')
    expect(seen).toEqual([])
  })

  it.skipIf(!OPENSSL)('STILL refuses it when the environment switches TLS verification off', async () => {
    mode = 'ok'
    seen = []
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
    try {
      await expect(createHttpsRedeemTransport()(req())).rejects.toThrow('the request failed')
    } finally {
      delete process.env['NODE_TLS_REJECT_UNAUTHORIZED']
    }
    expect(seen).toEqual([])
  })

  it.skipIf(!OPENSSL)('does not talk plain http', async () => {
    seen = []
    await expect(createHttpsRedeemTransport({ extraCa: cert })(req({ origin: plainOrigin }))).rejects.toThrow('not https')
    expect(seen).toEqual([])
  })

  it.skipIf(!OPENSSL)('does NOT follow a redirect: the 307 is the answer, and the other server sees nothing', async () => {
    mode = 'redirect'
    seen = []
    const out = await createHttpsRedeemTransport({ extraCa: cert })(req())
    expect(out.status).toBe(307)
    expect(seen.length).toBe(1)
    expect(seen[0].url).toBe(SUPPORT_REDEEM_PATH)
  })

  it.skipIf(!OPENSSL)('gives up on an answer longer than the limit', async () => {
    mode = 'big'
    await expect(createHttpsRedeemTransport({ extraCa: cert })(req())).rejects.toThrow('longer than the limit')
  })

  it.skipIf(!OPENSSL)('gives up at the deadline when the server never answers', async () => {
    mode = 'slow'
    const started = Date.now()
    await expect(createHttpsRedeemTransport({ extraCa: cert })(req({ timeoutMs: 300 }))).rejects.toThrow('time limit')
    expect(Date.now() - started).toBeLessThan(2500)
  })

  it('rejects an address that is not a URL', async () => {
    await expect(createHttpsRedeemTransport()(req({ origin: 'not a url' }))).rejects.toThrow('not a URL')
  })
})
