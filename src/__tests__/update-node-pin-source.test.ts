import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// NODEPINMAC921 (2026-09-21, external report + own re-measure): update.sh's
// node pin fell back to .nvmrc when the running dashboard's exe could not be
// detected (the macOS norm: `ps -o comm=` prints a bare "node", /proc does not
// exist, lsof may be missing), yet printed "matches the running dashboard".
// The sentence was not measured in that branch; the reporter lost 16 hours
// of scheduler time to the ABI mismatch it hid.
//
// Extracts resolve_service_node_dir plus the pin block VERBATIM from
// update.sh and runs them in bash with the process detection stubbed via
// PATH: a fake pgrep that finds nothing (fallback branch) or finds a pid
// whose fake `ps -o comm=` answers with an absolute node path (exe branch).

const ROOT = join(__dirname, '..', '..')
const UPDATE_SH = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

function extract(): string {
  const start = UPDATE_SH.indexOf('resolve_service_node_dir() {')
  const endMarker = '\n# Pidfile gate.'
  const end = UPDATE_SH.indexOf(endMarker, start)
  expect(start, 'resolve_service_node_dir not found in update.sh').toBeGreaterThan(-1)
  expect(end, 'pin block end marker not found').toBeGreaterThan(start)
  return UPDATE_SH.slice(start, end)
}

function runPin(opts: { detectExe: boolean }): string {
  const base = mkdtempSync(join(tmpdir(), 'nodepin-'))
  const install = join(base, 'install'); mkdirSync(install)
  writeFileSync(join(install, '.nvmrc'), '22\n')
  // fake ~/.nvm with a node stub, so the .nvmrc branch has something to pin
  const home = join(base, 'home')
  const nvmBin = join(home, '.nvm', 'versions', 'node', 'v22.99.0', 'bin'); mkdirSync(nvmBin, { recursive: true })
  writeFileSync(join(home, '.nvm', 'nvm.sh'), '# stub\n')
  writeFileSync(join(nvmBin, 'node'), '#!/bin/sh\necho v22.99.0-nvmrc\n'); chmodSync(join(nvmBin, 'node'), 0o755)
  // fake "running dashboard" node, reachable only through the exe branch
  const exeBin = join(base, 'live', 'bin'); mkdirSync(exeBin, { recursive: true })
  writeFileSync(join(exeBin, 'node'), '#!/bin/sh\necho v24.0.0-live\n'); chmodSync(join(exeBin, 'node'), 0o755)
  // PATH stubs for the detection
  const stubs = join(base, 'stubs'); mkdirSync(stubs)
  writeFileSync(join(stubs, 'pgrep'), opts.detectExe ? '#!/bin/sh\necho 4242\n' : '#!/bin/sh\nexit 1\n')
  writeFileSync(join(stubs, 'ps'), opts.detectExe ? `#!/bin/sh\necho ${exeBin}/node\n` : '#!/bin/sh\necho node\n')
  writeFileSync(join(stubs, 'lsof'), '#!/bin/sh\nexit 1\n')
  for (const f of ['pgrep', 'ps', 'lsof']) chmodSync(join(stubs, f), 0o755)
  const script = `INSTALL_DIR='${install}'\nDIM=''\nNC=''\n` + extract()
  return execFileSync('bash', ['-c', script], {
    encoding: 'utf-8',
    env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: home },
  })
}

describe('update.sh node pin: the confirmation is only printed when it was measured (NODEPINMAC921)', () => {
  it('fallback to .nvmrc names its source and does NOT claim a match with the running dashboard', () => {
    const out = runPin({ detectExe: false })
    expect(out).toContain('Node pin: v22.99.0-nvmrc')
    expect(out).toContain('.nvmrc')
    expect(out).toContain('could NOT be detected')
    expect(out).not.toContain('matches the running dashboard')
  })

  it('the exe branch keeps its wording verbatim (positive control on the same instrument)', () => {
    const out = runPin({ detectExe: true })
    expect(out).toContain('Node pin: v24.0.0-live (matches the running dashboard, better-sqlite3 ABI)')
    expect(out).not.toContain('.nvmrc')
  })
})
