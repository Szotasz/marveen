/**
 * ENVTEAMSNAME1028: the channel .env files are line-based KEY=value files like
 * the install's .env. A value with a line break would add a line of the
 * caller's choosing, so every channel .env writer refuses one before writing:
 * the Teams display-name sync, the Google Chat setup and the bot-token setup.
 * Every case runs in temp dirs; the setup route is only driven down its refusal
 * path, which returns before any write, network call or restart.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const ROOT = mkdtempSync(join(tmpdir(), 'chenv-line-'))
const AGENTS = join(ROOT, 'agents')

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...orig, agentDir: (name: string) => join(AGENTS, name) }
})

const { syncTeamsDisplayName } = await import('../web/agent-process.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { PROJECT_ROOT } = await import('../config.js')
type RouteContext = import('../web/routes/types.js').RouteContext

afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('syncTeamsDisplayName writes one line only', () => {
  it.each([['LF', 'Zara\nINJECTED_KEY=1'], ['CR', 'Zara\rINJECTED_KEY=1'], ['NUL', 'Zara\0x']])(
    'a display name with a %s is not written',
    (_kind, name) => {
      const envPath = join(ROOT, `teams-${_kind}.env`)
      writeFileSync(envPath, 'TEAMS_APP_ID=app\nTEAMS_BOT_DISPLAY_NAME=Old\n')
      expect(syncTeamsDisplayName(envPath, name)).toBe(false)
      expect(readFileSync(envPath, 'utf-8')).toBe('TEAMS_APP_ID=app\nTEAMS_BOT_DISPLAY_NAME=Old\n')
    },
  )

  it('a "$" in the name is written literally, not as a replacement pattern', () => {
    const envPath = join(ROOT, 'teams-dollar.env')
    writeFileSync(envPath, 'TEAMS_APP_ID=app\nTEAMS_BOT_DISPLAY_NAME=Old\n')
    expect(syncTeamsDisplayName(envPath, "Zara $` $& $'")).toBe(true)
    expect(readFileSync(envPath, 'utf-8')).toBe("TEAMS_APP_ID=app\nTEAMS_BOT_DISPLAY_NAME=Zara $` $& $'\n")
  })
})

function fakeCtx(path: string, body: unknown) {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown> },
  }
  const raw = Buffer.from(JSON.stringify(body))
  const req = { on(ev: string, cb: (x?: Buffer) => void) { if (ev === 'data') cb(raw); if (ev === 'end') cb(); return req } }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method: 'POST', url } as unknown as RouteContext
  return { ctx, out }
}

async function setup(provider: string, body: unknown) {
  const name = 'linetest'
  mkdirSync(join(AGENTS, name), { recursive: true })
  const { ctx, out } = fakeCtx(`/api/agents/${name}/channels/${provider}`, body)
  expect(await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))).toBe(true)
  return { out, envPath: join(AGENTS, name, '.claude', 'channels', provider, '.env') }
}

describe('channel setup refuses a multi-line value before writing', () => {
  it.each([
    ['saKeyPath', { saKeyPath: '/k.json\nINJECTED_KEY=1', projectId: 'p', subscription: 's', owner: 'o@x.hu' }],
    ['projectId', { saKeyPath: '/k.json', projectId: 'p\nINJECTED_KEY=1', subscription: 's', owner: 'o@x.hu' }],
    ['subscription', { saKeyPath: '/k.json', projectId: 'p', subscription: 's\rINJECTED_KEY=1', owner: 'o@x.hu' }],
  ])('googlechat %s', async (_field, body) => {
    const { out, envPath } = await setup('googlechat', body)
    expect(out.status).toBe(400)
    expect(existsSync(envPath)).toBe(false)
  })

  it.each([
    ['botToken', { botToken: 'xoxb-1\nINJECTED_KEY=1' }],
    ['appToken', { botToken: 'xoxb-1', appToken: 'xapp-1\nINJECTED_KEY=1' }],
  ])('slack %s', async (_field, body) => {
    // Never a real call, even if the guard regresses: the token check would go to Slack.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'))
    const { out, envPath } = await setup('slack', body)
    expect(out.status).toBe(400)
    expect(existsSync(envPath)).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
