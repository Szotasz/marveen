import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => ({
  sessionExistsOnHost: vi.fn().mockReturnValue(false),
  hardRestart: vi.fn().mockReturnValue({ ok: true }),
  mainChannelsSessionExists: vi.fn().mockReturnValue(false),
  createMainChannelsSession: vi.fn().mockReturnValue('started'),
  liveProbeAuth: vi.fn().mockResolvedValue('ok'),
  stampTokenVerified: vi.fn(),
  readChannelToken: vi.fn().mockReturnValue(null),
  channelStateDir: vi.fn().mockReturnValue('/tmp'),
  atomicWriteFileSync: vi.fn(),
  // Mock execFileSync to simulate no keychain credential
  execFileSync: vi.fn().mockImplementation(() => { throw new Error('not found') }),
  // Mock userInfo to provide a username
  userInfo: vi.fn().mockReturnValue({ username: 'testuser' }),
  // Mock homedir to point at /tmp (no .credentials.json there)
  homedir: vi.fn().mockReturnValue('/tmp/no-creds-home'),
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/no-creds-home',
  STORE_DIR: '/tmp/no-creds-home',
  OWNER_NAME: 'test',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>()
  return { ...orig, homedir: mocks.homedir, userInfo: mocks.userInfo }
})

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return { ...orig, execFileSync: mocks.execFileSync }
})

vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: mocks.atomicWriteFileSync }))
vi.mock('../web/claude-credentials-guard.js', () => ({
  liveProbeAuth: mocks.liveProbeAuth,
  stampTokenVerified: mocks.stampTokenVerified,
}))
vi.mock('../web/agent-process.js', () => ({ sessionExistsOnHost: mocks.sessionExistsOnHost }))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: mocks.hardRestart,
  mainChannelsSessionExists: mocks.mainChannelsSessionExists,
  createMainChannelsSession: mocks.createMainChannelsSession,
}))
vi.mock('../channel-provider.js', () => ({
  channelStateDir: mocks.channelStateDir,
  readChannelToken: mocks.readChannelToken,
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))

import { tryHandleOnboarding } from '../web/routes/onboarding.js'

function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('POST /api/onboarding/launch error normalization', () => {
  it('returns conflict (not forbidden) with 409 when Claude auth absent', async () => {
    // agentsRunning() -> sessionExistsOnHost returns false (no tmux session)
    // claudeAuthPresent() false: /tmp/no-creds-home/.env absent, no credentials.json,
    //   no fleet token file, execFileSync throws (no keychain entry)
    mocks.sessionExistsOnHost.mockReturnValue(false)
    const { ctx, out } = makeCtx('POST', '/api/onboarding/launch')
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(409)
    expect((out.body as { error: string }).error).toBe('conflict')
  })
})
