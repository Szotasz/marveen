import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// BC100FAIL810 (measured on ai-bootcamp-vps100, 2026-08-10): the Linux installer
// died with "installer exited with code 1 at step ollama-whisper" on a host
// where the ollama BINARY was installed but its SERVICE never came up (no
// ollama.service unit, API at :11434 dead). The ollama+model step is DECLARED
// optional/non-fatal (every branch warns and continues), yet it hard-failed.
//
// Cause: under `set -e`, the `status=$(curl POST /api/pull | python3 json.load)`
// assignment in ollama_pull inherits the pipeline's exit code. With the API down
// the curl body is empty, json.load raises, python3 exits non-zero, the
// assignment inherits it, and the ERR trap aborts the whole install.
//
// This test executes the REAL ollama block out of the shipped install-linux.sh
// under `set -e` + the REAL ERR trap, with the exact host shape that failed:
// ollama present, service absent, API not answering. The install must survive
// and continue. A green run against a WORKING API proves nothing here -- the
// point is to reproduce the dead-API host and take it from red to green.

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')

/** Pull the `if command -v ollama ... fi` block (defs + call) out of the script. */
function ollamaBlock(src: string): string {
  // The second `if command -v ollama` opens the service+pull block (the first is
  // the install-or-skip block just above); slice from there to its labelled fi.
  const firstIdx = src.indexOf('if command -v ollama &>/dev/null; then')
  const start = src.indexOf('if command -v ollama &>/dev/null; then', firstIdx + 1)
  const end = src.indexOf('fi  # command -v ollama')
  if (start < 0 || end < 0 || end <= start) throw new Error('ollama block not found')
  return src.slice(start, end + 'fi  # command -v ollama'.length)
}

/**
 * Run the REAL ollama block under `set -e` + the REAL ERR trap.
 * apiUp=false simulates the failing host (curl to ollama never connects);
 * apiUp=true + pullBody lets us exercise the pull path with a chosen response.
 */
function runOllamaBlock(opts: { apiUp: boolean; pullBody?: string }): { code: number; out: string } {
  const curlStub = opts.apiUp
    ? [
        'curl() {',
        '  local url="${!#}"',
        '  case "$*" in',
        '    *api/version*) return 0 ;;',
        '    *api/tags*) echo "{\\"models\\":[]}" ;;',
        `    *api/pull*) printf '%s' ${JSON.stringify(opts.pullBody ?? '')} ;;`,
        '    *) return 0 ;;',
        '  esac',
        '}',
      ]
    : [
        // Nothing listens on :11434 -- curl exits non-zero with an empty body,
        // exactly like connection-refused. This is the measured failing host.
        'curl() { return 7; }',
      ]
  const script = [
    'set -e',
    'on_error() { echo "TRAP_FIRED line $1"; exit 1; }',
    "trap 'on_error $LINENO' ERR",
    'ok() { echo "ok: $*"; }',
    'warn() { echo "warn: $*"; }',
    '_t() { echo "$1"; }',
    'sudo() { return 0; }',       // service enable is best-effort; never real here
    'seq() { command seq "$@"; }',
    'sleep() { return 0; }',      // no real waiting in the test
    // ollama is PRESENT (binary installed) -- the exact BC100 shape.
    'command() { if [ "$1" = "-v" ] && [ "$2" = "ollama" ]; then return 0; fi; builtin command "$@"; }',
    ...curlStub,
    ollamaBlock(LINUX),
    'echo REACHED_THE_END',
  ].join('\n')

  const file = join(mkdtempSync(join(tmpdir(), 'marveen-ollama-')), 'block.sh')
  writeFileSync(file, script)
  try {
    const out = execFileSync('/bin/bash', [file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('install-linux.sh: ollama+model step is non-fatal (BC100FAIL810)', () => {
  it('the measured failing host (binary present, service absent, API dead) CONTINUES', () => {
    const { code, out } = runOllamaBlock({ apiUp: false })
    expect(out).not.toContain('TRAP_FIRED')
    expect(out).toContain('REACHED_THE_END')
    expect(out).toContain('warn:')
    expect(code).toBe(0)
  })

  it('an empty / non-JSON pull response does not abort the install', () => {
    // API answers /api/version but the pull returns garbage -> json.load raises.
    // The `|| status=""` guard must catch it instead of the ERR trap.
    const { code, out } = runOllamaBlock({ apiUp: true, pullBody: '' })
    expect(out).not.toContain('TRAP_FIRED')
    expect(out).toContain('REACHED_THE_END')
    expect(out).toContain('warn:')
    expect(code).toBe(0)
  })

  it('a successful pull still reports success', () => {
    const { code, out } = runOllamaBlock({ apiUp: true, pullBody: '{"status":"success"}' })
    expect(out).not.toContain('TRAP_FIRED')
    expect(out).toContain('REACHED_THE_END')
    expect(out).toContain('ok:')
    expect(code).toBe(0)
  })
})
