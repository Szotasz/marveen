// VIDEOREVIEW1002: the video review routes through a real HTTP server, plus the
// pure core. The main risk is local file access, so most cases are about the
// root: traversal, absolute paths, symlink escapes, and the ticket that is the
// only way to stream a file.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'marveen-video-review-test-')))
const root = join(base, 'deliverables')
const outside = join(base, 'outside')
const projectRoot = join(base, 'project')
mkdirSync(join(root, 'sub'), { recursive: true })
mkdirSync(outside, { recursive: true })
mkdirSync(projectRoot, { recursive: true })
const VIDEO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
writeFileSync(join(root, 'a.mp4'), VIDEO)
writeFileSync(join(root, 'sub', 'b-v2.mp4'), VIDEO.subarray(0, 500))
writeFileSync(join(root, 'notes.txt'), 'not a video')
writeFileSync(join(outside, 'secret.mp4'), 'SECRET')
writeFileSync(join(outside, 'passwd'), 'root:x')
symlinkSync(join(outside, 'secret.mp4'), join(root, 'escape.mp4'))
symlinkSync(outside, join(root, 'linkdir'))

const envValues: Record<string, string> = { VIDEO_REVIEW_ROOT: root, VIDEO_REVIEW_AGENT: 'iris' }
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), PROJECT_ROOT: projectRoot }))
vi.mock('../env.js', () => ({ readEnvFile: () => ({ ...envValues }) }))
vi.mock('../web/agent-config.js', () => ({ isKnownAgent: (n: string) => n === 'iris' }))
const queued: Array<[string, string, string, string | null | undefined]> = []
vi.mock('../db.js', () => ({
  createAgentMessage: (from: string, to: string, content: string, note?: string | null) => {
    queued.push([from, to, content, note]); return { id: 4242 }
  },
}))
vi.mock('../logger.js', () => {
  const l: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  l.child = () => l
  return { logger: l }
})

const { tryHandleVideoReview } = await import('../web/routes/video-review.js')
const core = await import('../web/video-review.js')
const { requiresAuth } = await import('../web/auth-gate.js')
const { isBlockedCrossOriginWrite } = await import('../web/csrf-origin.js')

const webDir = join(base, 'web')
mkdirSync(webDir)
writeFileSync(join(webDir, 'video-review.html'), '<html>review</html>')
writeFileSync(join(webDir, 'video-review.js'), '//js')

let server: http.Server
let origin = ''
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const ctx: any = { req, res, path: url.pathname, method: req.method ?? 'GET', url }
    if (!(await tryHandleVideoReview(ctx, webDir))) { res.writeHead(404); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  origin = `http://127.0.0.1:${(server.address() as any).port}`
})
afterAll(() => { server.close(); rmSync(base, { recursive: true, force: true }) })

