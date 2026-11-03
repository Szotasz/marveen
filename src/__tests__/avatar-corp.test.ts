// CORPAVATAR1024: the bot's and the owner's portraits are public (no auth), but no
// other website may embed them. Both GETs answer with
// Cross-Origin-Resource-Policy: same-origin, on a fresh 200, on a 304 revalidation
// and on the 404, so a browser refuses a cross-origin <img> in every case.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const tmpRoot = mkdtempSync(join(tmpdir(), 'avatar-corp-'))
const STORE = join(tmpRoot, 'store')
const WEB = join(tmpRoot, 'web')
mkdirSync(STORE, { recursive: true })
mkdirSync(join(WEB, 'avatars'), { recursive: true })

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: tmpRoot,
}))

const { tryHandleMarveen } = await import('../web/routes/marveen.js')

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

async function get(path: string, headers: Record<string, string> = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const handled = await tryHandleMarveen({ req, res, path: url.pathname, method: req.method || 'GET', url } as never, WEB)
    if (!handled) { res.writeHead(599); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const { port } = server.address() as AddressInfo
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers })
    await r.arrayBuffer()
    return { status: r.status, corp: r.headers.get('cross-origin-resource-policy'), etag: r.headers.get('etag') }
  } finally {
    server.close()
  }
}

const ROUTES = [
  { path: '/api/marveen/owner-avatar', file: () => join(STORE, 'owner-avatar.png') },
  { path: '/api/marveen/avatar', file: () => join(STORE, 'marveen-avatar.png') },
]

describe('avatar GETs refuse cross-origin embedding (Cross-Origin-Resource-Policy)', () => {
  beforeEach(() => {
    for (const n of ['owner-avatar', 'marveen-avatar']) {
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) rmSync(join(STORE, `${n}${ext}`), { force: true })
    }
    rmSync(join(WEB, 'avatars', '01_robot.png'), { force: true })
  })

  for (const { path, file } of ROUTES) {
    it(`${path}: same-origin on 200 and on the 304 revalidation`, async () => {
      writeFileSync(file(), 'png')
      const first = await get(path)
      expect(first.status).toBe(200)
      expect(first.corp).toBe('same-origin')
      const again = await get(path, { 'If-None-Match': first.etag! })
      expect(again.status).toBe(304)
      expect(again.corp).toBe('same-origin')
    })

    it(`${path}: same-origin on the 404 too`, async () => {
      const r = await get(path)
      expect(r.status).toBe(404)
      expect(r.corp).toBe('same-origin')
    })
  }

  it('/api/marveen/avatar: the gallery fallback carries it as well', async () => {
    writeFileSync(join(WEB, 'avatars', '01_robot.png'), 'robot')
    const r = await get('/api/marveen/avatar')
    expect(r.status).toBe(200)
    expect(r.corp).toBe('same-origin')
  })
})
