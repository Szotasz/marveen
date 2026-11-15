// EMAILMAX3-1115: the email_send ceiling is 3 (owner decision 2026-11-15). The seed ships 3; an existing
// install moves from the factory 2 to 3 on its next update.sh run, and only from the factory 2: a ceiling
// the owner narrowed stays, and the level is never touched. The merge is idempotent. Raising the level
// itself stays the owner's step (an owner session on the dashboard; the token gets 403), see the end.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const SEED_PATH = join(ROOT, 'seed-config', 'autonomy-config.json')
const SCRIPT = join(ROOT, 'scripts', 'lib', 'autonomy-config-merge.mjs')
const SEED = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as { categories: Array<Record<string, unknown>> }
const { mergeAutonomyConfig, MAX_LEVEL_RAISES } = (await import(pathToFileURL(SCRIPT).href)) as {
  mergeAutonomyConfig: (seed: unknown, live: unknown) => { config: { categories: Array<Record<string, unknown>> }; added: number; raised: string[] }
  MAX_LEVEL_RAISES: ReadonlyArray<{ key: string; from: number; to: number }>
}

type Cat = Record<string, unknown>
const emailOf = (cfg: { categories: Cat[] }) => cfg.categories.find((c) => c.key === 'email_send')!
/** An install as v1.49.x left it: the seed with email_send at the factory ceiling 2, or a given category. */
function liveWith(email: Partial<Cat>): { version: number; updated_at: number; categories: Cat[] } {
  const cats = SEED.categories.map((c) => (c.key === 'email_send' ? { ...c, maxLevel: 2, ...email } : { ...c }))
  return { version: 1, updated_at: 0, categories: cats }
}

describe('the seed', () => {
  it('ships email_send with ceiling 3 and starting level 1, not locked', () => {
    const e = SEED.categories.find((c) => c.key === 'email_send')!
    expect(e.maxLevel).toBe(3)
    expect(e.level).toBe(1)
    expect(e.locked).toBe(false)
  })

  it('the one raise the merge knows is email_send 2 -> 3', () => {
    expect(MAX_LEVEL_RAISES).toEqual([{ key: 'email_send', from: 2, to: 3 }])
  })
})

describe('mergeAutonomyConfig', () => {
  it('an install at the factory 2 moves to 3; its level stays what it was', () => {
    for (const level of [1, 2]) {
      const r = mergeAutonomyConfig(SEED, liveWith({ level }))
      expect(r.raised).toEqual(['email_send'])
      expect(emailOf(r.config).maxLevel).toBe(3)
      expect(emailOf(r.config).level).toBe(level)
    }
  })

  it('a ceiling the owner narrowed to 1 stays 1', () => {
    const r = mergeAutonomyConfig(SEED, liveWith({ maxLevel: 1, level: 1 }))
    expect(r.raised).toEqual([])
    expect(emailOf(r.config).maxLevel).toBe(1)
  })

  it('an install already at 3 stays 3, and reports nothing', () => {
    const r = mergeAutonomyConfig(SEED, liveWith({ maxLevel: 3 }))
    expect(r.raised).toEqual([])
    expect(r.added).toBe(0)
    expect(emailOf(r.config).maxLevel).toBe(3)
  })

  it('a value that is not the number 2 is not the factory value: "2", null and a missing key stay', () => {
    for (const maxLevel of ['2', null, undefined]) {
      const r = mergeAutonomyConfig(SEED, liveWith({ maxLevel }))
      expect(r.raised, String(maxLevel)).toEqual([])
      expect(emailOf(r.config).maxLevel).toBe(maxLevel)
    }
  })

  it('a locked email_send is not raised', () => {
    const r = mergeAutonomyConfig(SEED, liveWith({ locked: true }))
    expect(r.raised).toEqual([])
    expect(emailOf(r.config).maxLevel).toBe(2)
  })

  it('the raise rides the seed: a seed that still ships 2 raises nothing', () => {
    const oldSeed = { ...SEED, categories: SEED.categories.map((c) => (c.key === 'email_send' ? { ...c, maxLevel: 2 } : c)) }
    const r = mergeAutonomyConfig(oldSeed, liveWith({}))
    expect(r.raised).toEqual([])
    expect(emailOf(r.config).maxLevel).toBe(2)
  })

  it('a category the install lacks is still added from the seed (the old merge), and nothing else changes', () => {
    const live = liveWith({ maxLevel: 3 })
    live.categories = live.categories.filter((c) => c.key !== 'deploy_retry')
    const r = mergeAutonomyConfig(SEED, live)
    expect(r.added).toBe(1)
    expect(r.config.categories.find((c) => c.key === 'deploy_retry')).toEqual(SEED.categories.find((c) => c.key === 'deploy_retry'))
  })

  it('an email_send the install lacks comes from the seed, at 3 (added, not raised)', () => {
    const live = liveWith({})
    live.categories = live.categories.filter((c) => c.key !== 'email_send')
    const r = mergeAutonomyConfig(SEED, live)
    expect(r.added).toBe(1)
    expect(r.raised).toEqual([])
    expect(emailOf(r.config).maxLevel).toBe(3)
    expect(emailOf(r.config).level).toBe(1)
  })
})

