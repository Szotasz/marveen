// INSTALLDIRTYTREE1103: the update flow runs scripts/install-drift-repair.py before
// it looks at the tree. The script's own rules are covered by
// scripts/__tests__/install-drift-repair.test.py; this file covers the wiring.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatedDriftPaths, runInstallDriftRepair, withoutGeneratedDrift } from '../install-drift-repair.js'
import { checkUpdatePreflight, type GitRunner } from '../update-preflight.js'

const ROOT = join(__dirname, '..', '..')

describe('runInstallDriftRepair (executed against a throwaway install)', () => {
  it('restores the install-generated lock line and reports it; the tree ends clean', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'driftts-'))
    try {
      mkdirSync(join(dir, 'scripts'))
      copyFileSync(join(ROOT, 'scripts', 'install-drift-repair.py'), join(dir, 'scripts', 'install-drift-repair.py'))
      const lock = '{\n  "packages": {\n    "node_modules/better-sqlite3": {\n      "version": "13.0.3",\n      "license": "MIT"\n    }\n  }\n}\n'
      writeFileSync(join(dir, 'package-lock.json'), lock)
      const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]).toString()
      git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'base')
      writeFileSync(join(dir, 'package-lock.json'), lock.replace('"version": "13.0.3",\n', '"version": "13.0.3",\n      "hasInstallScript": true,\n'))
      const bak = mkdtempSync(join(tmpdir(), 'driftts-bak-'))
      const out = await runInstallDriftRepair(dir, undefined, { backupDir: bak })
      rmSync(bak, { recursive: true, force: true })
      expect(out).toMatchObject({ ran: true, exitCode: 0 })
      expect(out.results).toEqual([expect.objectContaining({ path: 'package-lock.json', action: 'restored' })])
      expect(git('status', '--porcelain')).toBe('')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('never throws: a missing script or python3 is reported, not raised', async () => {
    const out = await runInstallDriftRepair('/nonexistent-install-dir-xyz')
    expect(out.ran).toBe(false)
    expect(out.error).toBeTruthy()
    const noPython = await runInstallDriftRepair(ROOT, async () => { throw new Error('spawn python3 ENOENT') })
    expect(noPython).toMatchObject({ ran: false, error: 'spawn python3 ENOENT' })
  })
})

// Samu 67345 (A): the dashboard writes NOTHING while the services run. It asks
// with --dry-run, the preflight ignores exactly the "restore" paths, and
// update.sh (followed by a restart) does the restore.
describe('dashboard: dry run only, the preflight ignores exactly the generated paths', () => {
  const lock = '{\n  "packages": {\n    "node_modules/better-sqlite3": {\n      "version": "13.0.3",\n      "license": "MIT"\n    }\n  }\n}\n'
  const npmLock = lock.replace('"version": "13.0.3",\n', '"version": "13.0.3",\n      "hasInstallScript": true,\n')

  it('a dry run reports "restore" and leaves the file and the tree untouched (executed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'driftdry-'))
    const bak = mkdtempSync(join(tmpdir(), 'driftdry-bak-'))
    try {
      mkdirSync(join(dir, 'scripts'))
      copyFileSync(join(ROOT, 'scripts', 'install-drift-repair.py'), join(dir, 'scripts', 'install-drift-repair.py'))
      writeFileSync(join(dir, 'package-lock.json'), lock)
      const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]).toString()
      git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'base')
      writeFileSync(join(dir, 'package-lock.json'), npmLock)
      const out = await runInstallDriftRepair(dir, undefined, { dryRun: true, backupDir: bak })
      expect(out).toMatchObject({ ran: true, exitCode: 0 })
      expect(out.results).toEqual([expect.objectContaining({ path: 'package-lock.json', action: 'restore' })])
      expect(readFileSync(join(dir, 'package-lock.json'), 'utf-8')).toBe(npmLock)
      expect(git('status', '--porcelain')).toBe(' M package-lock.json\n')
      expect(generatedDriftPaths(out)).toEqual(new Set(['package-lock.json']))
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(bak, { recursive: true, force: true }) }
  })

  it('withoutGeneratedDrift drops only exact path lines; anything else keeps blocking', () => {
    const porcelain = ' M package-lock.json\n M .claude/settings.json\n M README.md\nR  a -> package-lock.json\n M "odd name.json"'
    const kept = withoutGeneratedDrift(porcelain, new Set(['package-lock.json', '.claude/settings.json']))
    expect(kept.split('\n')).toEqual([' M README.md', 'R  a -> package-lock.json', ' M "odd name.json"'])
    expect(withoutGeneratedDrift(porcelain, new Set())).toBe(porcelain)
    expect(generatedDriftPaths({ ran: false, exitCode: null, results: [], error: 'x' })).toEqual(new Set())
  })

  it('the preflight passes when the ONLY dirt is generated, and still blocks on anything else', async () => {
    const fake = (porcelain: string): GitRunner => ({
      currentBranch: () => 'main', aheadCount: () => 0, behindCount: () => 0,
      originHasBranch: () => 'yes', porcelainStatus: () => porcelain,
    })
    const only = new Set(['package-lock.json'])
    const wrap = (g: GitRunner): GitRunner => ({ ...g, porcelainStatus: async () => withoutGeneratedDrift(await g.porcelainStatus(), only) })
    expect(await checkUpdatePreflight(fake(' M package-lock.json\n'))).toMatchObject({ ok: false, reason: 'dirty-tree' })
    expect(await checkUpdatePreflight(wrap(fake(' M package-lock.json\n')))).toEqual({ ok: true })
    expect(await checkUpdatePreflight(wrap(fake(' M package-lock.json\n M README.md\n')))).toMatchObject({ ok: false, reason: 'dirty-tree' })
  })
})

describe('both update entry points consult the repair BEFORE their dirty-tree check', () => {
  it('dashboard: /api/updates/apply asks with a DRY RUN only, and feeds the filtered status to the preflight', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'routes', 'updates.ts'), 'utf-8')
    const calls = src.match(/runInstallDriftRepair\([^)]*\)/g) ?? []
    expect(calls).toEqual(['runInstallDriftRepair(PROJECT_ROOT, undefined, { dryRun: true })'])
    const ask = src.indexOf('runInstallDriftRepair(PROJECT_ROOT, undefined, { dryRun: true })')
    const preflight = src.indexOf('preflight = await checkUpdatePreflight(preflightGit)')
    expect(ask).toBeGreaterThan(-1)
    expect(preflight).toBeGreaterThan(ask)
  })

  it('update.sh: calls it before the DIRTY guard, best effort (|| true)', () => {
    const sh = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
    const call = sh.indexOf('python3 "$INSTALL_DIR/scripts/install-drift-repair.py" --install-dir "$INSTALL_DIR"')
    const guard = sh.indexOf('DIRTY=$(git status --porcelain --untracked-files=no')
    expect(call).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(call)
    expect(sh.slice(call, sh.indexOf('\n', call))).toContain('|| true')
  })
})