const post = (p: string, body: unknown, ct = 'application/json') =>
  fetch(origin + p, { method: 'POST', headers: { 'Content-Type': ct }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const put = (p: string, body: unknown, ct = 'application/json') =>
  fetch(origin + p, { method: 'PUT', headers: { 'Content-Type': ct }, body: typeof body === 'string' ? body : JSON.stringify(body) })
async function ticketFor(p: string): Promise<string> {
  const r = await post('/api/video-review/ticket', { path: p })
  expect(r.status).toBe(200)
  return (await r.json()).url
}

describe('resolveUnderRoot (the containment check)', () => {
  const rr = realpathSync(root)
  it('accepts a relative path inside the root', () => {
    const r = core.resolveUnderRoot(rr, 'sub/b-v2.mp4', { mustExist: true })
    expect(r).toEqual({ ok: true, abs: join(rr, 'sub', 'b-v2.mp4'), rel: 'sub/b-v2.mp4' })
  })
  it.each([
    ['../outside/passwd', 400], ['sub/../../outside/passwd', 400], ['..', 400],
    ['/etc/passwd', 400], [join(outside, 'passwd'), 400], ['C:\\\\x', 400], ['a\u0000b', 400], ['', 400],
  ])('refuses %j', (p, status) => {
    const r = core.resolveUnderRoot(rr, p, { mustExist: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(status)
  })
  it('refuses a symlinked FILE that points outside (realpath check)', () => {
    const r = core.resolveUnderRoot(rr, 'escape.mp4', { mustExist: true })
    expect(r).toMatchObject({ ok: false, status: 403 })
  })
  it('refuses a new file under a symlinked DIRECTORY that points outside', () => {
    const r = core.resolveUnderRoot(rr, 'linkdir/new.review.json', { mustExist: false })
    expect(r).toMatchObject({ ok: false, status: 403 })
  })
  it('a missing file is 404 for reads', () => {
    expect(core.resolveUnderRoot(rr, 'nope.mp4', { mustExist: true })).toMatchObject({ ok: false, status: 404 })
  })
})

describe('the routes', () => {
  it('lists only real video files under the root, no symlinks, no other types', async () => {
    const r = await fetch(origin + '/api/video-review/videos')
    const paths = (await r.json()).videos.map((v: any) => v.path).sort()
    expect(paths).toEqual(['a.mp4', 'sub/b-v2.mp4'])
  })

  it('ticket: traversal 400, symlink escape 403, a non-video 400', async () => {
    expect((await post('/api/video-review/ticket', { path: '../outside/secret.mp4' })).status).toBe(400)
    expect((await post('/api/video-review/ticket', { path: 'escape.mp4' })).status).toBe(403)
    expect((await post('/api/video-review/ticket', { path: 'notes.txt' })).status).toBe(400)
  })

  it('the file stream needs a valid ticket, and serves only that file', async () => {
    expect((await fetch(origin + '/api/video-review/file')).status).toBe(403)
    // A path parameter is no substitute for a ticket.
    expect((await fetch(origin + '/api/video-review/file?path=a.mp4')).status).toBe(403)
    expect((await fetch(origin + '/api/video-review/file?ticket=' + 'x'.repeat(32))).status).toBe(403)
    const url = await ticketFor('a.mp4')
    const full = await fetch(origin + url)
    expect(full.status).toBe(200)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await full.arrayBuffer()).equals(VIDEO)).toBe(true)
  })

  it('Range: 206 with the exact bytes, suffix ranges, 416 past the end', async () => {
    const url = await ticketFor('a.mp4')
    const r = await fetch(origin + url, { headers: { Range: 'bytes=10-19' } })
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 10-19/1000')
    expect(Buffer.from(await r.arrayBuffer()).equals(VIDEO.subarray(10, 20))).toBe(true)
    const tail = await fetch(origin + url, { headers: { Range: 'bytes=-5' } })
    expect(tail.headers.get('content-range')).toBe('bytes 995-999/1000')
    expect((await fetch(origin + url, { headers: { Range: 'bytes=5000-' } })).status).toBe(416)
  })

  it('serve time: a root changed after the ticket is 404', async () => {
    const url = await ticketFor('a.mp4')
    envValues.VIDEO_REVIEW_ROOT = outside
    expect((await fetch(origin + url)).status).toBe(404)
    envValues.VIDEO_REVIEW_ROOT = root
    expect((await fetch(origin + url)).status).toBe(200)
  })

  it('serve time: a file swapped for a symlink out after the ticket is not streamed', async () => {
    writeFileSync(join(root, 'swap.mp4'), VIDEO)
    const url = await ticketFor('swap.mp4')
    rmSync(join(root, 'swap.mp4'))
    symlinkSync(join(outside, 'secret.mp4'), join(root, 'swap.mp4'))
    const r = await fetch(origin + url)
    expect(r.status).toBe(404)
    expect(await r.text()).not.toContain('SECRET')
    rmSync(join(root, 'swap.mp4'))
  })

  it('PUT review: non-JSON is 415, nothing written', async () => {
    const r = await put('/api/video-review/review?path=a.mp4', 'video=a.mp4', 'application/x-www-form-urlencoded')
    expect(r.status).toBe(415)
    expect(existsSync(join(root, 'a.mp4.review.json'))).toBe(false)
  })

  it('PUT review: written next to the video, video field forced to the query path', async () => {
    const r = await put('/api/video-review/review?path=sub/b-v2.mp4', {
      video: '../../etc/passwd', fps: 30, notes: [
        { t: 1.5, text: 'Itt a kéz <script>alert(1)</script>', version: 'sub/b-v2.mp4', x: 0.2, y: 0.3 },
        { t: 0.25, text: 'box', version: 'a.mp4', x: 0.1, y: 0.1, w: 0.5, h: 0.4, status: 'done' },
      ],
    })
    expect(r.status).toBe(200)
    const saved = JSON.parse(readFileSync(join(root, 'sub', 'b-v2.mp4.review.json'), 'utf8'))
    expect(saved.video).toBe('sub/b-v2.mp4')
    expect(saved.notes.map((n: any) => n.t)).toEqual([0.25, 1.5])
    expect(saved.notes[0]).toMatchObject({ w: 0.5, h: 0.4, status: 'done' })
    const back = await (await fetch(origin + '/api/video-review/review?path=sub/b-v2.mp4')).json()
    expect(back.review.notes).toHaveLength(2)
  })

  it('PUT review: traversal in the query is refused, a symlinked target is refused', async () => {
    expect((await put('/api/video-review/review?path=../outside/secret.mp4', { video: 'x', notes: [] })).status).toBe(400)
    expect((await put('/api/video-review/review?path=escape.mp4', { video: 'x', notes: [] })).status).toBe(403)
    expect(existsSync(join(outside, 'secret.mp4.review.json'))).toBe(false)
  })

  it('PUT review: out-of-range coordinates and oversized notes are 400', async () => {
    expect((await put('/api/video-review/review?path=a.mp4', { video: 'a.mp4', notes: [{ t: 1, text: 'x', version: 'a.mp4', x: 2, y: 0 }] })).status).toBe(400)
    expect((await put('/api/video-review/review?path=a.mp4', { video: 'a.mp4', notes: [{ t: 1, text: 'x'.repeat(2001), version: 'a.mp4' }] })).status).toBe(400)
  })

  it('send: queued server-side for the configured agent with the review path; non-JSON 415', async () => {
    expect((await post('/api/video-review/send', 'path=sub/b-v2.mp4', 'text/plain')).status).toBe(415)
    const r = await post('/api/video-review/send', { path: 'sub/b-v2.mp4' })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, messageId: 4242, to: 'iris' })
    const [from, to, content, note] = queued.at(-1)!
    expect([from, to, note]).toEqual(['video-review', 'iris', 'video-review (dashboard)'])
    expect(content).toContain(join(root, 'sub', 'b-v2.mp4.review.json'))
    expect(content).toContain('nyitott: 1')
  })

  it('send: nothing to send is 409; an unknown agent disables sending', async () => {
    expect((await post('/api/video-review/send', { path: 'a.mp4' })).status).toBe(409)
    envValues.VIDEO_REVIEW_AGENT = 'not-an-agent'
    const cfg = await (await fetch(origin + '/api/video-review/config')).json()
    expect(cfg).toEqual({ enabled: true, agent: null })
    expect((await post('/api/video-review/send', { path: 'sub/b-v2.mp4' })).status).toBe(409)
    envValues.VIDEO_REVIEW_AGENT = 'iris'
  })

  it('no root configured: the API is off (config says disabled, the rest 404)', async () => {
    envValues.VIDEO_REVIEW_ROOT = ''
    expect(await (await fetch(origin + '/api/video-review/config')).json()).toEqual({ enabled: false, agent: 'iris' })
    expect((await fetch(origin + '/api/video-review/videos')).status).toBe(404)
    envValues.VIDEO_REVIEW_ROOT = root
  })

  it('serves the page and its script', async () => {
    expect(await (await fetch(origin + '/video-review')).text()).toBe('<html>review</html>')
    expect((await fetch(origin + '/video-review.js')).status).toBe(200)
  })
})