describe('the command line update.sh runs', () => {
  let dir = ''
  let target = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'emailmax3-')); target = join(dir, 'autonomy-config.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const run = () => spawnSync(process.execPath, [SCRIPT, SEED_PATH, target], { encoding: 'utf8', timeout: 10_000 })

  it('raises 2 -> 3 once, keeps the file mode, and a second run writes nothing (idempotent)', () => {
    writeFileSync(target, JSON.stringify(liveWith({ level: 2 }), null, 2) + '\n')
    chmodSync(target, 0o640)
    const first = run()
    expect(first.status).toBe(0)
    expect(first.stdout).toBe('added=0 raised=email_send\n')
    const after = JSON.parse(readFileSync(target, 'utf8'))
    expect(emailOf(after).maxLevel).toBe(3)
    expect(emailOf(after).level).toBe(2)
    expect(statSync(target).mode & 0o777).toBe(0o640)
    const bytes = readFileSync(target)
    const mtime = statSync(target).mtimeMs
    const second = run()
    expect(second.stdout).toBe('added=0 raised=-\n')
    expect(readFileSync(target).equals(bytes)).toBe(true)
    expect(statSync(target).mtimeMs).toBe(mtime)
  })

  it('a narrowed ceiling is left byte for byte as it was', () => {
    const text = JSON.stringify(liveWith({ maxLevel: 1 }))
    writeFileSync(target, text)
    expect(run().stdout).toBe('added=0 raised=-\n')
    expect(readFileSync(target, 'utf8')).toBe(text)
  })

  it('runs when started through a path with a link in it (an install root reached through a symlink)', () => {
    const linkDir = join(dir, 'linked-root')
    symlinkSync(ROOT, linkDir)
    writeFileSync(target, JSON.stringify(liveWith({})))
    const r = spawnSync(process.execPath, [join(linkDir, 'scripts', 'lib', 'autonomy-config-merge.mjs'), SEED_PATH, target], { encoding: 'utf8', timeout: 10_000 })
    expect(r.stdout).toBe('added=0 raised=email_send\n')
    expect(emailOf(JSON.parse(readFileSync(target, 'utf8'))).maxLevel).toBe(3)
  })

  it('a config that does not parse is left alone: exit 1, nothing written', () => {
    writeFileSync(target, '{ not json')
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(readFileSync(target, 'utf8')).toBe('{ not json')
  })
})

