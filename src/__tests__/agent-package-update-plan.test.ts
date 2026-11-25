// The agent package update's change list (MIOAGENTB4-1122, PR-I4; plan 8.1, 8.2, 8.3, 8.5, 6.3 decisions).
//
// Pure: the disk is a fake reader (the lstat walk has its own cases at the end, on a temp folder). Every row of the
// 8.3 table for both kinds, the quarantine folder decision, the planId's fields, and the decision check's refusals.
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const U = await import('../web/agent-package/update.js')
const { verifyDelivery } = await import('../web/agent-package/verify.js')
const { makeKeyPair, makeSignedDelivery } = await import('./helpers/make-delivery.js')
type DiskEntry = import('../web/agent-package/update.js').DiskEntry
type PackageManifest = import('../web/agent-package/install.js').PackageManifest

const KEY = makeKeyPair()
const sha = (t: string): string => createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex')
const pkgOf = (files: Record<string, string>, version = '1.1.0') => {
  const v = verifyDelivery(makeSignedDelivery({ kid: KEY.kid, privateKey: KEY.privateKey, slug: 'nora', version, files }), 'nora', [KEY.jwk])
  if (!v.ok) throw new Error(`test delivery refused: ${v.reason}`)
  return v.pkg
}
const manifestOf = (files: Record<string, string>, version = '1.0.0', payloadSha256 = 'a'.repeat(64)): PackageManifest => ({
  schema: 1, payloadSha256, kid: KEY.kid, installedAt: 'x', updatedAt: 'x',
  payload: { slug: 'nora', version, files: Object.entries(files).map(([path, t]) => ({ path, sha256: sha(t), size: t.length })) },
})
const file = (t: string): DiskEntry => ({ kind: 'file', bytes: Buffer.from(t, 'utf8') })
const MISSING: DiskEntry = { kind: 'missing' }
const BLOCKED: DiskEntry = { kind: 'blocked' }
const row = (o: string | null, n: string | null, d: DiskEntry, kind: 'upgrade' | 'repair' = 'upgrade', quarantine = false, path = 'SOUL.md') =>
  U.itemOf({ path, o: o === null ? null : sha(o), n: n === null ? null : { sha256: sha(n), text: n }, d }, kind, quarantine)

describe('8.1 classifyVersion', () => {
  it('upgrade, repair, conflict, downgrade', () => {
    expect(U.classifyVersion({ version: '1.0.0', payloadSha256: 'a' }, { version: '1.1.0', payloadSha256: 'b' })).toEqual({ ok: true, kind: 'upgrade' })
    expect(U.classifyVersion({ version: '1.9.0', payloadSha256: 'a' }, { version: '1.10.0', payloadSha256: 'b' })).toEqual({ ok: true, kind: 'upgrade' })
    expect(U.classifyVersion({ version: '1.1.0', payloadSha256: 'a' }, { version: '1.1.0', payloadSha256: 'a' })).toEqual({ ok: true, kind: 'repair' })
    expect(U.classifyVersion({ version: '1.1.0', payloadSha256: 'a' }, { version: '1.1.0', payloadSha256: 'b' })).toEqual({ ok: false, error: 'version_conflict' })
    expect(U.classifyVersion({ version: '1.1.0', payloadSha256: 'a' }, { version: '1.0.9', payloadSha256: 'b' })).toEqual({ ok: false, error: 'downgrade_refused' })
  })
})

