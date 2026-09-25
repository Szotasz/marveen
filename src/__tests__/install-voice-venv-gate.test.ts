import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Step 2 is re-run on every install attempt, so its idempotency gate decides
// whether a broken install can ever recover. The gate used to be
// `[[ ! -d "$DEST/venv" ]]`, which asks whether the DIRECTORY exists rather than
// whether the venv WORKS. An interrupted or partial earlier run can leave a
// few-kilobyte venv stub behind -- a bin/ holding the python symlinks and no pip
// at all -- and `-d` is true for it. Step 2 is then skipped on every single run,
// and step 3 dies on
//
//     .../venv/bin/pip: No such file or directory
//
// Retrying cannot help: each attempt takes the same SKIP.
//
// These tests execute the REAL step 2 out of the shipped script (with a stubbed
// DEST) rather than re-describing it, because the fault is invisible at the
// level of reading the condition.

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'install-voice.sh')
const SRC = readFileSync(SCRIPT, 'utf-8')

/** Slice one `# --- Step N: ... ---` block out of the installer. */
function sliceStep(src: string, header: string, nextHeader: string): string {
  const start = src.indexOf(header)
  if (start < 0) throw new Error(`step header not found: ${header}`)
  const end = src.indexOf(nextHeader, start)
  if (end < 0) throw new Error(`next step header not found: ${nextHeader}`)
  return src.slice(start, end)
}

const STEP2 = sliceStep(SRC, '# --- Step 2: Python venv ---', '# --- Step 3:')

/**
 * Run the REAL step 2 against a scratch DEST. Only the four echo helpers and
 * DEST are stubbed; the gate and the venv creation are the shipped lines.
 */
function runStep2(dest: string): { code: number; out: string } {
  const script = [
    'set -euo pipefail',
    `DEST=${JSON.stringify(dest)}`,
    '_pass() { echo "    [PASS] $*"; }',
    '_skip() { echo "    [SKIP] $*"; }',
    '_fail() { echo "    [FAIL] $*" >&2; exit 1; }',
    '_step() { echo ""; echo "==> $*"; }',
    STEP2,
  ].join('\n')
  try {
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

/** Reproduce the stub a partial install leaves: bin/ has python, but no pip. */
function makeBrokenVenv(dest: string): void {
  const bin = join(dest, 'venv', 'bin')
  mkdirSync(bin, { recursive: true })
  const python3 = execFileSync('bash', ['-c', 'command -v python3'], { encoding: 'utf-8' }).trim()
  symlinkSync(python3, join(bin, 'python'))
  symlinkSync(python3, join(bin, 'python3'))
  writeFileSync(join(dest, 'venv', 'pyvenv.cfg'), 'home = /usr/bin\n')
}

/** A healthy-looking venv that must NOT be rebuilt: bin/pip is executable. */
function makeWorkingVenv(dest: string): void {
  const bin = join(dest, 'venv', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'pip'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'pip'), 0o755)
  writeFileSync(join(dest, 'venv', 'SENTINEL'), 'do not rebuild me\n')
}

/** Stand in for the 2 x 63 MB downloaded models: expensive, must survive. */
function makeVoices(dest: string): string {
  const voices = join(dest, 'voices')
  mkdirSync(voices, { recursive: true })
  const model = join(voices, 'hu_HU-imre-medium.onnx')
  writeFileSync(model, 'expensive bytes\n')
  return model
}

describe('install-voice.sh step 2 venv gate', () => {
  beforeAll(() => {
    // python3 with a usable venv module is what step 2 calls; without it these
    // tests would measure the environment, not the gate.
    execFileSync('bash', ['-c', 'python3 -m venv --help'], { stdio: 'ignore' })
  })

  it('rebuilds a venv that exists but has no pip (the 09-21 regression)', () => {
    const dest = mkdtempSync(join(tmpdir(), 'voice-broken-'))
    makeBrokenVenv(dest)
    expect(existsSync(join(dest, 'venv', 'bin', 'python'))).toBe(true)
    expect(existsSync(join(dest, 'venv', 'bin', 'pip'))).toBe(false)

    const r = runStep2(dest)

    expect(r.code).toBe(0)
    // Step 3 calls venv/bin/pip directly; that is the only outcome that counts.
    expect(existsSync(join(dest, 'venv', 'bin', 'pip'))).toBe(true)
    expect(r.out).not.toContain('[SKIP] venv exists')
  })

  it('keeps the downloaded voice models when it rebuilds the venv', () => {
    const dest = mkdtempSync(join(tmpdir(), 'voice-scope-'))
    makeBrokenVenv(dest)
    const model = makeVoices(dest)

    const r = runStep2(dest)

    expect(r.code).toBe(0)
    // Both halves matter. The rebuild must happen (otherwise this assertion is
    // a tautological pass -- the old gate removed nothing, so the model also
    // survived), and it must not reach outside $DEST/venv while doing it.
    expect(existsSync(join(dest, 'venv', 'bin', 'pip'))).toBe(true)
    expect(existsSync(model)).toBe(true)
    expect(readFileSync(model, 'utf-8')).toBe('expensive bytes\n')
  })

  it('leaves a working venv untouched (idempotency is still the point)', () => {
    const dest = mkdtempSync(join(tmpdir(), 'voice-ok-'))
    makeWorkingVenv(dest)

    const r = runStep2(dest)

    expect(r.code).toBe(0)
    expect(r.out).toContain('[SKIP] venv exists')
    // A rebuild would have wiped the directory, sentinel and all.
    expect(existsSync(join(dest, 'venv', 'SENTINEL'))).toBe(true)
  })

  it('creates the venv when nothing is there yet', () => {
    const dest = mkdtempSync(join(tmpdir(), 'voice-empty-'))

    const r = runStep2(dest)

    expect(r.code).toBe(0)
    expect(existsSync(join(dest, 'venv', 'bin', 'pip'))).toBe(true)
  })
})
