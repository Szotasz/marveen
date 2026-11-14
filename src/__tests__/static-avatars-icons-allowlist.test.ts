// Defense-in-depth: the /avatars/ and /icons/ static routes validate the single
// filename segment against an allowlist (STATIC_NAME_RE + basename() check),
// mirroring routes/docs.ts. No live traversal exists today (url.pathname is
// WHATWG-normalized upstream), so these drive the guard directly with crafted
// segments. Each negative case targets a file that WOULD be served without the
// guard (a real file reachable via `..`, or a real bad-extension file inside the
// served dir), so removing the guard makes them fail -- the mutant control.
// Finding LOW-1, sec-audit-1114.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { tryHandleStatic } from '../web/routes/static.js'

let webDir: string

beforeAll(() => {
  webDir = mkdtempSync(join(tmpdir(), 'static-allowlist-'))
  mkdirSync(join(webDir, 'avatars'))
  mkdirSync(join(webDir, 'icons'))
  // Legit assets.
  writeFileSync(join(webDir, 'avatars', '01_robot.png'), 'PNG')
  writeFileSync(join(webDir, 'icons', 'icon-192.png'), 'PNG')
  writeFileSync(join(webDir, 'avatars', 'gallery.html'), '<html>')
  // A real bad-extension file INSIDE the served dir: without the guard
  // existsSync() would serve it (200); the guard must 404 it.
  writeFileSync(join(webDir, 'avatars', 'config.txt'), 'SECRET')
  // A real file OUTSIDE the served dir that a `..` segment resolves to: without
  // the guard join(webDir,'avatars','../secret.txt') serves it (200 leak).
  writeFileSync(join(webDir, 'secret.txt'), 'TOP SECRET')
})

afterAll(() => rmSync(webDir, { recursive: true, force: true }))

// Minimal ServerResponse capturing the status code only.
function mockCtx(path: string) {
  let status = 0
  const res: any = {
    writeHead(code: number) { status = code; return res },
    end() { return res },
  }
  const req: any = { headers: {} }
  return { ctx: { req, res, path, method: 'GET', url: new URL(`http://x${path}`) } as any, status: () => status }
}

async function get(path: string): Promise<number> {
  const { ctx, status } = mockCtx(path)
  const handled = await tryHandleStatic(ctx, webDir)
  expect(handled).toBe(true)
  return status()
}

describe('LOW-1: /avatars/ and /icons/ filename allowlist', () => {
  it('serves a real existing avatar (200)', async () => {
    expect(await get('/avatars/01_robot.png')).toBe(200)
  })

  it('serves a real existing icon (200)', async () => {
    expect(await get('/icons/icon-192.png')).toBe(200)
  })

  it('still serves the shipped gallery.html (200) -- behaviour preserved', async () => {
    expect(await get('/avatars/gallery.html')).toBe(200)
  })

  // Mutant-detecting: secret.txt is reachable via `..` from the avatars dir.
  it('404s a traversal avatar name (would 200 without the guard)', async () => {
    expect(await get('/avatars/../secret.txt')).toBe(404)
    expect(await get('/icons/../secret.txt')).toBe(404)
  })

  // Mutant-detecting: config.txt exists inside the avatars dir.
  it('404s a bad-extension name that exists in the dir (would 200 without the guard)', async () => {
    expect(await get('/avatars/config.txt')).toBe(404)
  })

  it('404s a nested/encoded avatar segment', async () => {
    expect(await get('/avatars/sub/01_robot.png')).toBe(404)
    expect(await get('/avatars/..%2Fsecret.txt')).toBe(404)
  })
})