describe('8.3 the table, row by row', () => {
  const cases: Array<[string, ReturnType<typeof row>, string, string]> = [
    ['1 N=O, D=O', row('a', 'a', file('a')), 'clean', 'keep'],
    ['2 N=O, D other (upgrade)', row('a', 'a', file('x')), 'modified', 'keep'],
    ['2 N=O, D other (repair)', row('a', 'a', file('x'), 'repair'), 'modified', 'decide'],
    ['3 N=O, D missing', row('a', 'a', MISSING), 'missing', 'decide'],
    ['4 N!=O, D=O', row('a', 'b', file('a')), 'clean', 'write'],
    ['5 N!=O, D=N', row('a', 'b', file('b')), 'current', 'keep'],
    ['6 N!=O, D other', row('a', 'b', file('x')), 'modified', 'decide'],
    ['7 N!=O, D missing', row('a', 'b', MISSING), 'missing', 'decide'],
    ['8 no N, D=O', row('a', null, file('a')), 'clean', 'delete'],
    ['9 no N, D other', row('a', null, file('x')), 'modified', 'decide'],
    ['10 no N, D missing', row('a', null, MISSING), 'absent', 'keep'],
    ['11 no O, D missing', row(null, 'b', MISSING), 'absent', 'write'],
    ['12 no O, D=N', row(null, 'b', file('b')), 'current', 'keep'],
    ['13 no O, D other', row(null, 'b', file('x')), 'foreign', 'decide'],
  ]
  for (const [name, item, state, action] of cases) {
    it(name, () => {
      expect(item.state).toBe(state)
      expect(item.action).toBe(action)
    })
  }
  it('the other rows do not depend on the kind (only row 2 does)', () => {
    for (const [o, n, d] of [['a', 'a', file('a')], ['a', 'b', file('a')], ['a', 'b', file('x')], ['a', null, file('a')], [null, 'b', MISSING]] as const) {
      const u = row(o, n, d, 'upgrade')
      const r = row(o, n, d, 'repair')
      expect([r.state, r.action]).toEqual([u.state, u.action])
    }
  })
  it('a decide item carries both choices and the two texts; a non-decide item neither', () => {
    const d = row('a', 'b', file('mine'))
    expect(d.choices).toEqual(['take-package', 'keep-mine'])
    expect(d.texts).toEqual({ disk: 'mine', package: 'b', diskTruncated: false })
    const k = row('a', 'a', file('a'))
    expect([k.choices, k.texts]).toEqual([null, null])
  })
  it('blocked: keep, no texts, the disk not hashed', () => {
    const b = row('a', 'b', BLOCKED)
    expect([b.state, b.action, b.texts, b.diskSha256, b.newSha256]).toEqual(['blocked', 'keep', null, null, sha('b')])
  })
  it('D10: an empty PACKAGE.md is missing, and keep-mine is not offered for it', () => {
    const e = row('a', 'b', file(' \n\t'), 'upgrade', false, 'CLAUDE.md')
    expect([e.state, e.action, e.choices, e.disk]).toEqual(['missing', 'decide', ['take-package'], 'PACKAGE.md'])
    const kept = row('a', 'a', file(''), 'upgrade', false, 'CLAUDE.md')
    expect([kept.state, kept.choices]).toEqual(['missing', ['take-package']])
  })
  it('a missing SOUL.md offers take-package only; a modified one both', () => {
    expect(row('a', 'b', MISSING).choices).toEqual(['take-package'])
    expect(row('a', 'b', file('x')).choices).toEqual(['take-package', 'keep-mine'])
  })
  it('the disk path is the 4. section mapping', () => {
    expect(row('a', 'b', file('a'), 'upgrade', false, 'skills/x/SKILL.md').disk).toBe(join('.claude', 'skills', 'x', 'SKILL.md'))
  })
})

describe('8.2 disk text', () => {
  it('cut at a code point within 256 KiB, flagged', () => {
    const big = Buffer.from('a'.repeat(U.DISK_TEXT_MAX_BYTES - 1) + 'é' + 'b', 'utf8')
    const t = U.diskTextOf(big)
    expect(t.diskTruncated).toBe(true)
    expect(t.disk).toBe('a'.repeat(U.DISK_TEXT_MAX_BYTES - 1))
  })
  it('invalid UTF-8: null and binary, no lossy decoding', () => {
    expect(U.diskTextOf(Buffer.from([0x61, 0xff, 0x62]))).toEqual({ disk: null, diskTruncated: false, diskBinary: true })
  })
})

