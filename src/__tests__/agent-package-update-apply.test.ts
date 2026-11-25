// The agent package update's apply block (MIOAGENTB4-1122, PR-I4; plan 8.3 "Mentés", "Kivett skill", 8.4).
//
// On a temp tree: a real 1.0.0 install (the installer's own block), then the update to 1.1.0 computed and applied the
// way the route does it. The writes and deletes, the backups keyed to the target, J4 and the link checks, the
// plan_changed re-read, the interrupted run and its re-run, the repair's shell, and the trace's life.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-agent-package-update-'))
process.env.CLAUDECLAW_ENV_DIR = tmpRoot
const STORE = join(tmpRoot, 'store')
const AGENTS = join(tmpRoot, 'agents')

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()), PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store'), MAIN_AGENT_ID: 'agent-a',
  OWNER_NAME: 'TestOwner', BOT_NAME: 'Botty',
}))
const h = vi.hoisted(() => ({ rosterWithoutMarker: false, onTrace: null as null | (() => void) }))
vi.mock('../web/atomic-write.js', async (orig) => {
  const real = await orig<typeof import('../web/atomic-write.js')>()
  return {
    ...real,
    atomicWriteFileSync: (p: string, d: string | Buffer, o?: { mode?: number }) => {
      real.atomicWriteFileSync(p, d, o)
      // Dani P1 (#3085 B1): the agent swaps .package/backup for a link right after the trace write.
      if (h.onTrace && p.includes('agent-package-updating')) { const f = h.onTrace; h.onTrace = null; f() }
    },
  }
})
vi.mock('../web/agent-scaffold.js', async (orig) => {
  const real = await orig<typeof import('../web/agent-scaffold.js')>()
  return { ...real, fleetRosterBlock: (n: string) => (h.rosterWithoutMarker ? 'no marker here' : real.fleetRosterBlock(n)) }
})
vi.mock('../web/agent-create.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-create.js')>()),
  writeAgentBase: (name: string, base: Record<string, unknown>) => {
    writeFileSync(join(tmpRoot, 'agents', name, 'agent-config.json'), JSON.stringify({ model: base.model, displayName: base.displayName }))
  },
}))

mkdirSync(join(tmpRoot, 'templates', 'profiles'), { recursive: true })
for (const f of readdirSync(join(__dirname, '..', '..', 'templates', 'profiles'))) {
  copyFileSync(join(__dirname, '..', '..', 'templates', 'profiles', f), join(tmpRoot, 'templates', 'profiles', f))
}

const I = await import('../web/agent-package/install.js')
const U = await import('../web/agent-package/update.js')
const M = await import('../web/agent-package/marker.js')
const { verifyDelivery } = await import('../web/agent-package/verify.js')
const { makeKeyPair, makeSignedDelivery } = await import('./helpers/make-delivery.js')

const KEY = makeKeyPair()
const NOW = new Date('2026-11-23T10:00:00.000Z')
const LATER = new Date('2026-11-24T10:00:00.000Z')
const NAME = 'nora'
const V1 = {
  'CLAUDE.md': '# Nora\n\nPersona 1.\n',
  'SOUL.md': 'Calm.\n',
  'skills/notes/SKILL.md': '---\nname: notes\ndescription: Notes\n---\nTake notes.\n',
  'skills/old/SKILL.md': '---\nname: old\ndescription: Old\n---\nOld skill.\n',
  'skills/old/references/r.md': 'Old ref.\n',
}
const V2 = {
  'CLAUDE.md': '# Nora\n\nPersona 2.\n',
  'SOUL.md': 'Calm.\n',
  'skills/notes/SKILL.md': '---\nname: notes\ndescription: Notes\n---\nTake better notes.\n',
  'skills/new/SKILL.md': '---\nname: new\ndescription: New\n---\nNew skill.\n',
}
const pkgOf = (files: Record<string, string>, version: string) => {
  const v = verifyDelivery(makeSignedDelivery({ kid: KEY.kid, privateKey: KEY.privateKey, slug: NAME, version, files, displayName: 'Nora' }), NAME, [KEY.jwk])
  if (!v.ok) throw new Error(`test delivery refused: ${v.reason}`)
  return v.pkg
}
const dir = join(AGENTS, NAME)
const at = (rel: string): string => join(dir, rel)
const read = (rel: string): string => readFileSync(at(rel), 'utf8')

function install(files = V1, version = '1.0.0'): void {
  rmSync(dir, { recursive: true, force: true })
  rmSync(join(STORE, 'agent-package-updating'), { recursive: true, force: true })
  const r = I.runInstallBlock({ name: NAME, pkg: pkgOf(files, version), model: 'claude-sonnet-5', driveFolder: '', lang: 'hu', now: NOW })
  if (!r.ok) throw new Error(`install failed: ${r.kind}`)
}

