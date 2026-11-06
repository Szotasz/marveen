// GET /api/cli-inventory.
//
// Contracts (the structure mirrors opensource-inventory-route.test.ts):
//  1. AUTH -- the route is behind the /api/* bearer gate: without a token the
//     dispatcher in web.ts answers 401 before any handler runs. Pinned as the
//     gate predicate + resolution (the same functions web.ts calls) plus the
//     dispatch order in web.ts (the handler is only reachable after the gate).
//  2. CACHE -- the handler serves store/cli-inventory.json, regenerating it via
//     the real generator when missing, older than an hour, or on ?refresh=1; a
//     failed regeneration serves the previous file VISIBLY (regen_error), and
//     with no file at all it is a 500, never an empty inventory.
//  3. SETTING -- the CLI_INVENTORY_DIRS product setting (read through
//     settings-store, like every Settings-page key) reaches the generator as
//     --dir; an invalid stored value is reported, never ignored.
//  4. SKILLS -- the global skills folder reaches the generator as --skills-dir.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase } from '../db.js'
import { getSettingDefinition, validateSettingValue, parseCliInventoryDirs } from '../config-registry.js'

const setting = vi.hoisted(() => ({ dirs: undefined as string | undefined }))
vi.mock('../settings-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../settings-store.js')>()
  return {
    ...orig,
    getEffectiveSettingValue: (key: string) => {
      if (key === 'CLI_INVENTORY_DIRS' && setting.dirs !== undefined) return setting.dirs
      return orig.getEffectiveSettingValue(key)
    },
  }
})
import { resolveAuth, requiresAuth } from '../web/auth-gate.js'
import {
  tryHandleCliInventory,
  _setCliInventoryPathsForTest,
  INVENTORY_MAX_AGE_MS,
  cliDirArgs,
} from '../web/routes/cli-inventory.js'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'cli-inventory.py')
const PATH = '/api/cli-inventory'
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

  it('no Authorization header, a wrong bearer, or the token smuggled as ?token= -> none', () => {
    expect(resolveAuth(mkReq(), mkUrl(), PATH, 'GET', TOKEN)).toEqual({ kind: 'none' })
    expect(resolveAuth(mkReq({ authorization: 'Bearer nope' }), mkUrl(), PATH, 'GET', TOKEN)).toEqual({ kind: 'none' })
    expect(resolveAuth(mkReq(), mkUrl(`?token=${TOKEN}`), PATH, 'GET', TOKEN)).toEqual({ kind: 'none' })
  })

  it('the valid bearer is accepted', () => {
    expect(resolveAuth(mkReq({ authorization: `Bearer ${TOKEN}` }), mkUrl(), PATH, 'GET', TOKEN)).toEqual({ kind: 'token' })
  })

  it('web.ts dispatches the handler only after the 401 gate', () => {
    const src = readFileSync(join(ROOT, 'src', 'web.ts'), 'utf-8')
    const gate = src.indexOf('await gateRequest(req, res, url, path, method')
    const call = src.indexOf('await tryHandleCliInventory(routeCtx)')
    expect(gate).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(gate)
  })
})

describe('CLI_INVENTORY_DIRS setting (registry)', () => {
  it('is a registered string setting with the Printing Press default and a validator', () => {
    const def = getSettingDefinition('CLI_INVENTORY_DIRS')!
    expect(def).toMatchObject({ type: 'string', default: '~/printing-press/library', secret: false, requiresRestart: false })
    expect(validateSettingValue(def, '~/printing-press/library, /opt/clis').ok).toBe(true)
    expect(validateSettingValue(def, '').ok).toBe(true)
    for (const bad of ['relative/dir', '~/a/../b', '/a b', '/x;rm', '-x', '~user/x', `/${'x'.repeat(600)}`,
      Array.from({ length: 17 }, (_, i) => `/d${i}`).join(',')]) {
      expect(validateSettingValue(def, bad).ok, bad).toBe(false)
    }
    expect(parseCliInventoryDirs(' /a , /a ,~/b')).toEqual(['/a', '~/b'])
    expect(parseCliInventoryDirs('')).toEqual(['~/printing-press/library'])
  })
})

