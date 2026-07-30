import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    PROJECT_ROOT: '/tmp/marveen-test',
    MAIN_AGENT_ID: 'marveen',
    BOT_NAME: 'Jarvis',
    BRAND_NAME: 'Marveen',
    OWNER_NAME: 'Test User',
    CHANNEL_PROVIDER: 'telegram',
    KANBAN_LABEL_COLORS: {},
    currentBotName: () => 'TestBot',
    currentBrandName: () => 'Marveen',
    currentOwnerName: () => 'Test User',
  }
})
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/telegram.js', () => ({
  readMarveenTelegramConfig: vi.fn().mockReturnValue({ hasTelegram: false, botUsername: null }),
  readMarveenDiscordConfig: vi.fn().mockReturnValue({ hasDiscord: false }),
  readMarveenSlackConfig: vi.fn().mockReturnValue({ hasSlack: false }),
  readMarveenGooglechatConfig: vi.fn().mockReturnValue({ hasGooglechat: false }),
  readMarveenTeamsConfig: vi.fn().mockReturnValue({ hasTeams: false }),
  sendMarveenAvatarChange: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn().mockReturnValue({ ok: true }),
}))
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, readFileOr: vi.fn().mockReturnValue('') }
})
vi.mock('../web/multipart.js', () => ({
  parseMultipart: vi.fn().mockReturnValue({ file: null }),
}))
vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
  isMainChannelsAgent: vi.fn().mockReturnValue(false),
}))
vi.mock('../web/active-model.js', () => ({
  readActiveModelFromProjectDir: vi.fn().mockReturnValue('claude-sonnet-4-6'),
  readContextTokensFromProjectDir: vi.fn().mockReturnValue(null),
  projectsDirFor: vi.fn().mockReturnValue('/tmp/projects'),
}))
vi.mock('../web/auto-restart-store.js', () => ({
  readAutoRestartConfig: vi.fn().mockReturnValue({ enabled: false, sessionName: 'marveen-channels' }),
}))

import { tryHandleMarveen } from '../web/routes/marveen.js'

function makeCtx(method: string, path: string, body?: object, headers?: Record<string, string>): {
  ctx: RouteContext; out: { status: number; body: any }
} {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = headers ?? {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('tryHandleMarveen', () => {
  it('GET /api/marveen returns identity and config data', async () => {
    const { ctx, out } = makeCtx('GET', '/api/marveen')
    expect(await tryHandleMarveen(ctx, '/tmp/webdir')).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.name).toBe('TestBot')
    expect(out.body.agentId).toBe('marveen')
    expect(out.body.role).toBe('main')
    expect(typeof out.body.hasTelegram).toBe('boolean')
  })

  it('PUT /api/marveen returns readonly:true', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/marveen')
    expect(await tryHandleMarveen(ctx, '/tmp/webdir')).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.readonly).toBe(true)
  })

  it('POST /api/marveen/restart returns ok when restart succeeds', async () => {
    const { ctx, out } = makeCtx('POST', '/api/marveen/restart')
    expect(await tryHandleMarveen(ctx, '/tmp/webdir')).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
  })

  it('POST /api/marveen/restart returns 500 when restart fails', async () => {
    const monitor = await import('../web/channel-monitor.js')
    vi.mocked(monitor.hardRestartMarveenChannels).mockReturnValueOnce({ ok: false, error: 'tmux failed' })
    const { ctx, out } = makeCtx('POST', '/api/marveen/restart')
    expect(await tryHandleMarveen(ctx, '/tmp/webdir')).toBe(true)
    expect(out.status).toBe(500)
    expect(out.body.error).toMatch(/restart failed|tmux failed/i)
  })

  it('GET /api/marveen/avatar returns 404 when no avatar file exists', async () => {
    const { ctx, out } = makeCtx('GET', '/api/marveen/avatar')
    expect(await tryHandleMarveen(ctx, '/tmp/webdir-no-avatars')).toBe(true)
    expect(out.status).toBe(404)
  })

  it('POST /api/marveen/avatar returns 400 when no file uploaded', async () => {
    const { ctx, out } = makeCtx('POST', '/api/marveen/avatar', undefined, { 'content-type': 'multipart/form-data' })
    expect(await tryHandleMarveen(ctx, '/tmp/webdir')).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/no file/i)
  })

  it('POST /api/marveen/avatar returns 400 when galleryAvatar missing in JSON', async () => {
    const { ctx, out } = makeCtx('POST', '/api/marveen/avatar', {}, { 'content-type': 'application/json' })
    expect(await tryHandleMarveen(ctx, '/tmp/webdir')).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/avatar/i)
  })

  it('POST /api/marveen/avatar returns 404 when gallery file missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/marveen/avatar', { galleryAvatar: 'nonexistent.png' }, { 'content-type': 'application/json' })
    expect(await tryHandleMarveen(ctx, '/tmp/webdir-no-avatars')).toBe(true)
    expect(out.status).toBe(404)
    expect(out.body.error).toMatch(/not found/i)
  })

  it('POST /api/marveen/avatar returns 400 for path traversal in galleryAvatar', async () => {
    const { ctx, out } = makeCtx('POST', '/api/marveen/avatar', { galleryAvatar: '../etc/passwd' }, { 'content-type': 'application/json' })
    expect(await tryHandleMarveen(ctx, '/tmp/webdir')).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/invalid avatar name/i)
  })

  it('POST /api/marveen/avatar replaces existing avatar with gallery file', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync, writeFileSync, mkdtempSync } = require('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: pjoin } = require('node:path')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir } = require('node:os')
    // Create store dir under mocked PROJECT_ROOT and place an existing avatar there
    mkdirSync('/tmp/marveen-test/store', { recursive: true })
    writeFileSync('/tmp/marveen-test/store/marveen-avatar.png', Buffer.from('PNG'))
    // Create a temp webDir with a gallery file
    const webDir = mkdtempSync(pjoin(tmpdir(), 'marveen-web-'))
    mkdirSync(pjoin(webDir, 'avatars'), { recursive: true })
    writeFileSync(pjoin(webDir, 'avatars', 'gallery.png'), Buffer.from('PNG'))
    const { ctx, out } = makeCtx('POST', '/api/marveen/avatar', { galleryAvatar: 'gallery.png' }, { 'content-type': 'application/json' })
    expect(await tryHandleMarveen(ctx, webDir)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    // cleanup: delete the artifact so subsequent runs don't break the GET-404 test
    try { require('node:fs').rmSync('/tmp/marveen-test/store', { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('GET /api/marveen/avatar serves avatar from store when file exists', async () => {
    const { mkdirSync, writeFileSync, unlinkSync } = require('node:fs') // eslint-disable-line @typescript-eslint/no-require-imports
    mkdirSync('/tmp/marveen-test/store', { recursive: true })
    writeFileSync('/tmp/marveen-test/store/marveen-avatar.png', Buffer.from('\x89PNG'))
    const { ctx, out } = makeCtx('GET', '/api/marveen/avatar')
    expect(await tryHandleMarveen(ctx, '/tmp/webdir')).toBe(true)
    expect(out.status).toBe(200)
    unlinkSync('/tmp/marveen-test/store/marveen-avatar.png')
  })

  it('returns false for unmatched route', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    expect(await tryHandleMarveen(ctx, '/tmp/webdir')).toBe(false)
  })
})
