import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// Set up a fake web directory with real files so the route handler can serve them.
let FAKE_WEB_DIR = ''

beforeAll(() => {
  FAKE_WEB_DIR = mkdtempSync(join(tmpdir(), 'static-test-'))
  writeFileSync(join(FAKE_WEB_DIR, 'index.html'), `<!DOCTYPE html><html><head>
<script src="/app.js"></script>
<link rel="stylesheet" href="/style.css">
<meta name="apple-mobile-web-app-title" content="Marveen">
</head><body></body></html>`)
  writeFileSync(join(FAKE_WEB_DIR, 'app.js'), 'console.log("app")')
  writeFileSync(join(FAKE_WEB_DIR, 'style.css'), 'body{}')
  writeFileSync(join(FAKE_WEB_DIR, 'sw.js'), 'self.addEventListener("install",()=>{})')
  writeFileSync(join(FAKE_WEB_DIR, 'manifest.json'), JSON.stringify({
    name: 'Marveen Dashboard',
    short_name: 'Marveen',
    icons: [{ src: '/icons/favicon.png', sizes: '192x192', type: 'image/png' }],
  }, null, 2))
  mkdirSync(join(FAKE_WEB_DIR, 'lang'))
  writeFileSync(join(FAKE_WEB_DIR, 'lang', 'hu.js'), 'export default {}')
  writeFileSync(join(FAKE_WEB_DIR, 'lang', 'en.js'), 'export default {}')
  mkdirSync(join(FAKE_WEB_DIR, 'avatars'))
  writeFileSync(join(FAKE_WEB_DIR, 'avatars', 'test.png'), 'PNG_DATA')
  mkdirSync(join(FAKE_WEB_DIR, 'icons'))
  writeFileSync(join(FAKE_WEB_DIR, 'icons', 'favicon.png'), 'PNG_ICON')
  mkdirSync(join(FAKE_WEB_DIR, 'modules'))
  writeFileSync(join(FAKE_WEB_DIR, 'modules', 'utils.js'), 'export const x = 1')
})

afterAll(() => {
  if (FAKE_WEB_DIR) rmSync(FAKE_WEB_DIR, { recursive: true, force: true })
})

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/fake/project',
  BRAND_NAME: 'TestBrand',
}))

vi.mock('../web/http-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/http-helpers.js')>()
  return {
    ...actual,
    serveFile: vi.fn().mockImplementation((_req: unknown, res: any) => {
      res.writeHead(200)
      res.end('file-content')
    }),
  }
})

import { tryHandleStatic, buildManifest, rewriteIndexHtml, MODULE_FILENAME_PATTERN } from '../web/routes/static.js'

function makeCtx(method: string, path: string, headers: Record<string, string> = {}): {
  ctx: RouteContext; res: { code: number; body: string; headers: Record<string, string> }
} {
  const em = new EventEmitter() as any
  em.method = method
  em.headers = { ...headers }
  const out = { code: 200, body: '', headers: {} as Record<string, string> }
  const res = {
    writeHead: (c: number, h?: Record<string, string>) => { out.code = c; if (h) Object.assign(out.headers, h) },
    end: (b?: string) => { out.body = b ?? '' },
    setHeader: vi.fn(),
  } as any
  const ctx: RouteContext = {
    req: em as http.IncomingMessage,
    res: res as http.ServerResponse,
    path,
    method,
    url: new URL(`http://localhost${path}`),
    auth: { kind: 'token' },
  }
  return { ctx, res: out }
}

describe('buildManifest', () => {
  it('replaces name field', () => {
    const raw = JSON.stringify({ name: 'Old Dashboard', short_name: 'Old' }, null, 2)
    const result = buildManifest(raw, 'NewBrand')
    expect(result).toContain('"NewBrand Dashboard"')
    expect(result).toContain('"NewBrand"')
  })

  it('leaves manifest unchanged for stock brand name', () => {
    const raw = JSON.stringify({ name: 'Marveen Dashboard', short_name: 'Marveen' }, null, 2)
    const result = buildManifest(raw, 'Marveen')
    expect(result).toContain('Marveen Dashboard')
  })
})

