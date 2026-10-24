// GET /api/opensource-inventory.
//
// Two contracts:
//  1. AUTH -- the route is behind the /api/* bearer gate: without a token the
//     dispatcher in web.ts answers 401 before any handler runs. Pinned as the
//     gate predicate + resolution (the same functions web.ts calls) plus the
//     dispatch order in web.ts (the handler is only reachable after the gate).
//  2. CACHE -- the handler serves store/opensource-inventory.json, regenerating
//     it via the real generator when missing, older than an hour, or on
//     ?refresh=1; a failed regeneration serves the previous file VISIBLY
//     (regen_error), and with no file at all it is a 500, never an empty
//     inventory (an empty list would repeat the misleading "0").
//  3. SETTING -- the OSS_INVENTORY_NOTES_DIRS product setting (read through
//     settings-store, like every Settings-page key) reaches the generator as
//     --notes-dir; an invalid stored value is reported, never ignored.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase } from '../db.js'
import { getSettingDefinition, validateSettingValue, parseOssNotesDirs } from '../config-registry.js'

// The product reads settings through settings-store (overrides file, .env,
// registry default). The test replaces only this key's effective value.
const setting = vi.hoisted(() => ({ notesDirs: undefined as string | undefined }))
vi.mock('../settings-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../settings-store.js')>()
  return {
    ...orig,
    getEffectiveSettingValue: (key: string) =>
      key === 'OSS_INVENTORY_NOTES_DIRS' && setting.notesDirs !== undefined ? setting.notesDirs : orig.getEffectiveSettingValue(key),
  }
})
import { resolveAuth, requiresAuth } from '../web/auth-gate.js'
import {
  tryHandleOpensourceInventory,
  _setInventoryPathsForTest,
  INVENTORY_MAX_AGE_MS,
  notesDirArgs,
} from '../web/routes/opensource-inventory.js'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'opensource-inventory.py')
const PATH = '/api/opensource-inventory'
const TOKEN = 'b'.repeat(64)

describe('auth: the route is bearer-gated (401 without a token)', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
  })

  const mkReq = (headers: Record<string, string> = {}) => ({ headers }) as unknown as http.IncomingMessage
  const mkUrl = (q = '') => new URL(`http://127.0.0.1:3420${PATH}${q}`)

  it('the gate treats the path as protected', () => {
    expect(requiresAuth(PATH, 'GET')).toBe(true)
  })

  it('no Authorization header -> none (web.ts answers 401)', () => {
    expect(resolveAuth(mkReq(), mkUrl(), PATH, 'GET', TOKEN)).toEqual({ kind: 'none' })
  })

  it('a wrong bearer, or the token smuggled as ?token= -> none', () => {
    expect(resolveAuth(mkReq({ authorization: 'Bearer nope' }), mkUrl(), PATH, 'GET', TOKEN)).toEqual({ kind: 'none' })
    expect(resolveAuth(mkReq(), mkUrl(`?token=${TOKEN}`), PATH, 'GET', TOKEN)).toEqual({ kind: 'none' })
  })

  it('the valid bearer is accepted', () => {
    expect(resolveAuth(mkReq({ authorization: `Bearer ${TOKEN}` }), mkUrl(), PATH, 'GET', TOKEN)).toEqual({ kind: 'token' })
  })

  it('web.ts dispatches the handler only after the 401 gate', () => {
    const src = readFileSync(join(ROOT, 'src', 'web.ts'), 'utf-8')
    const gate = src.indexOf("res.end(JSON.stringify({ error: 'Unauthorized' }))")
    const call = src.indexOf('await tryHandleOpensourceInventory(routeCtx)')
    expect(gate).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(gate)
  })
})

describe('OSS_INVENTORY_NOTES_DIRS setting (registry)', () => {
  it('is a registered string setting with the default "research" and a validator', () => {
    const def = getSettingDefinition('OSS_INVENTORY_NOTES_DIRS')!
    expect(def).toMatchObject({ type: 'string', default: 'research', secret: false, requiresRestart: false })
    expect(validateSettingValue(def, 'research,kutatas').ok).toBe(true)
    expect(validateSettingValue(def, '').ok).toBe(true)
    for (const bad of ['..', '.', 'a/b', 'a\\b', '-x', 'x'.repeat(65)]) {
      expect(validateSettingValue(def, bad).ok, bad).toBe(false)
    }
    expect(parseOssNotesDirs(' notes , notes ,research')).toEqual(['notes', 'research'])
  })
})

