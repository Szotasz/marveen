// Optional Bearer key for the embedding backend (EMBED_API_KEY).
//
// The promise has two halves, and both fail SILENTLY if they regress:
//   1. With a key set, generateEmbedding sends `Authorization: Bearer <key>` to EMBED_URL. Without it a
//      backend behind auth answers 401 to every call and memory search quietly falls back to FTS-only.
//   2. With no key set nothing changes: no Authorization header at all (an Ollama on localhost must not
//      receive an empty `Bearer `), so an install that sets nothing keeps the previous request byte for byte.
// Plus the failure path the key makes realistic: a rejected key (HTTP 401) must be visible in the log once,
// and the key itself must never reach the log.
//
// EMBED_API_KEY is a module-level const read from .env, so each case loads db.js fresh against a config
// whose key (and EMBED_URL, loopback by default) is stubbed; the real config.js stays the base so every other
// export is untouched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnvContent } from '../env-parse.js'

const SECRET = 'embed-key-0123456789abcdef-SECRET'
// Characters outside the URL-safe set: a URL builder carries this key in its percent-encoded spelling.
const ODD_KEY = 'abc/def+ghi jkl&\u00e9=?#'

async function loadWithKey(key: string, embedUrl?: string) {
  vi.resetModules()
  vi.doMock('../config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../config.js')>()),
    EMBED_API_KEY: key,
    EMBED_URL: embedUrl ?? 'http://localhost:11434',
  }))
  const db = await import('../db.js')
  const { logger } = await import('../logger.js')
  return { generateEmbedding: db.generateEmbedding, db, logger }
}

type FetchInit = { headers: Record<string, string>; body: string }

