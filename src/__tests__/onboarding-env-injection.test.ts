import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// Card 9a77b3e5 (B4): the onboarding claude-auth endpoint wrote a Bearer
// holder's token into .env with only a prefix check, so an embedded newline
// could add a line of the caller's choosing (e.g. PERMISSION_BOT_ID=...).
// Runs against a throw-away project root; the live probe and the channel
// plumbing are mocked, no network.

const h = vi.hoisted(() => ({ root: '', probes: 0 }))

vi.mock('../config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../config.js')>()
  const { mkdtempSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  h.root = mkdtempSync(join(tmpdir(), 'onboarding-env-test-'))
  mkdirSync(join(h.root, 'store'), { recursive: true })
  return { ...orig, PROJECT_ROOT: h.root, STORE_DIR: join(h.root, 'store') }
})
vi.mock('../web/claude-credentials-guard.js', () => ({
  liveProbeAuth: async () => { h.probes++; return 'ok' },
  stampTokenVerified: () => undefined,
}))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: () => ({ ok: true }),
  mainChannelsSessionExists: () => false,
  createMainChannelsSession: () => 'started',
}))
vi.mock('../web/agent-process.js', () => ({ sessionExistsOnHost: () => false }))
vi.mock('../web/routes/agents.js', () => ({
  isManagedSettingsReady: () => true,
  getManagedSettingsSudoCommand: () => '',
}))

const { tryHandleOnboarding, setEnvKey } =await import('../web/routes/onboarding.js')

const ENV = () => join(h.root, '.env')
const BASE_ENV = 'FOO=bar\nPERMISSION_BOT_ID=7000000002\n'

function fakeReq(body: unknown) {
  const bodyStr = JSON.stringify(body)
  return {
    headers: {},
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
}

async function claudeAuth(body: unknown) {
  const out = { status: 0, body: null as any }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const path = '/api/onboarding/claude-auth'
  const ctx = {
    req: fakeReq(body) as unknown as http.IncomingMessage, res: res as http.ServerResponse,
    path, method: 'POST', url: new URL(`http://localhost${path}`), auth: { kind: 'token' },
  } as unknown as RouteContext
  expect(await tryHandleOnboarding(ctx)).toBe(true)
  return out
}

beforeEach(() => {
  h.probes = 0
  mkdirSync(h.root, { recursive: true })
  writeFileSync(ENV(), BASE_ENV)
})

describe('setEnvKey', () => {
  it('refuses line breaks / NUL in the value and writes nothing', () => {
    for (const v of ['a\nB=1', 'a\r\nB=1', 'a\rB=1', 'a\0b']) {
      expect(() => setEnvKey('SOME_KEY', v)).toThrow(/line break/)
    }
    expect(readFileSync(ENV(), 'utf-8')).toBe(BASE_ENV)
  })

  it('never writes PERMISSION_BOT_ID (also padded / lower-case)', () => {
    for (const k of ['PERMISSION_BOT_ID', ' PERMISSION_BOT_ID ', 'permission_bot_id']) {
      expect(() => setEnvKey(k, '7000000099')).toThrow(/PERMISSION_BOT_ID/)
    }
    expect(readFileSync(ENV(), 'utf-8')).toBe(BASE_ENV)
  })

  it('a normal key/value is written as before', () => {
    setEnvKey('SOME_KEY', 'v1')
    expect(readFileSync(ENV(), 'utf-8')).toBe(`${BASE_ENV}SOME_KEY=v1\n`)
  })
})

describe('POST /api/onboarding/claude-auth: no .env line injection', () => {
  it('a setup-token with an embedded newline -> 400, no probe, .env unchanged', async () => {
    for (const sep of ['\n', '\r\n', '\r', '\0']) {
      const out = await claudeAuth({ token: `sk-ant-oat-abc${sep}PERMISSION_BOT_ID=7000000099` })
      expect(out.status).toBe(400)
      expect(out.body.reason).toBe('bad-chars')
    }
    expect(h.probes).toBe(0)
    expect(readFileSync(ENV(), 'utf-8')).toBe(BASE_ENV)
  })

  it('an API key with an embedded newline -> 400, no probe, .env unchanged', async () => {
    const out = await claudeAuth({ apiKey: 'sk-ant-key\nPERMISSION_BOT_ID=7000000099' })
    expect(out.status).toBe(400)
    expect(h.probes).toBe(0)
    expect(readFileSync(ENV(), 'utf-8')).toBe(BASE_ENV)
  })

  it('a normal token still probes and is written as one line; other lines are untouched', async () => {
    const out = await claudeAuth({ token: 'sk-ant-oat-normal-token' })
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(h.probes).toBe(1)
    expect(readFileSync(ENV(), 'utf-8')).toBe(`${BASE_ENV}CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-normal-token\n`)
  })

  it('a normal API key still works', async () => {
    const out = await claudeAuth({ apiKey: 'sk-ant-normal-key' })
    expect(out.status).toBe(200)
    expect(readFileSync(ENV(), 'utf-8')).toBe(`${BASE_ENV}ANTHROPIC_API_KEY=sk-ant-normal-key\n`)
  })
})