describe('rewriteIndexHtml', () => {
  it('rewrites app.js version', () => {
    const html = '<script src="/app.js"></script>'
    const result = rewriteIndexHtml(html, 'v1', 'v2', 'Brand')
    expect(result).toContain('?v=v1')
  })

  it('rewrites style.css version', () => {
    const html = '<link rel="stylesheet" href="/style.css">'
    const result = rewriteIndexHtml(html, 'v1', 'v2', 'Brand')
    expect(result).toContain('?v=v2')
  })

  it('rewrites apple-mobile-web-app-title', () => {
    const html = '<meta name="apple-mobile-web-app-title" content="OldBrand">'
    const result = rewriteIndexHtml(html, 'v1', 'v2', 'NewBrand')
    expect(result).toContain('NewBrand')
  })
})

describe('MODULE_FILENAME_PATTERN', () => {
  it('accepts valid module names', () => {
    expect(MODULE_FILENAME_PATTERN.test('utils.js')).toBe(true)
    expect(MODULE_FILENAME_PATTERN.test('my-module.js')).toBe(true)
    expect(MODULE_FILENAME_PATTERN.test('my_module_v2.js')).toBe(true)
  })

  it('rejects names with path traversal', () => {
    expect(MODULE_FILENAME_PATTERN.test('../utils.js')).toBe(false)
    expect(MODULE_FILENAME_PATTERN.test('sub/utils.js')).toBe(false)
  })
})

describe('tryHandleStatic', () => {
  it('serves index.html for GET /', async () => {
    const { ctx, res } = makeCtx('GET', '/')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
    expect(res.code).toBe(200)
  })

  it('serves index.html for GET /index.html', async () => {
    const { ctx, res } = makeCtx('GET', '/index.html')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
    expect(res.code).toBe(200)
  })

  it('serves 304 for GET / when ETag matches', async () => {
    // First request to get ETag
    const { ctx: ctx1, res: res1 } = makeCtx('GET', '/')
    await tryHandleStatic(ctx1, FAKE_WEB_DIR)
    const etag = res1.headers['ETag']

    if (etag) {
      const { ctx: ctx2, res: res2 } = makeCtx('GET', '/', { 'if-none-match': etag })
      const handled = await tryHandleStatic(ctx2, FAKE_WEB_DIR)
      expect(handled).toBe(true)
      expect(res2.code).toBe(304)
    }
  })

  it('serves /style.css', async () => {
    const { ctx } = makeCtx('GET', '/style.css')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
  })

  it('serves /app.js', async () => {
    const { ctx } = makeCtx('GET', '/app.js')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
  })

  it('serves /manifest.json without avatar', async () => {
    const { ctx, res } = makeCtx('GET', '/manifest.json')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
    expect(res.code).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.name).toContain('TestBrand')
  })

  it('serves /sw.js', async () => {
    const { ctx } = makeCtx('GET', '/sw.js')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
  })

  it('serves /lang/hu.js', async () => {
    const { ctx } = makeCtx('GET', '/lang/hu.js')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
  })

  it('serves /lang/en.js', async () => {
    const { ctx } = makeCtx('GET', '/lang/en.js')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
  })

  it('returns 404 for unknown lang file', async () => {
    const { ctx, res } = makeCtx('GET', '/lang/de.js')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
    expect(res.code).toBe(404)
  })

  it('serves existing avatar file', async () => {
    const { ctx } = makeCtx('GET', '/avatars/test.png')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
  })

  it('returns 404 for missing avatar', async () => {
    const { ctx, res } = makeCtx('GET', '/avatars/nonexistent.png')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
    expect(res.code).toBe(404)
  })

  it('serves existing icon file', async () => {
    const { ctx } = makeCtx('GET', '/icons/favicon.png')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
  })

  it('returns 404 for missing icon', async () => {
    const { ctx, res } = makeCtx('GET', '/icons/missing.svg')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
    expect(res.code).toBe(404)
  })

  it('serves existing module file', async () => {
    const { ctx } = makeCtx('GET', '/modules/utils.js')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
  })

  it('returns 404 for missing module', async () => {
    const { ctx, res } = makeCtx('GET', '/modules/nonexistent.js')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
    expect(res.code).toBe(404)
  })

  it('returns 404 for invalid module filename (path traversal)', async () => {
    const { ctx, res } = makeCtx('GET', '/modules/../secret.js')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(true)
    expect(res.code).toBe(404)
  })

  it('returns false for unknown routes', async () => {
    const { ctx } = makeCtx('GET', '/api/some-api')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(false)
  })

  it('returns false for POST method on unknown path', async () => {
    const { ctx } = makeCtx('POST', '/unknown')
    const handled = await tryHandleStatic(ctx, FAKE_WEB_DIR)
    expect(handled).toBe(false)
  })
})