/** What the route does inside the queue: the record, the list, the decisions, the block. */
function update(files: Record<string, string>, version: string, decisions: Record<string, string> = {}, quarantine = false, tamper?: () => void) {
  const pkg = pkgOf(files, version)
  const m = I.readPackageManifest(dir)
  if (m.state !== 'ok') throw new Error('no record')
  const installedFiles = U.installedFileHashes(m.manifest)!
  const k = U.classifyVersion({ version: m.manifest.payload.version, payloadSha256: m.manifest.payloadSha256 }, { version: pkg.version, payloadSha256: pkg.payloadSha256 })
  if (!k.ok) throw new Error(k.error)
  const list = U.computeChangeList({ name: NAME, agentDir: dir, manifest: m.manifest, installedFiles, pkg, kind: k.kind, quarantine })
  const d = U.checkDecisions(list, decisions)
  if (!d.ok) return { list, decided: d, result: null }
  tamper?.()
  const result = U.runApplyBlock({ name: NAME, agentDir: dir, list, ops: d.ops, pkg, manifest: m.manifest, installedFiles, driveFolder: '', lang: 'hu', now: LATER })
  return { list, decided: d, result, pkg }
}

beforeEach(() => { h.rosterWithoutMarker = false; h.onTrace = null; install() })

describe('upgrade without decisions', () => {
  it('writes the changed files, adds the new skill, removes the dropped one and its emptied folders, record last', () => {
    const before = I.readPackageManifest(dir)
    const { result, pkg } = update(V2, '1.1.0')
    expect(result).toEqual({ ok: true, applied: { write: 3, delete: 2, keep: 1 } })
    expect(read('PACKAGE.md')).toBe(V2['CLAUDE.md'])
    expect(read('.claude/skills/notes/SKILL.md')).toBe(V2['skills/notes/SKILL.md'])
    expect(read('.claude/skills/new/SKILL.md')).toBe(V2['skills/new/SKILL.md'])
    expect(existsSync(at('.claude/skills/old'))).toBe(false)
    const after = I.readPackageManifest(dir)
    expect(after.state === 'ok' && after.manifest.payloadSha256).toBe(pkg!.payloadSha256)
    expect(after.state === 'ok' && after.manifest.payload.version).toBe('1.1.0')
    // installedAt kept, updatedAt moved.
    expect(after.state === 'ok' && before.state === 'ok' && after.manifest.installedAt).toBe(before.state === 'ok' ? before.manifest.installedAt : '')
    expect(after.state === 'ok' && after.manifest.updatedAt).toBe(LATER.toISOString())
    expect((statSync(at('.claude/skills/new/SKILL.md')).mode & 0o777).toString(8)).toBe('644')
    expect(existsSync(join(STORE, 'agent-package-updating', `${NAME}.json`))).toBe(false)
  })
  it('the shell, LOCAL.md and agent-config.json are not touched (8.3: the chosen display name survives)', () => {
    writeFileSync(at('LOCAL.md'), 'mine\n')
    writeFileSync(at('agent-config.json'), JSON.stringify({ model: 'claude-sonnet-5', displayName: 'Chosen Name' }))
    const shell = read('CLAUDE.md')
    update(V2, '1.1.0')
    expect(read('LOCAL.md')).toBe('mine\n')
    expect(read('CLAUDE.md')).toBe(shell)
    expect(JSON.parse(read('agent-config.json')).displayName).toBe('Chosen Name')
  })
  it('a dropped skill folder with an owner file in it stays, with that file', () => {
    writeFileSync(at('.claude/skills/old/mine.md'), 'owner\n')
    update(V2, '1.1.0')
    expect(read('.claude/skills/old/mine.md')).toBe('owner\n')
    expect(existsSync(at('.claude/skills/old/references'))).toBe(false)
  })
})

