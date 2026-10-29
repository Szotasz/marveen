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
import { getSettingDefinition, validateSettingValue, parseOssNotesDirs, parseOssOwnOwners } from '../config-registry.js'

// The product reads settings through settings-store (overrides file, .env,
// registry default). The test replaces only this key's effective value.
const setting = vi.hoisted(() => ({ notesDirs: undefined as string | undefined, ownOwners: undefined as string | undefined }))
vi.mock('../settings-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../settings-store.js')>()
  return {
    ...orig,
    getEffectiveSettingValue: (key: string) => {
      if (key === 'OSS_INVENTORY_NOTES_DIRS' && setting.notesDirs !== undefined) return setting.notesDirs
      if (key === 'OSS_INVENTORY_OWN_OWNERS' && setting.ownOwners !== undefined) return setting.ownOwners
      return orig.getEffectiveSettingValue(key)
    },
  }
})
import { resolveAuth, requiresAuth } from '../web/auth-gate.js'
import {
  tryHandleOpensourceInventory,
  _setInventoryPathsForTest,
  INVENTORY_MAX_AGE_MS,
  notesDirArgs,
  ownOwnerArgs,
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
    // The 401 answer lives in gateRequest (auth-gate.ts) since per-agent tokens; web.ts calls it first.
    const src = readFileSync(join(ROOT, 'src', 'web.ts'), 'utf-8')
    const gate = src.indexOf('await gateRequest(req, res, url, path, method')
    const call = src.indexOf('await tryHandleOpensourceInventory(routeCtx)')
    expect(gate).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(gate)
    const gateSrc = readFileSync(join(ROOT, 'src', 'web', 'auth-gate.ts'), 'utf-8')
    expect(gateSrc).toContain("res.end(JSON.stringify({ error: 'Unauthorized' }))")
  })
})