function stubFetch(response: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function lastInit(fetchMock: ReturnType<typeof stubFetch>): FetchInit {
  return (fetchMock.mock.calls[0] as unknown as [string, FetchInit])[1]
}

async function backfillLogged(key: string, url: string, failure: unknown) {
  const { db, logger } = await loadWithKey(key, url)
  db.initDatabase(':memory:')
  const now = Math.floor(Date.now() / 1000)
  db.getDb().prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords)
     VALUES ('0', 'egy emlek', 'semantic', 1.0, ?, ?, 'keytest', 'warm', 'alpha')`
  ).run(now, now)
  const warn = vi.spyOn(logger, 'warn')
  if (failure instanceof Error) {
    vi.stubGlobal('fetch', vi.fn(async () => { throw failure }))
  } else {
    stubFetch(failure as Record<string, unknown>)
  }
  const out = await db.backfillEmbeddings()
  expect(out.embedded).toBe(0)
  // The first failure of an outage also warns from generateEmbedding; the LAST warning is the backfill's own.
  return {
    all: JSON.stringify(warn.mock.calls),
    backfill: JSON.stringify(warn.mock.calls[warn.mock.calls.length - 1]),
  }
}

beforeEach(() => { process.env.NODE_ENV = 'test' })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('../config.js')
  vi.restoreAllMocks()
})

describe('generateEmbedding: optional Bearer key', () => {
  it('sends Authorization: Bearer <key> when EMBED_API_KEY is set', async () => {
    const { generateEmbedding } = await loadWithKey(SECRET)
    const fetchMock = stubFetch({ ok: true, json: async () => ({ embedding: [1, 2, 3] }) })
    expect(await generateEmbedding('teszt')).toEqual([1, 2, 3])
    expect(lastInit(fetchMock).headers['Authorization']).toBe(`Bearer ${SECRET}`)
    expect(lastInit(fetchMock).headers['Content-Type']).toBe('application/json')
  })

  it('sends NO Authorization header when EMBED_API_KEY is empty (previous behaviour)', async () => {
    const { generateEmbedding } = await loadWithKey('')
    const fetchMock = stubFetch({ ok: true, json: async () => ({ embedding: [1, 2, 3] }) })
    await generateEmbedding('teszt')
    expect(Object.keys(lastInit(fetchMock).headers)).toEqual(['Content-Type'])
  })

  it('does not follow redirects when a key is set (the Authorization header must not leave the host)', async () => {
    const { generateEmbedding } = await loadWithKey(SECRET)
    const fetchMock = stubFetch({ ok: true, json: async () => ({ embedding: [1] }) })
    await generateEmbedding('teszt')
    expect((lastInit(fetchMock) as unknown as { redirect?: string }).redirect).toBe('error')
  })

  it('leaves the redirect behaviour alone when no key is set', async () => {
    const { generateEmbedding } = await loadWithKey('')
    const fetchMock = stubFetch({ ok: true, json: async () => ({ embedding: [1] }) })
    await generateEmbedding('teszt')
    expect('redirect' in (lastInit(fetchMock) as object)).toBe(false)
  })

  it('does not put the key into the request body', async () => {
    const { generateEmbedding } = await loadWithKey(SECRET)
    const fetchMock = stubFetch({ ok: true, json: async () => ({ embedding: [1] }) })
    await generateEmbedding('teszt')
    expect(lastInit(fetchMock).body).not.toContain(SECRET)
  })
})

describe('generateEmbedding: a rejected key is visible, the key is not', () => {
  // An embedding failure is logged as STRUCTURED fields only: the error name, its code and the HTTP status. No error
  // text and no EMBED_URL content is logged, so the key cannot reach the log in any spelling or position.
  const keyForms: Record<string, string> = {
    raw: ODD_KEY,
    'percent-encoded, upper-case hex': encodeURIComponent(ODD_KEY),
    'percent-encoded, lower-case hex': encodeURIComponent(ODD_KEY).replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()),
    'double-encoded': encodeURIComponent(encodeURIComponent(ODD_KEY)),
  }

  // Where a mis-set EMBED_URL could carry the key (a raw key may hold / ? # and a space).
  const placements: Record<string, (form: string) => string> = {
    host: f => `https://${f}.gateway.invalid:8443/v1`,
    port: f => `https://gateway.invalid:${f}/v1`,
    userinfo: f => `https://user:${f}@gateway.invalid:8443/v1`,
    path: f => `https://gateway.invalid:8443/p/${f}/v1`,
    query: f => `https://gateway.invalid:8443/v1?key=${f}`,
    'scheme-less URL': f => `gateway.invalid/${f}`,
  }

  function expectStructureOnly(logged: string) {
    for (const form of Object.values(keyForms)) expect(logged).not.toContain(form)
    for (const part of ['gateway.invalid', '/v1', '/p/', '?key=', 'request to', 'ftp://', 'Bearer', 'embedUrl']) {
      expect(logged).not.toContain(part)
    }
  }

  it('HTTP 401 returns null AND warns once, with the status and without the key', async () => {
    const { generateEmbedding, logger } = await loadWithKey(SECRET)
    const warn = vi.spyOn(logger, 'warn')
    stubFetch({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) })
    expect(await generateEmbedding('egy')).toBeNull()
    expect(await generateEmbedding('ketto')).toBeNull()
    // First failure of an outage warns, later ones go to debug (the existing warn-once contract).
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('"httpStatus":401')
    expect(logged).toContain('"errName":"EmbedHttpError"')
    expect(logged).not.toContain(SECRET)
  })

  it('a network failure still returns null; its error text is not logged, its name and code are', async () => {
    const { generateEmbedding, logger } = await loadWithKey(SECRET)
    const warn = vi.spyOn(logger, 'warn')
    // undici echoes a rejected header value in its TypeError text.
    const err = Object.assign(new Error(`Headers.append: "Bearer ${SECRET}" is an invalid header value.`), { code: 'ERR_INVALID_ARG_VALUE' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw err }))
    expect(await generateEmbedding('teszt')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('"errName":"Error"')
    expect(logged).toContain('"errCode":"ERR_INVALID_ARG_VALUE"')
    expect(logged).not.toContain('invalid header value')
    expect(logged).not.toContain(SECRET)
  })

  it('the code comes from err.cause.code when the error has none (a fetch failure)', async () => {
    const { generateEmbedding, logger } = await loadWithKey(SECRET)
    const warn = vi.spyOn(logger, 'warn')
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    vi.stubGlobal('fetch', vi.fn(async () => { throw err }))
    await generateEmbedding('teszt')
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('"errName":"TypeError"')
    expect(logged).toContain('"errCode":"ECONNREFUSED"')
  })

  it('a name or a code that is not a plain token is dropped, never logged', async () => {
    const { generateEmbedding, logger } = await loadWithKey(SECRET)
    const warn = vi.spyOn(logger, 'warn')
    const err = Object.assign(new Error(`leak ${SECRET} at http://gateway.invalid/x`), { name: `bad name ${SECRET}`, code: `http://gateway.invalid/${SECRET}` })
    vi.stubGlobal('fetch', vi.fn(async () => { throw err }))
    expect(await generateEmbedding('teszt')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain(SECRET)
    expect(logged).not.toContain('gateway.invalid')
    expect(logged).not.toContain('leak')
  })

  it('EMBED_URL is not logged with or without a key', async () => {
    const { generateEmbedding, logger } = await loadWithKey('', 'http://gateway.invalid:8443/v1')
    const warn = vi.spyOn(logger, 'warn')
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }))
    await generateEmbedding('teszt')
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('"errCode":"ECONNREFUSED"')
    expect(logged).not.toContain('gateway.invalid')
    expect(logged).not.toContain('embedUrl')
  })

  it('the backfill warning carries the status of the latest failure', async () => {
    const { all, backfill } = await backfillLogged(SECRET, 'https://gateway.invalid:8443/v1', { ok: false, status: 503, json: async () => ({}) })
    expect(backfill).toContain('"pending":1')
    expect(backfill).toContain('"httpStatus":503')
    expect(all).not.toContain('gateway.invalid')
  })

  it('the backfill warning carries no failure field of an earlier run after an empty 200 answer', async () => {
    const { db, logger } = await loadWithKey(SECRET, 'https://gateway.invalid:8443/v1')
    db.initDatabase(':memory:')
    const now = Math.floor(Date.now() / 1000)
    db.getDb().prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords)
       VALUES ('0', 'egy emlek', 'semantic', 1.0, ?, ?, 'keytest', 'warm', 'alpha')`
    ).run(now, now)
    // An earlier outage leaves its status in the module-level failure record.
    stubFetch({ ok: false, status: 503, json: async () => ({}) })
    expect(await db.generateEmbedding('egy')).toBeNull()
    // The backend now answers 200 with no vector: nothing is embedded, and nothing failed this run.
    const warn = vi.spyOn(logger, 'warn')
    stubFetch({ ok: true, status: 200, json: async () => ({ embedding: [] }) })
    const out = await db.backfillEmbeddings()
    expect(out.embedded).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    const backfill = JSON.stringify(warn.mock.calls[0])
    expect(backfill).toContain('"pending":1')
    expect(backfill).not.toContain('httpStatus')
    expect(backfill).not.toContain('errName')
    expect(backfill).not.toContain('EmbedHttpError')
  })

  describe.each(Object.entries(keyForms))('the key spelled %s', (_form, form) => {
    describe.each(Object.entries(placements))('EMBED_URL carries it as %s', (_where, make) => {
      const url = make(form)
      // fetch errors can quote the request URL; the text also holds a non-http URL and the bare key
      const quoted = `request to ${url} failed; also ftp://gateway.invalid/${form} and ${form}`
      const coded = () => Object.assign(new Error(quoted), { code: 'ECONNREFUSED' })
      // A mis-set URL that does not even parse is refused before fetch (the key-over-http guard cannot call it
      // safe); one that parses reaches the stubbed fetch. Either way only the structure may reach the log.
      const reachesFetch = async () => (await loadWithKey(ODD_KEY, url)).db.embedUrlMayCarryKey(`${url}/api/embeddings`)
      // The expectation must not come only from the function under test: these placements classify the same way
      // for every key spelling (the key sits after the scheme and the host, or there is no scheme at all).
      const fixedReach: Record<string, boolean> = { path: true, query: true, 'scheme-less URL': false }
      if (_where in fixedReach) {
        it('the guard classifies the mis-set URL as expected', async () => {
          expect(await reachesFetch()).toBe(fixedReach[_where])
        })
      }
      const structureCode = async () => (await reachesFetch()) ? '"errCode":"ECONNREFUSED"' : '"errCode":"EMBED_INSECURE_URL"'

      it('a network failure logs the structure only', async () => {
        const { generateEmbedding, logger } = await loadWithKey(ODD_KEY, url)
        const warn = vi.spyOn(logger, 'warn')
        vi.stubGlobal('fetch', vi.fn(async () => { throw coded() }))
        expect(await generateEmbedding('teszt')).toBeNull()
        const logged = JSON.stringify(warn.mock.calls)
        expect(logged).toContain(await structureCode())
        expectStructureOnly(logged)
      })

      it('an HTTP error logs the status only', async () => {
        const { generateEmbedding, logger } = await loadWithKey(ODD_KEY, url)
        const warn = vi.spyOn(logger, 'warn')
        stubFetch({ ok: false, status: 401, json: async () => ({ error: quoted }) })
        expect(await generateEmbedding('teszt')).toBeNull()
        const logged = JSON.stringify(warn.mock.calls)
        expect(logged).toContain((await reachesFetch()) ? '"httpStatus":401' : '"errCode":"EMBED_INSECURE_URL"')
        expectStructureOnly(logged)
      })

      it('the backfill warning logs the structure only', async () => {
        const { all, backfill } = await backfillLogged(ODD_KEY, url, coded())
        expect(backfill).toContain('"pending":1')
        expect(backfill).toContain(await structureCode())
        expectStructureOnly(all)
      })
    })
  })

  it('a bare stub without ok keeps working (existing tests stub fetch this way)', async () => {
    const { generateEmbedding } = await loadWithKey('')
    stubFetch({ json: async () => ({ embedding: [4, 5] }) })
    expect(await generateEmbedding('teszt')).toEqual([4, 5])
  })
})