describe('8.5 quarantine on: skill folder decisions', () => {
  const S = 'skills/inv/SKILL.md'
  it('rows 3, 4, 7, 8, 11 under skills/ go to the folder; the owner-modified rows stay per file', () => {
    for (const [o, n, d] of [['a', 'a', MISSING], ['a', 'b', file('a')], ['a', 'b', MISSING], ['a', null, file('a')], [null, 'b', MISSING]] as const) {
      const i = row(o, n, d, 'upgrade', true, S)
      expect([i.action, i.choices, i.folder]).toEqual(['decide', null, 'skills/inv/'])
    }
    for (const [o, n, d] of [['a', 'b', file('x')], ['a', null, file('x')], [null, 'b', file('x')]] as const) {
      const i = row(o, n, d, 'upgrade', true, S)
      expect([i.action, i.folder]).toEqual(['decide', undefined])
      expect(i.choices).toEqual(['take-package', 'keep-mine'])
    }
  })
  it('quarantine off: the same rows are the plain table', () => {
    expect(row('a', 'b', file('a'), 'upgrade', false, S).action).toBe('write')
    expect(row(null, 'b', MISSING, 'upgrade', false, S).action).toBe('write')
  })
  it('not under skills/: no folder even with the quarantine on', () => {
    const i = row('a', 'b', file('a'), 'upgrade', true, 'SOUL.md')
    expect(i.action).toBe('write')
    expect('folder' in i).toBe(false)
  })
  it('folderKeyOf: first two segments; prefix names do not share a folder', () => {
    expect(U.folderKeyOf('skills/ab/SKILL.md')).toBe('skills/ab/')
    expect(U.folderKeyOf('skills/ab-c/references/x.md')).toBe('skills/ab-c/')
    expect(U.folderKeyOf('SOUL.md')).toBeNull()
  })
})

describe('computeChangeList + planId', () => {
  const OLD = { 'CLAUDE.md': 'P1\n', 'SOUL.md': 'S1\n', 'skills/inv/SKILL.md': 'K1\n' }
  const NEW = { 'CLAUDE.md': 'P2\n', 'SOUL.md': 'S1\n', 'skills/inv/SKILL.md': 'K2\n', 'skills/inv/references/r.md': 'R\n' }
  const disk: Record<string, string> = { 'PACKAGE.md': 'P1\n', 'SOUL.md': 'mine\n', [join('.claude', 'skills', 'inv', 'SKILL.md')]: 'K1\n' }
  const read = (_dir: string, rel: string): DiskEntry => (rel in disk ? file(disk[rel]) : MISSING)
  const listOf = (quarantine: boolean, d = read) => {
    const manifest = manifestOf(OLD)
    return U.computeChangeList({ name: 'nora', agentDir: '/x', manifest, installedFiles: U.installedFileHashes(manifest)!, pkg: pkgOf(NEW), kind: 'upgrade', quarantine, read: d })
  }
  it('items in path byte order, the summary counted', () => {
    const l = listOf(false)
    expect(l.items.map((i) => i.path)).toEqual(['CLAUDE.md', 'SOUL.md', 'skills/inv/SKILL.md', 'skills/inv/references/r.md'])
    expect(l.items.map((i) => i.action)).toEqual(['write', 'keep', 'write', 'write'])
    expect(l.summary).toEqual({ write: 3, delete: 0, keep: 1, decide: 0 })
    expect(l.planId).toMatch(/^[0-9a-f]{64}$/)
  })
  it('the planId is the sha256 of exactly the listed fields, canonical JSON', () => {
    const l = listOf(false)
    const doc = {
      available: l.available, installed: l.installed,
      items: l.items.map((i) => ({ action: i.action, disk: i.disk, diskSha256: i.diskSha256, installedSha256: i.installedSha256, newSha256: i.newSha256, path: i.path, state: i.state })),
      kind: l.kind, name: l.name, slug: l.slug,
    }
    const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v
    expect(l.planId).toBe(createHash('sha256').update(JSON.stringify(sorted(doc))).digest('hex'))
  })
  it('choices, texts and folder do not move the planId; the quarantine switch does (8.5)', () => {
    const off = listOf(false)
    const on = listOf(true)
    expect(on.planId).not.toBe(off.planId)
    const stripped = { ...off, items: off.items.map((i) => ({ ...i, choices: null, texts: null, folder: 'skills/z/' })) }
    expect(U.planIdOf(stripped)).toBe(off.planId)
  })
  it('a disk change moves the planId', () => {
    const changed = (_d: string, rel: string): DiskEntry => (rel === 'SOUL.md' ? file('mine2\n') : read(_d, rel))
    expect(listOf(false, changed).planId).not.toBe(listOf(false).planId)
  })
  it('quarantine on: one folder entry with its paths, mixedWarning when missing and modified stand together', () => {
    const l = listOf(true)
    expect(l.skillFolders).toEqual([{ folder: 'skills/inv/', action: 'decide', choices: ['take-package', 'keep-mine'], paths: ['skills/inv/SKILL.md', 'skills/inv/references/r.md'], filePaths: [], mixedWarning: false }])
    const held = (_d: string, rel: string): DiskEntry => (rel === join('.claude', 'skills', 'inv', 'SKILL.md') ? file('owner\n') : read(_d, rel))
    const m = manifestOf({ ...OLD, 'skills/inv/references/r.md': 'R\n' })
    const l2 = U.computeChangeList({ name: 'nora', agentDir: '/x', manifest: m, installedFiles: U.installedFileHashes(m)!, pkg: pkgOf(NEW), kind: 'upgrade', quarantine: true, read: held })
    expect(l2.skillFolders[0]).toMatchObject({ paths: ['skills/inv/references/r.md'], filePaths: ['skills/inv/SKILL.md'], mixedWarning: true })
  })
  it('installedFileHashes refuses a record that is not the contract shape', () => {
    const m = manifestOf(OLD)
    expect(U.installedFileHashes({ ...m, payload: { ...m.payload, files: 'x' } })).toBeNull()
    expect(U.installedFileHashes({ ...m, payload: { ...m.payload, files: [{ path: '../x', sha256: 'a'.repeat(64) }] } })).toBeNull()
    expect(U.installedFileHashes({ ...m, payload: { ...m.payload, files: [{ path: 'SOUL.md', sha256: 'a'.repeat(64) }, { path: 'SOUL.md', sha256: 'b'.repeat(64) }] } })).toBeNull()
  })
})