describe('update.sh', () => {
  const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf8')
  it('runs the merge ABOVE the up-to-date exit, and at the seed-config place through the same function', () => {
    const def = UPDATE.indexOf('autonomy_config_merge() {')
    const firstCall = UPDATE.indexOf('\nautonomy_config_merge\n')
    const upToDateExit = UPDATE.indexOf('Már a legfrissebb verzión vagy')
    expect(def).toBeGreaterThan(-1)
    expect(firstCall).toBeGreaterThan(def)
    expect(upToDateExit).toBeGreaterThan(firstCall)
    const seedBlock = UPDATE.slice(UPDATE.indexOf('SEED_CONFIG_DIR="$INSTALL_DIR/seed-config"'))
    expect(seedBlock.slice(0, 1500)).toContain('autonomy_config_merge')
    expect(UPDATE).toContain('node "$INSTALL_DIR/scripts/lib/autonomy-config-merge.mjs" "$seed" "$target"')
  })

  it('the old inline merge is gone (one merge, one place to change)', () => {
    expect(UPDATE).not.toContain("const existing = new Set(live.categories.map(c => c.key));")
  })
})

describe('the dashboard start (src/web/autonomy-config-boot.ts)', () => {
  let store = ''
  beforeEach(() => { store = mkdtempSync(join(tmpdir(), 'emailmax3-boot-')) })
  afterEach(() => rmSync(store, { recursive: true, force: true }))
  const boot = async () => (await import('../web/autonomy-config-boot.js')).mergeAutonomyConfigAtBoot({ root: ROOT, store })

  it('raises the factory 2 to 3 on the first start, writes nothing on the next (the same script update.sh runs)', async () => {
    writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify(liveWith({ level: 1 })))
    const first = await boot()
    expect(first).toMatchObject({ added: 0, raised: ['email_send'], wrote: true, line: 'added=0 raised=email_send' })
    const after = JSON.parse(readFileSync(join(store, 'autonomy-config.json'), 'utf8'))
    expect([emailOf(after).level, emailOf(after).maxLevel]).toEqual([1, 3])
    const bytes = readFileSync(join(store, 'autonomy-config.json'))
    expect(await boot()).toMatchObject({ wrote: false, line: 'added=0 raised=-' })
    expect(readFileSync(join(store, 'autonomy-config.json')).equals(bytes)).toBe(true)
  })

  it('a narrowed ceiling stays, and no config yet means nothing to do (the installer seeds it)', async () => {
    expect(await boot()).toBeNull()
    writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify(liveWith({ maxLevel: 1 })))
    expect(await boot()).toMatchObject({ wrote: false, raised: [] })
  })

  it('leaves no temp file behind, and its temp name is one the store watcher counts as a system file', async () => {
    writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify(liveWith({})))
    await boot()
    expect(readdirSync(store)).toEqual(['autonomy-config.json'])
    expect(readFileSync(SCRIPT, 'utf8')).toMatch(/\.tmp`/)
  })

  it("the temp file is created exclusively (flag 'wx') under a random name: a link planted at that name is an error, not a path", () => {
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src).toMatch(/writeFileSync\(tmp, [^\n]*flag: 'wx'/)
    expect(src).toMatch(/randomBytes\(4\)\.toString\('hex'\)/)
    // What 'wx' does with a link already at the name: EEXIST, and the link's target is not written.
    const victim = join(store, 'victim.txt')
    writeFileSync(victim, 'untouched')
    const planted = join(store, 'planted.tmp')
    symlinkSync(victim, planted)
    expect(() => writeFileSync(planted, 'x', { flag: 'wx' })).toThrow(/EEXIST/)
    expect(readFileSync(victim, 'utf8')).toBe('untouched')
  })

  it('index.ts runs it at start, before the web server, and a failure only logs', () => {
    const idx = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
    const at = idx.indexOf('await mergeAutonomyConfigAtBoot()')
    expect(at).toBeGreaterThan(idx.indexOf('initDatabase()'))
    expect(at).toBeLessThan(idx.indexOf('startWebServer(WEB_PORT)'))
    expect(idx.slice(at - 200, at + 400)).toMatch(/try \{[\s\S]*catch \(err\) \{\s*logger\.warn/)
  })
})