describe('GET /api/opensource-inventory (handler, fixture tree)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'oss-inventory-'))
  const agentsDir = join(tmp, 'agents')
  const out = join(tmp, 'store', 'opensource-inventory.json')

  beforeAll(() => {
    const tool = join(agentsDir, 'alfa', 'tool')
    mkdirSync(join(tool, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(tool, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '1.3.0' } }))
    writeFileSync(join(tool, 'node_modules', 'left-pad', 'package.json'),
      JSON.stringify({ name: 'left-pad', version: '1.3.0', license: 'WTFPL' }))
  })
  beforeEach(() => {
    _setInventoryPathsForTest({ script: SCRIPT, agentsDir, out })
  })
  afterAll(() => {
    _setInventoryPathsForTest(null)
    rmSync(tmp, { recursive: true, force: true })
  })

  async function get(query = '', method = 'GET'): Promise<{ handled: boolean; status: number; body: any }> {
    let status = 200
    let body = ''
    const res = {
      setHeader() {},
      writeHead(s: number) { status = s },
      end(b?: string) { body = b ?? '' },
    } as unknown as http.ServerResponse
    const handled = await tryHandleOpensourceInventory({
      req: {} as http.IncomingMessage, res, path: PATH, method,
      url: new URL(`http://localhost${PATH}${query}`),
    })
    return { handled, status, body: body ? JSON.parse(body) : null }
  }

  it('ignores other methods', async () => {
    expect((await get('', 'POST')).handled).toBe(false)
  })

  it('generates the file on first call and returns the inventory', async () => {
    expect(existsSync(out)).toBe(false)
    const r = await get()
    expect(r.status).toBe(200)
    expect(existsSync(out)).toBe(true)
    expect(r.body.cache.regenerated).toBe(true)
    expect(r.body.cache.regen_error).toBeNull()
    expect(r.body.summary.total).toBe(1)
    expect(r.body.entries[0]).toMatchObject({ agent: 'alfa', name: 'left-pad', type: 'npm', version: '1.3.0', license: 'WTFPL' })
  })

  it('serves the cached file while it is younger than an hour', async () => {
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body.cache.regenerated).toBe(false)
    expect(r.body.cache.max_age_seconds).toBe(INVENTORY_MAX_AGE_MS / 1000)
  })

  it('regenerates a file older than an hour', async () => {
    const old = new Date(Date.now() - INVENTORY_MAX_AGE_MS - 60_000)
    utimesSync(out, old, old)
    const r = await get()
    expect(r.body.cache.regenerated).toBe(true)
    expect(r.body.cache.age_seconds).toBeLessThan(60)
  })

  it('?refresh=1 regenerates a fresh file', async () => {
    const r = await get('?refresh=1')
    expect(r.body.cache.regenerated).toBe(true)
  })

  it('a failing generator serves the previous file, visibly', async () => {
    _setInventoryPathsForTest({ script: join(tmp, 'nincs-ilyen.py'), agentsDir, out })
    const r = await get('?refresh=1')
    expect(r.status).toBe(200)
    expect(r.body.cache.regenerated).toBe(false)
    expect(r.body.cache.regen_error).toBeTruthy()
    expect(r.body.summary.total).toBe(1)
  })

  it('the configured notes folder reaches the generator (--notes-dir)', async () => {
    const skill = join(agentsDir, 'beta', '.claude', 'skills', 's')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: s\n---\nSource: https://github.com/acme/beta-skill\n')
    mkdirSync(join(agentsDir, 'beta', 'kutatas'), { recursive: true })
    writeFileSync(join(agentsDir, 'beta', 'kutatas', 'n.md'), '- acme/beta-skill **Stars: 77**\n')
    const starsOf = (body: any) => body.entries.find((e: any) => e.name === 'acme/beta-skill')
    try {
      setting.notesDirs = ''
      expect(notesDirArgs()).toEqual(['--notes-dir', 'research'])
      expect(starsOf((await get('?refresh=1')).body)).toMatchObject({ stars: null })
      setting.notesDirs = 'research, kutatas'
      expect(notesDirArgs()).toEqual(['--notes-dir', 'research', '--notes-dir', 'kutatas'])
      const r = await get('?refresh=1')
      expect(r.body.cache.regen_error).toBeNull()
      expect(starsOf(r.body)).toMatchObject({ stars: '77', stars_source: 'agents/beta/kutatas/n.md:1' })
    } finally {
      setting.notesDirs = undefined
      rmSync(join(agentsDir, 'beta'), { recursive: true, force: true })
    }
  })

  it('an invalid stored notes setting is a visible regen_error, not a silent default', async () => {
    try {
      setting.notesDirs = '../etc'
      const r = await get('?refresh=1')
      expect(r.status).toBe(200)
      expect(r.body.cache.regenerated).toBe(false)
      expect(r.body.cache.regen_error).toMatch(/OSS_INVENTORY_NOTES_DIRS/)
    } finally {
      setting.notesDirs = undefined
    }
  })

  it('no file and a failing generator is a 500, not an empty inventory', async () => {
    const missing = join(tmp, 'store2', 'x.json')
    _setInventoryPathsForTest({ script: join(tmp, 'nincs-ilyen.py'), agentsDir, out: missing })
    const r = await get()
    expect(r.status).toBe(500)
    expect(r.body.entries).toBeUndefined()
    expect(r.body.error).toBe('inventory unavailable')
  })
})
