/**
 * SLACKMAINTEST1007: POST /api/agents/:name/channels/:provider/test for the MAIN
 * agent read agents/<main>/.claude/channels/<provider>/.env, a place the main
 * agent's tokens never are, and answered 404 "slack not configured for this
 * agent" (measured on the live dashboard, 2026-10-07). The main agent's tokens,
 * primary and co-listen alike, are in the MAIN channel state dir. So the
 * dashboard's Teszt button, and with it the missing-scope warning
 * (SLACKSCOPEJELZ1007, im:read), never worked where the owner presses it.
 *
 * What each part proves, through the REAL route handler:
 * - the main agent's slack AND telegram tokens are read from the main state dir
 *   (its <PROVIDER>_STATE_DIR override pointed at a temp dir), not from
 *   agents/<main>/;
 * - the scope report (scopes / missingScopes) comes back for the main agent;
 * - a sub-agent still reads its own agents/<name>/ state dir, and an unknown
 *   sub-agent is still 404 "Agent not found";
 * - the main agent without a token is 404 "not configured", not a crash.
 * fetch is stubbed: no Slack or Telegram call.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ROOT = mkdtempSync(join(tmpdir(), 'chtest-route-'))
const AGENTS = join(ROOT, 'agents')

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...orig, agentDir: (name: string) => join(AGENTS, name) }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { MAIN_AGENT_ID, PROJECT_ROOT } = await import('../config.js')
type RouteContext = import('../web/routes/types.js').RouteContext

const ALL_SCOPES = 'app_mentions:read,channels:history,channels:read,chat:write,files:read,files:write,groups:history,groups:read,im:history,im:read,im:write,reactions:write,users:read'
const calls: Array<{ url: string; token: string }> = []

function fakeCtx(path: string) {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown> },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as RouteContext['req'], res, path: url.pathname, method: 'POST', url } as unknown as RouteContext
  return { ctx, out }
}
async function test(name: string, provider: string) {
  const { ctx, out } = fakeCtx(`/api/agents/${encodeURIComponent(name)}/channels/${provider}/test`)
  const handled = await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
  expect(handled).toBe(true)
  return out
}
function writeEnv(dir: string, line: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.env'), `${line}\n`)
}

let mainSlack = ''
let mainTelegram = ''
const saved = { slack: process.env.SLACK_STATE_DIR, telegram: process.env.TELEGRAM_STATE_DIR }

beforeEach(() => {
  calls.length = 0
  mainSlack = mkdtempSync(join(tmpdir(), 'chtest-main-slack-'))
  mainTelegram = mkdtempSync(join(tmpdir(), 'chtest-main-tg-'))
  process.env.SLACK_STATE_DIR = mainSlack
  process.env.TELEGRAM_STATE_DIR = mainTelegram
  vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string> }) => {
    // only the token part of the Authorization header is kept
    calls.push({ url: String(url), token: String(init?.headers?.Authorization ?? '').replace(/^\S+\s+/, '') })
    if (String(url).includes('slack.com/api/auth.test')) {
      const scopes = calls.length && String(init?.headers?.Authorization).includes('noimread')
        ? ALL_SCOPES.split(',').filter((s) => s !== 'im:read').join(',')
        : ALL_SCOPES
      return new Response(JSON.stringify({ ok: true, user: 'mainbot' }), { status: 200, headers: { 'content-type': 'application/json', 'x-oauth-scopes': scopes } })
    }
    // Telegram getMe
    return new Response(JSON.stringify({ ok: true, result: { username: 'main_tg_bot' } }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(mainSlack, { recursive: true, force: true })
  rmSync(mainTelegram, { recursive: true, force: true })
  rmSync(AGENTS, { recursive: true, force: true })
})
afterAll(() => {
  if (saved.slack === undefined) delete process.env.SLACK_STATE_DIR; else process.env.SLACK_STATE_DIR = saved.slack
  if (saved.telegram === undefined) delete process.env.TELEGRAM_STATE_DIR; else process.env.TELEGRAM_STATE_DIR = saved.telegram
  rmSync(ROOT, { recursive: true, force: true })
})

describe('channel test route: the main agent', () => {
  it('slack: the token comes from the main state dir, and the scope report comes back', async () => {
    writeEnv(mainSlack, 'SLACK_BOT_TOKEN=fixture-slack-main-noimread')
    const out = await test(MAIN_AGENT_ID, 'slack')
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, botName: 'mainbot', missingScopes: ['im:read'] })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://slack.com/api/auth.test')
    expect(calls[0].token).toBe('fixture-slack-main-noimread')
  })

  it('telegram: the token comes from the main state dir too', async () => {
    writeEnv(mainTelegram, 'TELEGRAM_BOT_TOKEN=111:main-telegram')
    const out = await test(MAIN_AGENT_ID, 'telegram')
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('111:main-telegram')
  })

  it('a token left under agents/<main>/ is NOT what the main agent is tested with', async () => {
    writeEnv(join(AGENTS, MAIN_AGENT_ID, '.claude', 'channels', 'slack'), 'SLACK_BOT_TOKEN=fixture-slack-wrong-place')
    writeEnv(mainSlack, 'SLACK_BOT_TOKEN=fixture-slack-main')
    const out = await test(MAIN_AGENT_ID, 'slack')
    expect(out.status).toBe(200)
    expect(calls[0].token).toBe('fixture-slack-main')
  })

  it('no token in the main state dir: 404 "not configured", no network call', async () => {
    const out = await test(MAIN_AGENT_ID, 'slack')
    expect(out.status).toBe(404)
    expect(String(out.body?.error)).toMatch(/not configured/)
    expect(calls).toHaveLength(0)
  })
})

describe('channel test route: a sub-agent is unchanged', () => {
  it('reads its own agents/<name>/ state dir, not the main one', async () => {
    writeEnv(mainSlack, 'SLACK_BOT_TOKEN=fixture-slack-main')
    writeEnv(join(AGENTS, 'zara', '.claude', 'channels', 'slack'), 'SLACK_BOT_TOKEN=fixture-slack-zara')
    const out = await test('zara', 'slack')
    expect(out.status).toBe(200)
    expect(calls[0].token).toBe('fixture-slack-zara')
  })

  it('an unknown sub-agent is still 404 "Agent not found", no network call', async () => {
    const out = await test('nincsilyen', 'slack')
    expect(out.status).toBe(404)
    expect(out.body?.error).toBe('Agent not found')
    expect(calls).toHaveLength(0)
  })
})
