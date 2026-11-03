// Character nicknames (store/team-nicknames.json) and the owner portrait route.
// Both read from PROJECT_ROOT/store, so PROJECT_ROOT points at a temp dir.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const tmpRoot = mkdtempSync(join(tmpdir(), 'team-nicknames-'))
const STORE = join(tmpRoot, 'store')
mkdirSync(STORE, { recursive: true })

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: tmpRoot,
}))

const { nicknameFor } = await import('../web/team-nicknames.js')
const { tryHandleMarveen } = await import('../web/routes/marveen.js')

const FILE = join(STORE, 'team-nicknames.json')
let tick = 1_700_000_000
function writeNicknames(body: string) {
  writeFileSync(FILE, body)
  // The module caches by mtime; move it forward explicitly so two writes inside
  // the same filesystem timestamp tick still count as a change.
  tick += 10
  utimesSync(FILE, tick, tick)
}

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

describe('nicknameFor', () => {
  beforeEach(() => rmSync(FILE, { force: true }))

  it('a missing file means no nicknames, not an error', () => {
    expect(nicknameFor('alice')).toBeUndefined()
  })

  it('reads the documented { nicknames: {...} } form, case-insensitively, trimmed', () => {
    writeNicknames(JSON.stringify({ _doc: 'x', nicknames: { ' Alice ': ' Gate Warden ', researcher: 'Lore Seeker' } }))
    expect(nicknameFor('alice')).toBe('Gate Warden')
    expect(nicknameFor('ALICE ')).toBe('Gate Warden')
    expect(nicknameFor('Researcher')).toBe('Lore Seeker')
    expect(nicknameFor('nobody')).toBeUndefined()
    expect(nicknameFor('')).toBeUndefined()
  })

  it('accepts the flat form too, and skips non-string and blank entries', () => {
    writeNicknames(JSON.stringify({ dev: 'Codesmith', n: 42, blank: '   ', '': 'x' }))
    expect(nicknameFor('dev')).toBe('Codesmith')
    expect(nicknameFor('n')).toBeUndefined()
    expect(nicknameFor('blank')).toBeUndefined()
  })

  it('picks up an edited file without a restart', () => {
    writeNicknames(JSON.stringify({ dev: 'Codesmith' }))
    expect(nicknameFor('dev')).toBe('Codesmith')
    writeNicknames(JSON.stringify({ dev: 'Bug Hunter' }))
    expect(nicknameFor('dev')).toBe('Bug Hunter')
  })

  it('a malformed file degrades to no nicknames instead of throwing', () => {
    writeNicknames('{ not json')
    expect(() => nicknameFor('dev')).not.toThrow()
    expect(nicknameFor('dev')).toBeUndefined()
  })
})

describe('GET /api/marveen/owner-avatar', () => {
  async function get(path: string): Promise<{ status: number; type: string | null; cache: string | null; body: Buffer }> {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      const handled = await tryHandleMarveen({ req, res, path: url.pathname, method: req.method || 'GET', url } as never, tmpRoot)
      if (!handled) { res.writeHead(599); res.end() }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const { port } = server.address() as AddressInfo
      const r = await fetch(`http://127.0.0.1:${port}${path}`)
      return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), body: Buffer.from(await r.arrayBuffer()) }
    } finally {
      server.close()
    }
  }

  beforeEach(() => {
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) rmSync(join(STORE, `owner-avatar${ext}`), { force: true })
  })

  it('404s when no portrait is on disk (the board keeps the initial)', async () => {
    const r = await get('/api/marveen/owner-avatar')
    expect(r.status).toBe(404)
  })

  it('serves store/owner-avatar.* with revalidation, not a max-age', async () => {
    writeFileSync(join(STORE, 'owner-avatar.webp'), Buffer.from('RIFF0000WEBPfake'))
    const r = await get('/api/marveen/owner-avatar')
    expect(r.status).toBe(200)
    expect(r.body.toString()).toBe('RIFF0000WEBPfake')
    expect(r.cache).toBe('no-cache')
  })

  it('prefers .png when several formats exist', async () => {
    writeFileSync(join(STORE, 'owner-avatar.jpg'), 'jpg')
    writeFileSync(join(STORE, 'owner-avatar.png'), 'png')
    expect((await get('/api/marveen/owner-avatar')).body.toString()).toBe('png')
  })

  it('is read-only: a POST is not handled by this route', async () => {
    writeFileSync(join(STORE, 'owner-avatar.png'), 'png')
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      const handled = await tryHandleMarveen({ req, res, path: url.pathname, method: req.method || 'GET', url } as never, tmpRoot)
      if (!handled) { res.writeHead(599); res.end() }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const { port } = server.address() as AddressInfo
      const r = await fetch(`http://127.0.0.1:${port}/api/marveen/owner-avatar`, { method: 'POST', body: 'x' })
      expect(r.status).toBe(599)
    } finally {
      server.close()
    }
  })
})