describe('decisions and backups', () => {
  it('take-package over the owner text: the old text saved under the target key (0600), then overwritten', () => {
    writeFileSync(at('PACKAGE.md'), 'owner persona\n')
    const r = update(V2, '1.1.0', { 'CLAUDE.md': 'take-package' })
    expect(r.result?.ok).toBe(true)
    const key = r.pkg!.payloadSha256.slice(0, 16)
    const saved = join(dir, '.package', 'backup', key, 'PACKAGE.md')
    expect(readFileSync(saved, 'utf8')).toBe('owner persona\n')
    expect((statSync(saved).mode & 0o777).toString(8)).toBe('600')
    expect(read('PACKAGE.md')).toBe(V2['CLAUDE.md'])
  })
  it('keep-mine: the owner text stays, the record still holds the new package', () => {
    writeFileSync(at('PACKAGE.md'), 'owner persona\n')
    const r = update(V2, '1.1.0', { 'CLAUDE.md': 'keep-mine' })
    expect(r.decided.ok && r.decided.keptMine).toEqual(['CLAUDE.md'])
    expect(read('PACKAGE.md')).toBe('owner persona\n')
    const m = I.readPackageManifest(dir)
    expect(m.state === 'ok' && m.manifest.payload.version).toBe('1.1.0')
  })
  it('IR11: backups of another target go; this target\'s stay, an existing saved file is not overwritten', () => {
    const pkg2 = pkgOf(V2, '1.1.0')
    const key = pkg2.payloadSha256.slice(0, 16)
    mkdirSync(join(dir, '.package', 'backup', 'ffffffffffffffff'), { recursive: true })
    mkdirSync(join(dir, '.package', 'backup', key), { recursive: true })
    writeFileSync(join(dir, '.package', 'backup', key, 'PACKAGE.md'), 'first copy\n')
    writeFileSync(at('PACKAGE.md'), 'owner persona\n')
    update(V2, '1.1.0', { 'CLAUDE.md': 'take-package' })
    expect(readdirSync(join(dir, '.package', 'backup'))).toEqual([key])
    expect(readFileSync(join(dir, '.package', 'backup', key, 'PACKAGE.md'), 'utf8')).toBe('first copy\n')
  })
  it('M1 (#3085): a repair after a finished upgrade to the same target keeps BOTH owner texts', () => {
    writeFileSync(at('PACKAGE.md'), 'owner A\n')
    expect(update(V2, '1.1.0', { 'CLAUDE.md': 'take-package' }).result?.ok).toBe(true)
    writeFileSync(at('PACKAGE.md'), 'owner B\n')
    const r = update(V2, '1.1.0', { 'CLAUDE.md': 'take-package' })
    expect(r.list.kind).toBe('repair')
    expect(r.result?.ok).toBe(true)
    const b = join(dir, '.package', 'backup', r.pkg!.payloadSha256.slice(0, 16))
    expect(readFileSync(join(b, 'PACKAGE.md'), 'utf8')).toBe('owner A\n')
    expect(readFileSync(join(b, 'PACKAGE.md.2'), 'utf8')).toBe('owner B\n')
    expect((statSync(join(b, 'PACKAGE.md.2')).mode & 0o777).toString(8)).toBe('600')
    expect(read('PACKAGE.md')).toBe(V2['CLAUDE.md'])
    // The same text a third time: already saved, no third copy.
    writeFileSync(at('PACKAGE.md'), 'owner B\n')
    expect(update(V2, '1.1.0', { 'CLAUDE.md': 'take-package' }).result?.ok).toBe(true)
    expect(readdirSync(b).sort()).toEqual(['PACKAGE.md', 'PACKAGE.md.2'])
  })
  it('B1 (#3085, Dani P1): .package/backup swapped for a link after the trace write: the outside folder stays intact', () => {
    const victim = mkdtempSync(join(tmpdir(), 'marveen-victim-'))
    mkdirSync(join(victim, 'ffffffffffffffff'), { recursive: true })
    writeFileSync(join(victim, 'ffffffffffffffff', 'PACKAGE.md'), 'victim text\n')
    writeFileSync(join(victim, 'keep.txt'), 'victim\n')
    mkdirSync(join(dir, '.package', 'backup', 'eeeeeeeeeeeeeeee'), { recursive: true })
    h.onTrace = () => {
      renameSync(join(dir, '.package', 'backup'), join(dir, '.package', 'backup.x'))
      symlinkSync(victim, join(dir, '.package', 'backup'))
    }
    const r = update(V2, '1.1.0')
    expect(r.result).toMatchObject({ ok: false, status: 409, body: { error: 'path_blocked' } })
    expect(readFileSync(join(victim, 'ffffffffffffffff', 'PACKAGE.md'), 'utf8')).toBe('victim text\n')
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('victim\n')
  })
  it('IR11 bounded: only backup-shaped plain files go; an odd file and a link inside another key stay', () => {
    const b = join(dir, '.package', 'backup', 'dddddddddddddddd')
    mkdirSync(join(b, '.claude', 'skills', 'x', 'references'), { recursive: true })
    writeFileSync(join(b, 'PACKAGE.md'), 'a'); writeFileSync(join(b, 'PACKAGE.md.2'), 'b'); writeFileSync(join(b, 'SOUL.md'), 'c')
    writeFileSync(join(b, '.claude', 'skills', 'x', 'references', 'r.md'), 'd')
    writeFileSync(join(b, 'notes.txt'), 'odd')
    const outside = mkdtempSync(join(tmpdir(), 'marveen-outside-'))
    writeFileSync(join(outside, 'SOUL.md'), 'outside')
    symlinkSync(outside, join(b, 'linked'))
    expect(update(V2, '1.1.0').result?.ok).toBe(true)
    expect(readdirSync(b).sort()).toEqual(['linked', 'notes.txt'])
    expect(readFileSync(join(outside, 'SOUL.md'), 'utf8')).toBe('outside')
  })
  it('a link at .package/backup: path_blocked, nothing written', () => {
    const outside = mkdtempSync(join(tmpdir(), 'marveen-outside-'))
    mkdirSync(join(dir, '.package'), { recursive: true })
    symlinkSync(outside, join(dir, '.package', 'backup'))
    const r = update(V2, '1.1.0')
    expect(r.result).toMatchObject({ ok: false, status: 409, body: { error: 'path_blocked' } })
    expect(read('PACKAGE.md')).toBe(V1['CLAUDE.md'])
  })
})

