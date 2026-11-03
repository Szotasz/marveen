// INSTALLDIRTYTREE1103: the update flow runs scripts/install-drift-repair.py before
// it looks at the tree. The script's own rules are covered by
// scripts/__tests__/install-drift-repair.test.py; this file covers the wiring.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInstallDriftRepair } from '../install-drift-repair.js'

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
      const out = await runInstallDriftRepair(dir)
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

describe('both update entry points run the repair BEFORE their dirty-tree check', () => {
  it('dashboard: /api/updates/apply calls it before checkUpdatePreflight', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'routes', 'updates.ts'), 'utf-8')
    const repair = src.indexOf('await runInstallDriftRepair(PROJECT_ROOT)')
    const preflight = src.indexOf('preflight = await checkUpdatePreflight(git)')
    expect(repair).toBeGreaterThan(-1)
    expect(preflight).toBeGreaterThan(repair)
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