// A bearer key must not cross the network in clear: with a key set, a non-https URL is refused unless it points
// at this very host. The refusal happens BEFORE the request: no fetch, no Authorization header, one structured
// warning (error name and code only, no key, no URL), and null like any other embedding failure.
describe('EMBED_API_KEY travels only over https or to loopback', () => {
  const OK = { ok: true, json: async () => ({ embedding: [1, 2, 3] }) }

  it('a plain-http REMOTE URL with a key sends nothing, warns once, returns null', async () => {
    const { generateEmbedding, logger } = await loadWithKey(SECRET, 'http://hub.example.invalid:8080')
    const warn = vi.spyOn(logger, 'warn')
    const fetchMock = stubFetch(OK)
    expect(await generateEmbedding('egy')).toBeNull()
    expect(await generateEmbedding('ketto')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('"errName":"EmbedInsecureUrlError"')
    expect(logged).toContain('"errCode":"EMBED_INSECURE_URL"')
    expect(logged).not.toContain(SECRET)
    expect(logged).not.toContain('hub.example.invalid')
    expect(logged).not.toContain('embedUrl')
  })

  it('http://localhost with a key works and sends the Bearer header', async () => {
    const { generateEmbedding } = await loadWithKey(SECRET, 'http://localhost:11434')
    const fetchMock = stubFetch(OK)
    expect(await generateEmbedding('teszt')).toEqual([1, 2, 3])
    expect(lastInit(fetchMock).headers['Authorization']).toBe(`Bearer ${SECRET}`)
  })

  it('an https remote URL with a key works', async () => {
    const { generateEmbedding } = await loadWithKey(SECRET, 'https://hub.example.invalid:8443/ollama')
    const fetchMock = stubFetch(OK)
    expect(await generateEmbedding('teszt')).toEqual([1, 2, 3])
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://hub.example.invalid:8443/ollama/api/embeddings')
    expect(lastInit(fetchMock).headers['Authorization']).toBe(`Bearer ${SECRET}`)
  })

  it('a plain-http remote URL WITHOUT a key is unchanged (no guard, no header)', async () => {
    const { generateEmbedding } = await loadWithKey('', 'http://hub.example.invalid:8080')
    const fetchMock = stubFetch(OK)
    expect(await generateEmbedding('teszt')).toEqual([1, 2, 3])
    expect(Object.keys(lastInit(fetchMock).headers)).toEqual(['Content-Type'])
  })

  it('the backfill warning names the refusal and still carries no URL', async () => {
    const { all, backfill } = await backfillLogged(SECRET, 'http://hub.example.invalid:8080', OK)
    expect(backfill).toContain('"pending":1')
    expect(backfill).toContain('"errCode":"EMBED_INSECURE_URL"')
    expect(backfill).toContain('no request was sent')
    expect(backfill).not.toContain('answered none of them')
    expect(all).not.toContain('hub.example.invalid')
    expect(all).not.toContain(SECRET)
  })

  describe('embedUrlMayCarryKey: the exact string fetch is given', () => {
    const allowed = [
      'https://hub.example.invalid/api/embeddings',
      'https://hub.example.invalid:8443/ollama/api/embeddings',
      'HTTPS://HUB.EXAMPLE.INVALID/api/embeddings',
      'http://localhost/api/embeddings',
      'http://localhost:11434/api/embeddings',
      'http://LOCALHOST:11434/api/embeddings',
      'http://127.0.0.1:11434/api/embeddings',
      'http://127.1.2.3/api/embeddings',
      'http://127.255.255.255/api/embeddings',
      'http://[::1]:11434/api/embeddings',
      'http://[0:0:0:0:0:0:0:1]/api/embeddings',
      'http://2130706433/api/embeddings', // 127.0.0.1 written as one decimal number: the URL parser normalises it
    ]
    const refused = [
      'http://hub.example.invalid/api/embeddings',
      'http://10.0.0.5:11434/api/embeddings',
      'http://192.168.1.10:11434/api/embeddings',
      'http://0.0.0.0:11434/api/embeddings',
      'http://128.0.0.1/api/embeddings',
      'http://126.255.255.255/api/embeddings',
      'http://127.0.0.1.example.invalid/api/embeddings', // look-alike hosts
      'http://localhost.example.invalid/api/embeddings',
      'http://xlocalhost/api/embeddings',
      'http://localhost@hub.example.invalid/api/embeddings', // loopback name only as userinfo: the host is the remote one
      'http://hub.example.invalid#@localhost/api/embeddings',
      'http://hub.example.invalid/?h=localhost/api/embeddings',
      'http://[::ffff:127.0.0.1]/api/embeddings', // not provably loopback: refused
      'http://[::2]/api/embeddings',
      'ftp://localhost/api/embeddings', // not http(s) at all
      'ws://localhost/api/embeddings',
      'file:///api/embeddings',
      'localhost:11434/api/embeddings', // does not parse as an http URL
      'hub.example.invalid/api/embeddings',
      '/api/embeddings',
      '',
    ]
    it.each(allowed)('allows %s', async (u) => {
      const { db } = await loadWithKey(SECRET)
      expect(db.embedUrlMayCarryKey(u)).toBe(true)
    })
    it.each(refused)('refuses %s', async (u) => {
      const { db } = await loadWithKey(SECRET)
      expect(db.embedUrlMayCarryKey(u)).toBe(false)
    })
  })
})

// The key comes from .env, then from the process environment; it is never a registry key (that would show
// it on the Settings page and in its API).
describe('EMBED_API_KEY: read from .env or the environment, trimmed, never a Settings key', () => {
  let envDir = ''
  const savedEnvDir = process.env.CLAUDECLAW_ENV_DIR
  const savedKey = process.env.EMBED_API_KEY

  beforeEach(() => { delete process.env.EMBED_API_KEY })

  async function configWithEnvLine(line: string) {
    envDir = mkdtempSync(join(tmpdir(), 'embed-key-env-'))
    writeFileSync(join(envDir, '.env'), line)
    process.env.CLAUDECLAW_ENV_DIR = envDir
    vi.resetModules()
    return import('../config.js')
  }

  afterEach(() => {
    if (savedEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
    else process.env.CLAUDECLAW_ENV_DIR = savedEnvDir
    if (savedKey === undefined) delete process.env.EMBED_API_KEY
    else process.env.EMBED_API_KEY = savedKey
    if (envDir) rmSync(envDir, { recursive: true, force: true })
    envDir = ''
  })

  it('reads the key from .env', async () => {
    const config = await configWithEnvLine('EMBED_API_KEY=abc-123\n')
    expect(config.EMBED_API_KEY).toBe('abc-123')
  })

  it('trims whitespace the .env reader keeps inside quotes (an invalid header value otherwise)', async () => {
    const config = await configWithEnvLine('EMBED_API_KEY="  abc-123  "\n')
    expect(config.EMBED_API_KEY).toBe('abc-123')
  })

  it('falls back to the process environment when .env has no line for it, trimmed', async () => {
    process.env.EMBED_API_KEY = '  env-key-456  '
    const config = await configWithEnvLine('OLLAMA_URL=http://localhost:11434\n')
    expect(config.EMBED_API_KEY).toBe('env-key-456')
  })

  it('prefers the .env line over the process environment', async () => {
    process.env.EMBED_API_KEY = 'from-environment'
    const config = await configWithEnvLine('EMBED_API_KEY=from-dotenv\n')
    expect(config.EMBED_API_KEY).toBe('from-dotenv')
  })

  it('an empty .env line does not shadow the environment', async () => {
    process.env.EMBED_API_KEY = 'from-environment'
    const config = await configWithEnvLine('EMBED_API_KEY=\n')
    expect(config.EMBED_API_KEY).toBe('from-environment')
  })

  it('a blank quoted .env value does not shadow the environment either', async () => {
    process.env.EMBED_API_KEY = 'from-environment'
    const config = await configWithEnvLine('EMBED_API_KEY="   "\n')
    expect(config.EMBED_API_KEY).toBe('from-environment')
  })

  it('is the empty string when neither .env nor the environment sets it', async () => {
    const config = await configWithEnvLine('OLLAMA_URL=http://localhost:11434\n')
    expect(config.EMBED_API_KEY).toBe('')
  })

  it('is not a registry setting (it must not appear on the Settings page or its API)', async () => {
    const { SETTINGS_REGISTRY } = await import('../config-registry.js')
    expect(SETTINGS_REGISTRY.find(d => d.key === 'EMBED_API_KEY')).toBeUndefined()
  })
})

// The .env reader does not strip an inline comment, so a documented example that carries one would turn into
// a bogus key the moment someone removes the leading '#'.
describe('.env.example: the documented line is safe to uncomment', () => {
  it('uncommenting the EMBED_API_KEY line gives an empty key', () => {
    const example = readFileSync(join(__dirname, '..', '..', '.env.example'), 'utf-8')
    const line = example.split('\n').find(l => /^# EMBED_API_KEY=/.test(l))
    expect(line).toBeDefined()
    expect(parseEnvContent((line as string).replace(/^# /, ''))).toEqual({ EMBED_API_KEY: '' })
  })
})
