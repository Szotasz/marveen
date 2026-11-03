import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// `recipient-ledger.mjs add` on a ledger that EXISTS but cannot be used (a
// truncated write, a conflicted merge, a BOM from an editor, an array-shaped
// file) rewrote it as an empty ledger plus the new entry, silently deleting
// every verified recipient. The write path now refuses with a non-zero exit,
// names the reason and leaves the file byte-identical; a fresh ledger is
// written ONLY when the file is absent.
const ROOT = join(__dirname, '..', '..')
const MODULE = join(ROOT, 'scripts', 'recipient-ledger.mjs')
const EXISTING = '{\n  "version": 1,\n  "recipients": {\n    "kept@example.com": {"source": "owner", "note": "keep"}\n  }\n}\n'

const UNUSABLE: Record<string, Buffer> = {
  'truncated JSON': Buffer.from('{"version":1,"recipients":{"kept@example.com":{"source":"owner"},'),
  'conflict-marked JSON': Buffer.from('<'.repeat(7) + ' Updated upstream\n' + EXISTING),
  'array-shaped recipients': Buffer.from('{"version":1,"recipients":["kept@example.com"]}'),
  'array at the top level': Buffer.from('[{"recipients":{"kept@example.com":{}}}]'),
  'UTF-8 BOM': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(EXISTING)]),
}

let dir = ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-write-'))
  mod = await import(pathToFileURL(MODULE).href)
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('addRecipient never overwrites a present but unusable ledger', () => {
  for (const [label, bytes] of Object.entries(UNUSABLE)) {
    it(`refuses on a ${label} ledger and leaves it byte-identical`, () => {
      const path = join(dir, `fn-${label.replace(/\W+/g, '-')}.json`)
      writeFileSync(path, bytes)
      expect(() => mod.addRecipient('new@example.com', 'owner', 'test', path)).toThrow(/refusing to overwrite/)
      expect(readFileSync(path).equals(bytes), 'the file must be byte-identical').toBe(true)
    })
  }

  it('creates the ledger when the file is absent', () => {
    const path = join(dir, 'absent', 'verified-recipients.json')
    expect(existsSync(path)).toBe(false)
    mod.addRecipient('new@example.com', 'owner', 'test', path)
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf-8')).recipients)).toEqual(['new@example.com'])
  })

  it('adds to a usable ledger and keeps the existing entries', () => {
    const path = join(dir, 'usable.json')
    writeFileSync(path, EXISTING)
    mod.addRecipient('new@example.com', 'owner', 'test', path)
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf-8')).recipients).sort()).toEqual(['kept@example.com', 'new@example.com'])
  })

  it('writes through a temp file in the same directory: no temp file is left behind, mode 0600', () => {
    const sub = mkdtempSync(join(dir, 'atomic-'))
    const path = join(sub, 'verified-recipients.json')
    writeFileSync(path, EXISTING, { mode: 0o644 })
    const before = statSync(path).ino
    mod.addRecipient('new@example.com', 'owner', 'test', path)
    // a new inode: the ledger was replaced by a rename, not rewritten in place
    expect(statSync(path).ino).not.toBe(before)
    expect(readdirSync(sub)).toEqual(['verified-recipients.json'])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf-8')).toContain('kept@example.com')
  })

  it('inspectLedger tells a missing file apart from an unusable one', () => {
    expect(mod.inspectLedger(join(dir, 'nope.json'))).toMatchObject({ ledger: null, missing: true })
    const path = join(dir, 'inspect-truncated.json')
    writeFileSync(path, UNUSABLE['truncated JSON'])
    const seen = mod.inspectLedger(path)
    expect(seen.ledger).toBe(null)
    expect(seen.missing).toBe(false)
    expect(seen.reason).toMatch(/not valid JSON/)
    // loadLedger keeps its contract: null for both
    expect(mod.loadLedger(path)).toBe(null)
    expect(mod.loadLedger(join(dir, 'nope.json'))).toBe(null)
  })
})

describe('the CLI exits non-zero and names the reason on an unusable ledger', () => {
  // The CLI resolves <its dir>/../store/verified-recipients.json, so it runs
  // from a copy in a temp project.
  function project(bytes: Buffer | null) {
    const p = mkdtempSync(join(dir, 'cli-'))
    mkdirSync(join(p, 'scripts'))
    mkdirSync(join(p, 'store'))
    copyFileSync(MODULE, join(p, 'scripts', 'recipient-ledger.mjs'))
    const ledger = join(p, 'store', 'verified-recipients.json')
    if (bytes) writeFileSync(ledger, bytes)
    return { cli: join(p, 'scripts', 'recipient-ledger.mjs'), ledger }
  }
  const add = (cli: string) => spawnSync(process.execPath, [cli, 'add', 'new@example.com', '--source', 'owner', '--note', 'test'],
    { encoding: 'utf-8', timeout: 20_000 })

  for (const [label, bytes] of Object.entries(UNUSABLE)) {
    it(`add on a ${label} ledger: exit != 0, reason named, file byte-identical`, () => {
      const { cli, ledger } = project(bytes)
      const r = add(cli)
      expect(r.status, r.stdout + r.stderr).not.toBe(0)
      expect(r.stderr).toMatch(/refusing to overwrite the existing ledger/)
      expect(readFileSync(ledger).equals(bytes)).toBe(true)
    })
  }

  it('list / check on an unusable ledger name the reason instead of "(empty)" / "NOT VERIFIED"', () => {
    const { cli } = project(UNUSABLE['truncated JSON'])
    for (const sub of [['list'], ['check', 'kept@example.com']]) {
      const r = spawnSync(process.execPath, [cli, ...sub], { encoding: 'utf-8', timeout: 20_000 })
      expect(r.status, sub.join(' ')).not.toBe(0)
      expect(r.stderr, sub.join(' ')).toMatch(/the ledger is not usable/)
      expect(r.stdout, sub.join(' ')).not.toMatch(/\(empty\)|NOT VERIFIED/)
    }
  })

  it('add when the ledger is absent: exit 0, file created; list on a missing ledger still says "(empty)"', () => {
    const { cli, ledger } = project(null)
    const listed = spawnSync(process.execPath, [cli, 'list'], { encoding: 'utf-8', timeout: 20_000 })
    expect(listed.status).toBe(0)
    expect(listed.stdout).toMatch(/\(empty\)/)
    const r = add(cli)
    expect(r.status, r.stderr).toBe(0)
    expect(Object.keys(JSON.parse(readFileSync(ledger, 'utf-8')).recipients)).toEqual(['new@example.com'])
  })
})
