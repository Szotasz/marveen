import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The 2026-08-03 bug: `install.sh` printed "Marveen sikeresen telepitve!" and the
// dashboard never came up. `launchctl list` showed com.marveen.dashboard with no
// pid and last exit status 1; store/dashboard.error.log was EMPTY and the real
// cause sat in the stdout log:
//
//   better_sqlite3.node was compiled against NODE_MODULE_VERSION 141.
//   This version of Node.js requires NODE_MODULE_VERSION 127.
//
// Two steps of the same script disagreed about which Node this install targets:
//
//   * step "npm-install" (~line 528) runs `npm install` + `npm rebuild
//     better-sqlite3 --build-from-source` under WHATEVER `node` is on the
//     operator's PATH -- v25/v26 on a current machine, ABI 141.
//   * step "launchagent" (~line 1106) then deliberately pins the launchd units
//     to brew node@22 (ABI 127), for the documented reason that the generic
//     `node` symlink auto-upgrades and breaks the prebuilt better-sqlite3.
//
// So the pin worked exactly as designed and the native module was built for the
// wrong runtime anyway -- the services got a Node the module was never compiled
// for. `channels` survived (no DB), the dashboard died on first require, and
// because the token file is written on first successful boot, store/
// .dashboard-token was never created either.
//
// The resolution of the service Node must therefore happen BEFORE the native
// module is built, and the build must run under that Node.

const ROOT = join(__dirname, '..', '..')
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')

/**
 * Pull a shell function out of the script. Returns '' when absent, so the
 * harness reproduces the pre-fix script rather than blowing up on it.
 */
function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)

  if (start < 0) return ''

  let i = src.indexOf('{', start) + 1
  let depth = 1

  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }

  return src.slice(start, i)
}

function stepBlock(src: string, step: string, nextStep: string): string {
  const start = src.indexOf(`INSTALL_STEP="${step}"`)
  const end = src.indexOf(`INSTALL_STEP="${nextStep}"`)

  if (start < 0 || end < 0 || end <= start) throw new Error(`step ${step} not found`)

  return src.slice(start, end)
}

/**
 * Run the REAL npm-install step with `npm` stubbed by a script that records the
 * `node` it would resolve. Returns whichever node each npm invocation saw.
 */
function runNpmInstallStep(): { code: number; out: string; nodes: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-nodeabi-'))
  const log = join(dir, 'resolved-node.log')

  // A fake `node@22` keg and a fake generic `node`, both on PATH. The generic
  // one comes FIRST, exactly like an operator with a current Node installed.
  const keg = join(dir, 'opt', 'node@22', 'bin')
  const generic = join(dir, 'generic', 'bin')
  mkdirSync(keg, { recursive: true })
  mkdirSync(generic, { recursive: true })

  for (const [d, label] of [[keg, 'node22'], [generic, 'generic-node26']] as const) {
    const p = join(d, 'node')
    writeFileSync(p, `#!/bin/bash\necho ${label}\n`)
    chmodSync(p, 0o755)
  }

  // `npm` records which node it resolves through the PATH it was handed --
  // that is precisely the runtime the native module gets compiled against.
  const npm = join(generic, 'npm')
  writeFileSync(npm, `#!/bin/bash\necho "$* -> $(node)" >> ${log}\nexit 0\n`)
  chmodSync(npm, 0o755)

  const script = [
    'set -e',
    'on_error() { echo "TRAP_FIRED line $1"; exit 1; }',
    'trap \'on_error $LINENO\' ERR',
    'GREEN=""; ORANGE=""; RED=""; NC=""; DIM=""; BOLD=""',
    '_t() { echo "$1"; }',
    'ok() { echo "ok: $*"; }',
    'warn() { echo "warn: $*"; }',
    'fail() { echo "fail: $*"; exit 9; }',
    `INSTALL_DIR="${dir}"`,
    `PATH="${generic}:/usr/bin:/bin"`,
    // brew reports the fake keg, the way it does on a machine that has node@22.
    `brew() { if [ "$1" = "--prefix" ] && [ "$2" = "node@22" ]; then echo "${join(dir, 'opt', 'node@22')}"; return 0; fi; return 0; }`,
    'git() { echo 0000000000000000000000000000000000000000; }',
    // The helper lives just above the step in the script; the slice starts at
    // the step marker, so carry it in explicitly.
    sliceShellFn(MACOS, 'resolve_service_node'),
    stepBlock(MACOS, 'npm-install', 'configuration'),
    'echo REACHED_THE_END',
  ].join('\n')

  const file = join(dir, 'step.sh')
  writeFileSync(file, script)

  let code = 0
  let out = ''

  try {
    out = execFileSync('/bin/bash', [file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    code = err.status ?? -1
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }

  let nodes: string[] = []
  try {
    nodes = readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean)
  } catch {
    nodes = []
  }

  return { code, out, nodes }
}

describe('install-macos.sh: the native module must be built for the SERVICE node', () => {
  it('builds better-sqlite3 under node@22, not the generic node on PATH', () => {
    const { nodes } = runNpmInstallStep()

    const rebuild = nodes.find((l) => l.includes('rebuild') && l.includes('better-sqlite3'))

    expect(rebuild, `npm rebuild never ran; saw: ${JSON.stringify(nodes)}`).toBeDefined()
    expect(rebuild).toContain('node22')
  })

  it('installs dependencies under the same node the services will run', () => {
    const { nodes } = runNpmInstallStep()

    const install = nodes.find((l) => l.startsWith('install'))

    expect(install, `npm install never ran; saw: ${JSON.stringify(nodes)}`).toBeDefined()
    expect(install).toContain('node22')
  })

  it('completes the step without tripping the ERR trap', () => {
    const { code, out } = runNpmInstallStep()

    expect(out).not.toContain('TRAP_FIRED')
    expect(out).toContain('REACHED_THE_END')
    expect(code).toBe(0)
  })

  it('resolves the service node BEFORE it compiles the native module', () => {
    // Source-level guard on the ordering itself: the launchagent step already
    // pins the units to node@22, and that pin is worthless if the module was
    // compiled earlier against something else.
    const resolve = MACOS.indexOf('resolve_service_node() {')
    const rebuild = MACOS.indexOf('npm rebuild better-sqlite3 --build-from-source')

    expect(resolve, 'no resolve_service_node helper').toBeGreaterThan(-1)
    expect(rebuild).toBeGreaterThan(-1)
    expect(resolve).toBeLessThan(rebuild)
  })
})