describe('the global gates on these paths', () => {
  it('auth: only the ticket-authorised file stream skips the auth gate', () => {
    expect(requiresAuth('/api/video-review/file', 'GET')).toBe(false)
    expect(requiresAuth('/api/video-review/file', 'HEAD')).toBe(false)
    expect(requiresAuth('/api/video-review/file', 'POST')).toBe(true)
    for (const p of ['/api/video-review/videos', '/api/video-review/ticket', '/api/video-review/review', '/api/video-review/send', '/api/video-review/config']) {
      expect(requiresAuth(p, 'GET')).toBe(true)
    }
  })
  it('origin: a foreign-origin write is blocked, the same origin (the Bridge forward) passes', () => {
    expect(isBlockedCrossOriginWrite('PUT', 'http://evil.example', '127.0.0.1:51592', undefined, new Set())).toBe(true)
    expect(isBlockedCrossOriginWrite('POST', 'http://evil.example', '127.0.0.1:51592', undefined, new Set())).toBe(true)
    expect(isBlockedCrossOriginWrite('PUT', 'http://127.0.0.1:51592', '127.0.0.1:51592', undefined, new Set())).toBe(false)
  })
})

describe('FileTickets and parseRange', () => {
  it('a ticket resolves to its file until it expires, and is bounded', () => {
    const t = new core.FileTickets(1000, 2)
    const a = t.mint('/x/a.mp4', 0)
    expect(t.resolve(a, 500)).toBe('/x/a.mp4')
    expect(t.resolve(a, 1000)).toBeNull()
    const b = t.mint('/x/b', 0); t.mint('/x/c', 0); t.mint('/x/d', 0)
    expect(t.resolve(b, 1)).toBeNull()
  })
  it('parseRange', () => {
    expect(core.parseRange(undefined, 100)).toBeNull()
    expect(core.parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(core.parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(core.parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(core.parseRange('bytes=0-500', 100)).toEqual({ start: 0, end: 99 })
    expect(core.parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(core.parseRange('bytes=5-1', 100)).toBe('unsatisfiable')
    expect(core.parseRange('bytes=0-1,5-9', 100)).toBeNull()
  })
})