// Invariant (pinned in scripts/__tests__/opensource-inventory.test.py): the
// setting is the only owner-based reason a clone is not listed (the clone's
// own origin owner name is in OSS_INVENTORY_OWN_OWNERS); the other reason is
// that the clone has no readable http(s) or ssh origin. Ownership is not
// inferred from the installation's remotes. The page and the docs say that
// and nothing stronger.
// (The page is checked at source level: renderOssInventory needs the DOM.)
describe('page text and docs: the setting is the only owner-based reason a clone is not listed', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')
  const KEYS = ['oss.clones_owner_in_setting', 'oss.clones_no_http_ssh_origin', 'oss.own_owners_hint']
  const GONE = ['oss.own_clones', 'oss.own_clones_owner', 'oss.own_clones_no_remote', 'oss.own_owners_unknown',
    'oss.own_owners_setting_only', 'oss.clones_no_network_origin']

  it('both locales carry the three keys with exactly what the code checks, and none of the old ones', () => {
    for (const file of ['web/lang/en.js', 'web/lang/hu.js']) {
      const src = read(file)
      for (const k of KEYS) expect(src, `${file}: ${k}`).toContain(`'${k}':`)
      for (const k of GONE) expect(src, `${file}: ${k}`).not.toContain(`'${k}':`)
    }
    const en = read('web/lang/en.js')
    const hu = read('web/lang/hu.js')
    expect(en).toContain("'{n} clone(s) whose origin owner name is in OSS_INVENTORY_OWN_OWNERS (matched by name on any host): not listed'")
    expect(hu).toContain("'{n} klón, amelynek origin-tulajdonosneve szerepel az OSS_INVENTORY_OWN_OWNERS beállításban (név szerint, bármelyik hoszton): nincs a listán'")
    expect(en).toContain("'{n} clone(s) without a readable http(s) or ssh origin: not listed'")
    expect(hu).toContain("'{n} klón olvasható http(s)- vagy ssh-origin nélkül: nincs a listán'")
    expect(en).toContain("'Your own repositories that the scan reaches with a readable http(s) or ssh origin are listed here unless you name your account(s) in OSS_INVENTORY_OWN_OWNERS.'")
    expect(hu).toContain("'A saját repóid, amelyeket a bejárás olvasható http(s)- vagy ssh-originnel ér el, itt szerepelnek, hacsak meg nem adod a fiókod nevét (vagy neveit) az OSS_INVENTORY_OWN_OWNERS beállításban.'")
  })

  it('the docs state the scan scope once each and the shared listing sentence', () => {
    const SCOPE_EN = 'The scan does not look inside another clone, node_modules, caches, virtual environments, unpacked vendor packages or symlinked folders.'
    const SCOPE_HU = 'A bejárás nem néz bele másik klónba, node_modules-ba, gyorsítótárakba, virtuális környezetekbe, kicsomagolt vendor-csomagokba és szimbolikus linkkel bekötött mappákba.'
    const LIST_EN = 'Clones the scan reaches that have a readable http(s) or ssh origin are listed unless their origin owner name is in OSS_INVENTORY_OWN_OWNERS.'
    const LIST_HU = 'A bejárás által elért, olvasható http(s)- vagy ssh-originű klónok a listán vannak, hacsak az origin-tulajdonosnevük nem szerepel az OSS_INVENTORY_OWN_OWNERS beállításban.'
    const count = (s: string, sub: string) => s.split(sub).length - 1
    for (const [f, list, scope] of [['docs/en/config-reference.md', LIST_EN, SCOPE_EN], ['docs/config-reference.md', LIST_HU, SCOPE_HU],
      ['src/config-registry.ts', LIST_HU, SCOPE_HU]] as const) {
      const src = read(f)
      expect(count(src, list), `${f}: listing sentence`).toBe(1)
      expect(count(src, scope), `${f}: scope list once`).toBe(1)
    }
    const gen = read('scripts/opensource-inventory.py').replace(/\s+/g, ' ')
    expect(count(gen, 'Clones the scan reaches that have a readable http(s) or ssh origin are listed')).toBe(1)
    expect(count(gen, SCOPE_EN)).toBe(1)
  })

  it('the page uses each reason count once and shows the hint only with an empty setting and a listed clone', () => {
    const app = read('web/app.js')
    expect(app).toContain('data.summary.unlisted_clones')
    expect(app).toContain("t('oss.clones_owner_in_setting', { n: inSetting })")
    expect(app).toContain("t('oss.clones_no_http_ssh_origin', { n: noHttpSsh })")
    expect(app).toContain('num(byReason.owner_in_setting)')
    expect(app).toContain('num(byReason.no_http_ssh_origin)')
    expect(app).toContain("if (unlisted && settingEmpty && listedClones > 0) lines.push(t('oss.own_owners_hint'))")
    expect(app).not.toMatch(/own_owners_source|own_clones|no_network_origin/)
  })

  it('no file of the change claims more than the code checks (claims grep, this file included)', () => {
    // Whole files of the change, and the inventory's own part of the big
    // shared files (other features there have their own wording).
    const whole = ['.env.example', 'scripts/opensource-inventory.py', 'scripts/__tests__/opensource-inventory.test.py',
      'src/__tests__/opensource-inventory-route.test.ts', 'src/web/routes/opensource-inventory.ts']
    const between = (f: string, from: string, to: string) => {
      const s = read(f)
      const a = s.indexOf(from)
      const b = s.indexOf(to, a + 1)
      expect(a, `${f}: start marker`).toBeGreaterThanOrEqual(0)
      expect(b, `${f}: end marker`).toBeGreaterThan(a)
      return s.slice(a, b)
    }
    const lines = (f: string, re: RegExp) => read(f).split('\n').filter((l) => re.test(l)).join('\n')
    const parts: Array<[string, string]> = [
      ...whole.map((f) => [f, read(f)] as [string, string]),
      ['web/app.js', between('web/app.js', '// --- Adopted open-source inventory ---', ';(function wireGitHubRepos')],
      ['web/index.html', between('web/index.html', '<!-- Adopted open-source inventory', 'id="vaultToggle"')],
      ['web/lang/en.js', lines('web/lang/en.js', /^\s*'oss\./)],
      ['web/lang/hu.js', lines('web/lang/hu.js', /^\s*'oss\./)],
      ['docs/config-reference.md', lines('docs/config-reference.md', /OSS_INVENTORY/)],
      ['docs/en/config-reference.md', lines('docs/en/config-reference.md', /OSS_INVENTORY/)],
      ['src/config-registry.ts', between('src/config-registry.ts', '// OSS_INVENTORY_NOTES_DIRS', 'function validFusionWeight')
        + between('src/config-registry.ts', "key: 'OSS_INVENTORY_NOTES_DIRS'", "key: 'OLLAMA_URL'")],
    ]
    // Built from parts so that this file can scan itself.
    const phrase = (...w: string[]) => new RegExp(w.join(' '), 'i')
    const banned = [
      phrase('network', 'origin'), phrase('no', 'git', 'remote', 'is', 'read'), phrase('only', 'source'),
      phrase('installation(\\\\?\')?s', 'accounts?'), phrase('installation', '(own', ')?accounts?'),
      phrase('remotes', 'are', 'always'), phrase('always', '(included|own)'), phrase('hálózati', 'origin'),
      phrase('telepítés', '(egyik|saját)', 'fiók'), phrase('mindig', 'sajátnak'), phrase('remote-jainak', 'tulajdonosai'),
      phrase('every', 'clone'), phrase('no', 'remote', 'of', 'the', 'installation'), phrase('is', 'never'),
      phrase('minden', '(http|hálózati|klón)'),
    ]
    for (const [f, src] of parts) {
      expect(src.length, `${f}: scanned text`).toBeGreaterThan(0)
      for (const re of banned) expect(src, `${f}: ${re}`).not.toMatch(re)
    }
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

  it('OSS_INVENTORY_OWN_OWNERS is a registered string setting, empty by default, validated', () => {
    const def = getSettingDefinition('OSS_INVENTORY_OWN_OWNERS')!
    expect(def).toMatchObject({ type: 'string', default: '', secret: false, requiresRestart: false })
    expect(validateSettingValue(def, 'me,My-Org').ok).toBe(true)
    expect(validateSettingValue(def, '').ok).toBe(true)
    for (const bad of ['a/b', '-x', 'a b', '..x/y', 'x'.repeat(101)]) {
      expect(validateSettingValue(def, bad).ok, bad).toBe(false)
    }
    expect(parseOssOwnOwners(' Me , me ,My-Org')).toEqual(['me', 'my-org'])
    expect(parseOssOwnOwners('')).toEqual([])
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
      expect(r.body.cache.regen_error).toBe('invalid OSS_INVENTORY_NOTES_DIRS value')
    } finally {
      setting.notesDirs = undefined
    }
  })

  it('the owners setting reaches the generator (--own-owner): a named owner\'s clone is counted, not listed', async () => {
    const repo = join(agentsDir, 'gamma', 'work', 'own-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/My-Org/own-repo.git\n')
    writeFileSync(join(repo, '.git', 'HEAD'), 'a'.repeat(40) + '\n')
    const ownRow = (body: any) => body.entries.find((e: any) => e.type === 'vendor')
    try {
      setting.ownOwners = ''
      expect(ownOwnerArgs()).toEqual([])
      const before = (await get('?refresh=1')).body
      expect(ownRow(before)).toMatchObject({ name: 'My-Org/own-repo' })
      expect(before.summary.unlisted_clones).toMatchObject({ total: 0, owners_in_setting: 0, listed_network_clones: 1 })
      setting.ownOwners = 'my-org'
      expect(ownOwnerArgs()).toEqual(['--own-owner', 'my-org'])
      const after = (await get('?refresh=1')).body
      expect(after.cache.regen_error).toBeNull()
      expect(ownRow(after)).toBeUndefined()
      expect(after.summary.unlisted_clones).toMatchObject({
        total: 1, by_reason: { owner_in_setting: 1 }, by_agent: { gamma: 1 }, owners_in_setting: 1, listed_network_clones: 0,
      })
      setting.ownOwners = 'a/b'
      const bad = (await get('?refresh=1')).body
      // the error names the setting and does not echo the stored value
      expect(bad.cache.regen_error).toBe('invalid OSS_INVENTORY_OWN_OWNERS value')
    } finally {
      setting.ownOwners = undefined
      rmSync(join(agentsDir, 'gamma'), { recursive: true, force: true })
    }
  })

  it('concurrent regenerations share one generator run (in-flight coalescing)', async () => {
    // A stub generator that counts its runs and is slow enough for both
    // requests to arrive while the first run is still going.
    const stub = join(tmp, 'stub-generator.py')
    const runs = join(tmp, 'stub-runs.txt')
    writeFileSync(stub, [
      'import sys, time, json',
      'a = sys.argv',
      'out = a[a.index("--out") + 1]',
      `open(${JSON.stringify(runs)}, "a").write("run\\n")`,
      'time.sleep(0.5)',
      'json.dump({"summary": {"total": 0}, "entries": []}, open(out, "w"))',
    ].join('\n'))
    _setInventoryPathsForTest({ script: stub, agentsDir, out: join(tmp, 'store3', 'inv.json') })
    mkdirSync(join(tmp, 'store3'), { recursive: true })
    const [a, b] = await Promise.all([get('?refresh=1'), get('?refresh=1')])
    expect([a.status, b.status]).toEqual([200, 200])
    expect([a.body.cache.regenerated, b.body.cache.regenerated]).toEqual([true, true])
    expect(readFileSync(runs, 'utf-8').trim().split('\n')).toHaveLength(1)
    // Once settled, the next refresh runs the generator again.
    await get('?refresh=1')
    expect(readFileSync(runs, 'utf-8').trim().split('\n')).toHaveLength(2)
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