describe('6.3 checkDecisions', () => {
  const OLD = { 'CLAUDE.md': 'P1\n', 'SOUL.md': 'S1\n', 'skills/ab/SKILL.md': 'A1\n', 'skills/ab-c/SKILL.md': 'C1\n' }
  const NEW = { 'CLAUDE.md': 'P2\n', 'SOUL.md': 'S2\n', 'skills/ab/SKILL.md': 'A2\n', 'skills/ab-c/SKILL.md': 'C2\n' }
  const listWith = (disk: Record<string, DiskEntry>, quarantine: boolean) => {
    const manifest = manifestOf(OLD)
    return U.computeChangeList({ name: 'nora', agentDir: '/x', manifest, installedFiles: U.installedFileHashes(manifest)!, pkg: pkgOf(NEW), kind: 'upgrade', quarantine, read: (_d, rel) => disk[rel] ?? MISSING })
  }
  const AB = join('.claude', 'skills', 'ab', 'SKILL.md')
  const ABC = join('.claude', 'skills', 'ab-c', 'SKILL.md')
  const clean = { 'PACKAGE.md': file('P1\n'), 'SOUL.md': file('S1\n'), [AB]: file('A1\n'), [ABC]: file('C1\n') }

  it('no decide item: an empty body applies; ops follow the table', () => {
    const r = U.checkDecisions(listWith(clean, false), {})
    expect(r.ok && r.ops.map((o) => o.op)).toEqual(['write', 'write', 'write', 'write'])
  })
  it('refusal order: path_blocked before bad_request before decision_required', () => {
    const l = listWith({ ...clean, 'SOUL.md': BLOCKED, 'PACKAGE.md': file('mine') }, false)
    expect(U.checkDecisions(l, 'nope')).toMatchObject({ status: 409, body: { error: 'path_blocked', paths: ['SOUL.md'] } })
    const l2 = listWith({ ...clean, 'PACKAGE.md': file('mine') }, false)
    expect(U.checkDecisions(l2, { 'CLAUDE.md': 'maybe' })).toMatchObject({ status: 400 })
    expect(U.checkDecisions(l2, {})).toMatchObject({ status: 409, body: { error: 'decision_required', paths: ['CLAUDE.md'] } })
  })
  it('a decision on a path that does not ask, or a choice not offered: 400', () => {
    const l = listWith({ ...clean, 'PACKAGE.md': file('mine'), 'SOUL.md': MISSING }, false)
    expect(U.checkDecisions(l, { 'CLAUDE.md': 'keep-mine', 'SOUL.md': 'take-package', 'skills/ab/SKILL.md': 'take-package' })).toMatchObject({ status: 400 })
    expect(U.checkDecisions(l, { 'CLAUDE.md': 'keep-mine', 'SOUL.md': 'keep-mine' })).toMatchObject({ status: 400 })
    const ok = U.checkDecisions(l, { 'CLAUDE.md': 'keep-mine', 'SOUL.md': 'take-package' })
    expect(ok.ok && ok.keptMine).toEqual(['CLAUDE.md'])
  })
  it('take-package over the owner text: write with a backup; keep-mine: keep', () => {
    const l = listWith({ ...clean, 'PACKAGE.md': file('mine') }, false)
    const r = U.checkDecisions(l, { 'CLAUDE.md': 'take-package' })
    expect(r.ok && r.ops[0]).toMatchObject({ op: 'write', backup: true })
  })
  it('B2: folder keys match exactly, nothing normalized', () => {
    const l = listWith(clean, true)
    expect(l.skillFolders.map((f) => f.folder)).toEqual(['skills/ab-c/', 'skills/ab/'])
    for (const k of ['skills/ab', 'skills/ab//', 'skills/ab/./', 'skills/', '/skills/ab/', 'skills/AB/']) {
      expect(U.checkDecisions(l, { 'skills/ab/': 'take-package', 'skills/ab-c/': 'take-package', [k]: 'take-package' })).toMatchObject({ status: 400 })
    }
    for (const v of [['x'], {}, null]) {
      expect(U.checkDecisions(l, { 'skills/ab/': v, 'skills/ab-c/': 'take-package' })).toMatchObject({ status: 400 })
    }
  })
  it('a folder decision does not carry its prefix neighbour (ab vs ab-c); a missing one is decision_required', () => {
    const l = listWith(clean, true)
    expect(U.checkDecisions(l, { 'skills/ab/': 'take-package' })).toMatchObject({ status: 409, body: { error: 'decision_required', paths: ['skills/ab-c/'] } })
    const r = U.checkDecisions(l, { 'skills/ab/': 'keep-mine', 'skills/ab-c/': 'take-package' })
    expect(r.ok && r.keptMine).toEqual(['skills/ab/'])
    expect(r.ok && r.ops.find((o) => o.item.path === 'skills/ab-c/SKILL.md')?.op).toBe('write')
    expect(r.ok && r.ops.find((o) => o.item.path === 'skills/ab/SKILL.md')?.op).toBe('keep')
  })
  it('B2: a folder\'s filePaths and mixedWarning hold only its own files, not its prefix neighbour\'s', () => {
    // ab: a folder row (new file); ab-c: the owner's own SKILL.md (per file) and a missing file.
    const manifest = manifestOf({ ...OLD, 'skills/ab-c/references/x.md': 'X\n' })
    const pkg = pkgOf({ ...NEW, 'skills/ab/references/n.md': 'N\n', 'skills/ab-c/references/x.md': 'X\n' })
    const disk = { ...clean, [AB]: file('A1\n'), [ABC]: file('owner\n') } as Record<string, DiskEntry>
    const l = U.computeChangeList({ name: 'nora', agentDir: '/x', manifest, installedFiles: U.installedFileHashes(manifest)!, pkg, kind: 'upgrade', quarantine: true, read: (_d, rel) => disk[rel] ?? MISSING })
    const ab = l.skillFolders.find((x) => x.folder === 'skills/ab/')!
    expect(ab.filePaths).toEqual([])
    expect(ab.mixedWarning).toBe(false)
    expect(l.skillFolders.find((x) => x.folder === 'skills/ab-c/')).toMatchObject({ filePaths: ['skills/ab-c/SKILL.md'], mixedWarning: true })
  })
  it('a file decision under a folder-decided path is 400', () => {
    const l = listWith(clean, true)
    expect(U.checkDecisions(l, { 'skills/ab/': 'take-package', 'skills/ab-c/': 'take-package', 'skills/ab/SKILL.md': 'take-package' })).toMatchObject({ status: 400 })
  })
  it('Samu A: folder keep-mine holds its per-file items; a take-package there is 400; none needed', () => {
    // ab: a new file (folder row 11) and the owner's own SKILL.md (row 6, per file).
    const manifest = manifestOf(OLD)
    const pkg = pkgOf({ ...NEW, 'skills/ab/references/n.md': 'N\n' })
    const l = U.computeChangeList({ name: 'nora', agentDir: '/x', manifest, installedFiles: U.installedFileHashes(manifest)!, pkg, kind: 'upgrade', quarantine: true, read: (_d, rel) => ({ ...clean, [AB]: file('owner\n') } as Record<string, DiskEntry>)[rel] ?? MISSING })
    const f = l.skillFolders.find((x) => x.folder === 'skills/ab/')!
    expect([f.paths, f.filePaths]).toEqual([['skills/ab/references/n.md'], ['skills/ab/SKILL.md']])
    expect(U.checkDecisions(l, { 'skills/ab/': 'keep-mine', 'skills/ab-c/': 'take-package', 'skills/ab/SKILL.md': 'take-package' })).toMatchObject({ status: 400 })
    const r = U.checkDecisions(l, { 'skills/ab/': 'keep-mine', 'skills/ab-c/': 'take-package' })
    expect(r.ok && r.keptMine).toEqual(['skills/ab/'])
    expect(r.ok && r.ops.filter((o) => o.item.path.startsWith('skills/ab/')).map((o) => o.op)).toEqual(['keep', 'keep'])
    // take-package for the folder: the per-file item still needs its own answer.
    expect(U.checkDecisions(l, { 'skills/ab/': 'take-package', 'skills/ab-c/': 'take-package' })).toMatchObject({ status: 409, body: { paths: ['skills/ab/SKILL.md'] } })
  })
})