describe('GET /api/cli-inventory (handler, fixture tree)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cli-inventory-'))
  const lib = join(tmp, 'library')
  const lib2 = join(tmp, 'library2')
  const agentsDir = join(tmp, 'agents')
  const skillsDir = join(tmp, 'global-skills')
  const out = join(tmp, 'store', 'cli-inventory.json')

  function tool(root: string, name: string): void {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ display_name: name.toUpperCase(), version: '1.0.0' }))
    const bin = join(dir, `${name}-pp-cli`)
    writeFileSync(bin, [
      // The generator runs it with PATH=/usr/local/bin:/usr/bin:/bin only.
      '#!/usr/bin/env python3',
      'import json, sys',
      'if sys.argv[1:] == ["agent-context"]:',
      `    print(json.dumps({"cli": {"name": "${name}-pp-cli"}, "commands": [{"name": "list", "short": "List"}]}))`,
      'else:',
      '    sys.exit(2)',
    ].join('\n'))
    chmodSync(bin, 0o755)
  }

  beforeAll(() => {
    tool(lib, 'acme')
    tool(lib2, 'zeta')
    mkdirSync(join(skillsDir, 'acme-use'), { recursive: true })
    writeFileSync(join(skillsDir, 'acme-use', 'SKILL.md'), '---\nname: acme-use\n---\nRun acme-pp-cli list\n')
    mkdirSync(agentsDir, { recursive: true })
  })
  beforeEach(() => {
    setting.dirs = lib
    _setCliInventoryPathsForTest({ script: SCRIPT, agentsDir, skillsDir, out })
  })
  afterAll(() => {
    setting.dirs = undefined
    _setCliInventoryPathsForTest(null)
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
    const handled = await tryHandleCliInventory({
      req: {} as http.IncomingMessage, res, path: PATH, method,
      url: new URL(`http://localhost${PATH}${query}`),
    })
    return { handled, status, body: body ? JSON.parse(body) : null }
  }

  it('ignores other methods and other paths', async () => {
    expect((await get('', 'POST')).handled).toBe(false)
  })

  it('generates the file on first call and returns the inventory', async () => {
    expect(existsSync(out)).toBe(false)
    const r = await get()
    expect(r.status).toBe(200)
    expect(existsSync(out)).toBe(true)
    expect(r.body.cache).toMatchObject({ regenerated: true, regen_error: null })
    expect(r.body.summary.total).toBe(1)
    expect(r.body.tools[0]).toMatchObject({
      name: 'acme-pp-cli', display_name: 'ACME', version: '1.0.0',
      probe: { status: 'ok', command_source: 'agent-context' },
      commands: [{ name: 'list', description: 'List' }],
    })
  })

  it('the global skills folder reaches the generator (--skills-dir)', async () => {
    const r = await get()
    expect(r.body.tools[0].skills).toEqual([{ scope: 'global', agent: null, skill: 'acme-use' }])
  })

  it('serves the cached file while it is younger than an hour', async () => {
    const r = await get()
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
    expect((await get('?refresh=1')).body.cache.regenerated).toBe(true)
  })

  it('the configured folders reach the generator (--dir), each one', async () => {
    setting.dirs = `${lib}, ${lib2}`
    expect(cliDirArgs()).toEqual(['--dir', lib, '--dir', lib2])
    const r = await get('?refresh=1')
    expect(r.body.cache.regen_error).toBeNull()
    expect(r.body.tools.map((t: any) => t.name)).toEqual(['acme-pp-cli', 'zeta-pp-cli'])
    expect(r.body.summary.dirs).toEqual([
      { dir: lib, found: true, tools: 1 },
      { dir: lib2, found: true, tools: 1 },
    ])
  })

  it('an empty setting means the default folder', () => {
    setting.dirs = ''
    expect(cliDirArgs()).toEqual(['--dir', '~/printing-press/library'])
  })

  it('an invalid stored setting is a visible regen_error, not a silent default', async () => {
    setting.dirs = '../etc'
    const r = await get('?refresh=1')
    expect(r.status).toBe(200)
    expect(r.body.cache.regenerated).toBe(false)
    // the error names the setting and does not echo the stored value
    expect(r.body.cache.regen_error).toBe('invalid CLI_INVENTORY_DIRS value')
  })

  it('a failing generator serves the previous file, visibly', async () => {
    _setCliInventoryPathsForTest({ script: join(tmp, 'nincs-ilyen.py'), agentsDir, skillsDir, out })
    const r = await get('?refresh=1')
    expect(r.status).toBe(200)
    expect(r.body.cache.regenerated).toBe(false)
    expect(r.body.cache.regen_error).toBeTruthy()
    expect(r.body.summary.total).toBeGreaterThan(0)
  })

  it('concurrent regenerations share one generator run (in-flight coalescing)', async () => {
    const stub = join(tmp, 'stub-generator.py')
    const runs = join(tmp, 'stub-runs.txt')
    writeFileSync(stub, [
      'import sys, time, json',
      'a = sys.argv',
      'out = a[a.index("--out") + 1]',
      `open(${JSON.stringify(runs)}, "a").write("run\\n")`,
      'time.sleep(0.5)',
      'json.dump({"summary": {"total": 0}, "tools": []}, open(out, "w"))',
    ].join('\n'))
    mkdirSync(join(tmp, 'store3'), { recursive: true })
    _setCliInventoryPathsForTest({ script: stub, agentsDir, skillsDir, out: join(tmp, 'store3', 'inv.json') })
    const [a, b] = await Promise.all([get('?refresh=1'), get('?refresh=1')])
    expect([a.status, b.status]).toEqual([200, 200])
    expect([a.body.cache.regenerated, b.body.cache.regenerated]).toEqual([true, true])
    expect(readFileSync(runs, 'utf-8').trim().split('\n')).toHaveLength(1)
    await get('?refresh=1')
    expect(readFileSync(runs, 'utf-8').trim().split('\n')).toHaveLength(2)
  })

  it('no file and a failing generator is a 500, not an empty inventory', async () => {
    _setCliInventoryPathsForTest({ script: join(tmp, 'nincs-ilyen.py'), agentsDir, skillsDir, out: join(tmp, 'store2', 'x.json') })
    const r = await get()
    expect(r.status).toBe(500)
    expect(r.body.tools).toBeUndefined()
    expect(r.body.error).toBe('inventory unavailable')
  })
})
