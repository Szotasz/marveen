import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return { tmpRoot: mkdtempSync(j(tmpdir(), 'marveen-autonomy-routes-test-')) }
})

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  STORE_DIR: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: vi.fn() }))

import { tryHandleAutonomy } from '../web/routes/autonomy.js'

const configPath = join(tmpRoot, 'autonomy-config.json')

const sampleConfig = {
  version: 1,
  updated_at: 0,
  categories: [
    { key: 'deploy', label: 'Deploy', level: 1, locked: false, maxLevel: 3 },
    { key: 'safety', label: 'Safety', level: 1, locked: true, maxLevel: 1 },
    { key: 'limited', label: 'Limited', level: 1, locked: false, maxLevel: 2 },
  ],
}

function writeConfig(cfg = sampleConfig) {
  writeFileSync(configPath, JSON.stringify(cfg))
}

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

describe('tryHandleAutonomy error normalization', () => {
  beforeEach(() => writeConfig())

  it('GET returns not_found when config file absent', async () => {
    unlinkSync(configPath)
    const { ctx, out } = makeCtx('GET', '/api/autonomy')
    await tryHandleAutonomy(ctx)
    expect(out.status).toBe(404)
    expect((out.body as { error: string }).error).toBe('not_found')
  })

  it('POST returns invalid_value when level out of range', async () => {
    const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'deploy', level: 5 })
    await tryHandleAutonomy(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toBe('invalid_value')
  })

  it('POST returns not_found when category key unknown', async () => {
    const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'nonexistent', level: 2 })
    await tryHandleAutonomy(ctx)
    expect(out.status).toBe(404)
    expect((out.body as { error: string }).error).toBe('not_found')
  })

  it('POST returns forbidden when category is locked and level > 1', async () => {
    const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'safety', level: 2 })
    await tryHandleAutonomy(ctx)
    expect(out.status).toBe(403)
    expect((out.body as { error: string }).error).toBe('forbidden')
  })

  it('POST returns invalid_value with field=level when level exceeds maxLevel', async () => {
    const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'limited', level: 3 })
    await tryHandleAutonomy(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string; field: string }).error).toBe('invalid_value')
    expect((out.body as { error: string; field: string }).field).toBe('level')
  })

  it('POST returns ok for valid update', async () => {
    const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'deploy', level: 2 })
    await tryHandleAutonomy(ctx)
    expect(out.status).toBe(200)
    expect((out.body as { ok: boolean }).ok).toBe(true)
  })
})