describe('readDiskEntry: lstat before read', () => {
  const root = mkdtempSync(join(tmpdir(), 'marveen-update-disk-'))
  const agent = join(root, 'nora')
  mkdirSync(join(agent, '.claude', 'skills', 'ok'), { recursive: true })
  writeFileSync(join(agent, 'SOUL.md'), 'soul')
  writeFileSync(join(agent, '.claude', 'skills', 'ok', 'SKILL.md'), 'k')
  mkdirSync(join(root, 'outside'))
  writeFileSync(join(root, 'outside', 'SKILL.md'), 'secret')
  symlinkSync(join(root, 'outside'), join(agent, '.claude', 'skills', 'out'))
  symlinkSync(join(root, 'outside', 'SKILL.md'), join(agent, 'PACKAGE.md'))
  mkdirSync(join(agent, 'dirfile'))
  it('a file, a missing file, a missing folder', () => {
    expect(U.readDiskEntry(agent, 'SOUL.md')).toEqual({ kind: 'file', bytes: Buffer.from('soul') })
    expect(U.readDiskEntry(agent, '.claude/skills/ok/SKILL.md')).toMatchObject({ kind: 'file' })
    expect(U.readDiskEntry(agent, 'nope.md')).toEqual({ kind: 'missing' })
    expect(U.readDiskEntry(agent, '.claude/skills/new/SKILL.md')).toEqual({ kind: 'missing' })
  })
  it('a link anywhere on the path, or a folder where the file goes: blocked, never read', () => {
    expect(U.readDiskEntry(agent, 'PACKAGE.md')).toEqual({ kind: 'blocked' })
    expect(U.readDiskEntry(agent, '.claude/skills/out/SKILL.md')).toEqual({ kind: 'blocked' })
    expect(U.readDiskEntry(agent, 'dirfile')).toEqual({ kind: 'blocked' })
    expect(U.readDiskEntry(agent, 'SOUL.md/x')).toEqual({ kind: 'blocked' })
  })
})