describe('the disk moves between the list and the block', () => {
  it('D2: a clean file changed by the agent after the list: plan_changed, the agent text survives', () => {
    const r = update(V2, '1.1.0', {}, false, () => writeFileSync(at('PACKAGE.md'), 'written meanwhile\n'))
    expect(r.result).toEqual({ ok: false, status: 409, body: { error: 'plan_changed' } })
    expect(read('PACKAGE.md')).toBe('written meanwhile\n')
  })
  it('J4: a skill folder swapped for a link after the list: path_blocked, nothing lands outside', () => {
    const outside = mkdtempSync(join(tmpdir(), 'marveen-outside-'))
    const r = update(V2, '1.1.0', {}, false, () => {
      rmSync(at('.claude/skills/notes'), { recursive: true })
      symlinkSync(outside, at('.claude/skills/notes'))
    })
    expect(r.result).toMatchObject({ ok: false, status: 409, body: { error: 'path_blocked' } })
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('an interrupted update, and its re-run', () => {
  it('the record write fails: 500, the trace names from and to, the record stays old; the re-run finishes', () => {
    // A FOLDER where the record file goes: the record write (the last step) throws after the files were written.
    const recordPath = join(dir, '.package', 'manifest.json')
    const keep = readFileSync(recordPath)
    unlinkSync(recordPath)
    mkdirSync(join(recordPath, 'x'), { recursive: true })
    const pkg = pkgOf(V2, '1.1.0')
    const m = { state: 'ok' as const, manifest: JSON.parse(keep.toString('utf8')) }
    const installedFiles = U.installedFileHashes(m.manifest)!
    const list = U.computeChangeList({ name: NAME, agentDir: dir, manifest: m.manifest, installedFiles, pkg, kind: 'upgrade', quarantine: false })
    const d = U.checkDecisions(list, {})
    if (!d.ok) throw new Error('decisions')
    const r = U.runApplyBlock({ name: NAME, agentDir: dir, list, ops: d.ops, pkg, manifest: m.manifest, installedFiles, driveFolder: '', lang: 'hu', now: LATER })
    expect(r).toEqual({ ok: false, status: 500, body: { error: 'update_failed' } })
    expect(read('PACKAGE.md')).toBe(V2['CLAUDE.md'])
    expect(U.readUpdatingTrace(NAME)).toEqual({ from: '1.0.0', to: '1.1.0', startedAt: LATER.toISOString() })
    // The owner's disk is put back to a folder with the OLD record: the re-run sees current/absent and finishes.
    rmSync(recordPath, { recursive: true })
    writeFileSync(recordPath, keep)
    const again = update(V2, '1.1.0')
    expect(again.list.items.map((i) => [i.path, i.state, i.action])).toEqual([
      ['CLAUDE.md', 'current', 'keep'], ['SOUL.md', 'clean', 'keep'], ['skills/new/SKILL.md', 'current', 'keep'],
      ['skills/notes/SKILL.md', 'current', 'keep'], ['skills/old/SKILL.md', 'absent', 'keep'], ['skills/old/references/r.md', 'absent', 'keep'],
    ])
    expect(again.result?.ok).toBe(true)
    expect(U.readUpdatingTrace(NAME)).toBeNull()
  })
  it('removeOrphanUpdatingTraces: only the trace of an agent that no longer exists goes', () => {
    mkdirSync(join(STORE, 'agent-package-updating'), { recursive: true })
    writeFileSync(join(STORE, 'agent-package-updating', 'nora.json'), '{}')
    writeFileSync(join(STORE, 'agent-package-updating', 'gone.json'), '{}')
    expect(U.removeOrphanUpdatingTraces((n) => n === 'nora')).toBe(1)
    expect(readdirSync(join(STORE, 'agent-package-updating'))).toEqual(['nora.json'])
  })
})

describe('repair', () => {
  it('a missing shell: shell + roster block in one write; a missing LOCAL.md: the placeholder', () => {
    unlinkSync(at('CLAUDE.md'))
    unlinkSync(at('LOCAL.md'))
    expect(U.shellRepairState(dir)).toEqual({ shell: 'missing', local: 'missing' })
    const r = update(V1, '1.0.0')
    expect(r.list.kind).toBe('repair')
    expect(r.result?.ok).toBe(true)
    const shell = readFileSync(at('CLAUDE.md'))
    expect(M.startsWithPackageShell(shell)).toBe(true)
    expect(M.hasLaunchTrace(shell)).toBe(true)
    expect(read('LOCAL.md')).toBe(I.LOCAL_MD_TEXT.hu)
  })
  it('A2: a roster block without its marker: the shell it made is deleted, 500, the record not written', () => {
    unlinkSync(at('CLAUDE.md'))
    h.rosterWithoutMarker = true
    const before = readFileSync(join(dir, '.package', 'manifest.json'))
    const r = update(V1, '1.0.0')
    expect(r.result).toEqual({ ok: false, status: 500, body: { error: 'update_failed' } })
    expect(existsSync(at('CLAUDE.md'))).toBe(false)
    expect(readFileSync(join(dir, '.package', 'manifest.json'))).toEqual(before)
  })
  it('an upgrade does not restore a missing shell (the step is the repair\'s)', () => {
    unlinkSync(at('CLAUDE.md'))
    expect(update(V2, '1.1.0').result?.ok).toBe(true)
    expect(existsSync(at('CLAUDE.md'))).toBe(false)
  })
  it('8.3: an op whose disk path is the shell, LOCAL.md or the record is refused before any write', () => {
    const r = update(V2, '1.1.0', {}, false)
    expect(r.result?.ok).toBe(true)
    install()
    const pkg = pkgOf(V2, '1.1.0')
    const m = I.readPackageManifest(dir)
    if (m.state !== 'ok') throw new Error('no record')
    const installedFiles = U.installedFileHashes(m.manifest)!
    const list = U.computeChangeList({ name: NAME, agentDir: dir, manifest: m.manifest, installedFiles, pkg, kind: 'upgrade', quarantine: false })
    const d = U.checkDecisions(list, {})
    if (!d.ok) throw new Error('decisions')
    for (const bad of ['CLAUDE.md', 'LOCAL.md', join('.package', 'manifest.json')]) {
      const ops = d.ops.map((o) => (o.item.path === 'CLAUDE.md' ? { ...o, item: { ...o.item, disk: bad } } : o))
      const before = read('PACKAGE.md')
      expect(U.runApplyBlock({ name: NAME, agentDir: dir, list, ops, pkg, manifest: m.manifest, installedFiles, driveFolder: '', lang: 'hu', now: LATER })).toEqual({ ok: false, status: 500, body: { error: 'update_failed' } })
      expect(read('PACKAGE.md')).toBe(before)
    }
  })
  it('a broken shell is not touched; repair restores a missing package file on take-package', () => {
    writeFileSync(at('CLAUDE.md'), 'hand edited\n')
    unlinkSync(at('SOUL.md'))
    expect(U.shellRepairState(dir).shell).toBe('broken')
    const r = update(V1, '1.0.0', { 'SOUL.md': 'take-package' })
    expect(r.result?.ok).toBe(true)
    expect(read('CLAUDE.md')).toBe('hand edited\n')
    expect(read('SOUL.md')).toBe(V1['SOUL.md'])
  })
  it('repair: a modified file asks (row 2), and take-package brings the package text back', () => {
    writeFileSync(at('PACKAGE.md'), '')
    const r = update(V1, '1.0.0', { 'CLAUDE.md': 'take-package' })
    expect(r.list.items.find((i) => i.path === 'CLAUDE.md')).toMatchObject({ state: 'missing', choices: ['take-package'] })
    expect(r.result?.ok).toBe(true)
    expect(read('PACKAGE.md')).toBe(V1['CLAUDE.md'])
    expect(lstatSync(at('PACKAGE.md')).isFile()).toBe(true)
  })
})
