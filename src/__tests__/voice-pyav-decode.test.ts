import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// VOICEPYAV930: faster-whisper 1.2.1 decodes a file PATH with
// av.open(..., metadata_errors="ignore"), and PyAV 19 removed that keyword, so
// a fresh install-voice.sh (which resolved av 19.0.0) failed every voice
// message with "TypeError: open() got an unexpected keyword argument
// 'metadata_errors'" (measured 2026-09-30).
//
// Two nets, both pinned here:
// 1. scripts/voice/_vtools.py decodes with ffmpeg and hands transcribe() a
//    numpy array, so faster-whisper's PyAV decoder is never reached. Every
//    model.transcribe(...) call site must take _decode_audio(...) as its
//    audio: one site left on a path is the bug back on that path.
// 2. install-voice.sh pins av<19, and its step-3 skip gate re-installs a venv
//    that already resolved av 19 (otherwise the pin never reaches an existing
//    install). The gate is executed for real against a stubbed venv.
//
// The behavioural decode test (real ffmpeg, real numpy) is
// scripts/voice/test_vtools_decode.py; it needs the voice venv.
const ROOT = join(__dirname, '..', '..')
const VTOOLS = join(ROOT, 'scripts', 'voice', '_vtools.py')
const INSTALLER = join(ROOT, 'scripts', 'install-voice.sh')

/** First positional argument of every `.transcribe(` call, paren-balanced. */
function transcribeFirstArgs(body: string): string[] {
  const out: string[] = []
  const open = '.transcribe('
  let from = 0
  while (true) {
    const at = body.indexOf(open, from)
    if (at < 0) break
    let depth = 0
    let i = at + open.length
    const start = i
    while (i < body.length) {
      const c = body[i]
      if (c === '(') depth++
      else if (c === ')') {
        if (depth === 0) break
        depth--
      } else if (c === ',' && depth === 0) break
      i++
    }
    out.push(body.slice(start, i).trim())
    from = i
  }
  return out
}

describe('VOICEPYAV930: transcribe() never gets a file path', () => {
  const body = readFileSync(VTOOLS, 'utf-8')
  const args = transcribeFirstArgs(body)

  it('finds both known call sites (live path and canary)', () => {
    expect(args.length).toBeGreaterThanOrEqual(2)
  })

  it.each(args.map((a, i) => [i + 1, a] as const))('call site %i passes decoded samples: %s', (_n, arg) => {
    expect(arg.startsWith('_decode_audio(')).toBe(true)
  })

  it('decodes to 16 kHz mono s16le with ffmpeg', () => {
    const fn = body.slice(body.indexOf('def _decode_audio('), body.indexOf('def _whisper('))
    expect(fn).toContain('"ffmpeg"')
    expect(fn).toContain('"-ac", "1"')
    expect(fn).toContain('WHISPER_SAMPLE_RATE')
    expect(fn).toContain('"s16le"')
    expect(body).toMatch(/^WHISPER_SAMPLE_RATE = 16000$/m)
  })

  // PR #1887 review point 1: a host whose PATH lacks ffmpeg transcribed fine on
  // av < 19 (PyAV decodes on its own), so a missing ffmpeg must hand the path
  // back with one stderr line, not die with FileNotFoundError. The behaviour is
  // driven for real in test_vtools_decode.py; this pins the shape in CI.
  it('falls back to the path, with one stderr line, when ffmpeg is missing', () => {
    const fn = body.slice(body.indexOf('def _decode_audio('), body.indexOf('def _whisper('))
    expect(body).toContain(
      `_FFMPEG_MISSING_MSG = "ffmpeg not found on PATH, falling back to faster-whisper's own decoder"`,
    )
    expect(fn).toContain('shutil.which("ffmpeg")')
    expect(fn).toMatch(/_FFMPEG_FALLBACK_DIRS = \("\/opt\/homebrew\/bin", "\/usr\/local\/bin"\)/)
    expect(fn).toContain('except FileNotFoundError:')
    expect((fn.match(/print\(_FFMPEG_MISSING_MSG, file=sys\.stderr, flush=True\)\n\s+return path\n/g) ?? []).length).toBe(2)
  })
})

const SRC = readFileSync(INSTALLER, 'utf-8')
const STEP3 = (() => {
  const start = SRC.indexOf('# --- Step 3: Python packages ---')
  const end = SRC.indexOf('# --- Step 4:', start)
  if (start < 0 || end < 0) throw new Error('step 3 block not found in install-voice.sh')
  return SRC.slice(start, end)
})()

/**
 * A venv whose python is the host python3 with stub faster_whisper / piper / av
 * packages on its path, and whose pip only records its argv.
 */
function makeVenv(avVersion: string | null): { dest: string; pipLog: string } {
  const dest = mkdtempSync(join(tmpdir(), 'voice-pyav-'))
  const bin = join(dest, 'venv', 'bin')
  const site = join(dest, 'site')
  mkdirSync(bin, { recursive: true })
  for (const pkg of ['faster_whisper', 'piper']) {
    mkdirSync(join(site, pkg), { recursive: true })
    writeFileSync(join(site, pkg, '__init__.py'), '')
  }
  if (avVersion) {
    mkdirSync(join(site, 'av'), { recursive: true })
    writeFileSync(join(site, 'av', '__init__.py'), `__version__ = ${JSON.stringify(avVersion)}\n`)
  }
  const python3 = execFileSync('bash', ['-c', 'command -v python3'], { encoding: 'utf-8' }).trim()
  writeFileSync(join(bin, 'python'), `#!/bin/sh\nPYTHONPATH=${JSON.stringify(site)} exec ${JSON.stringify(python3)} "$@"\n`)
  const pipLog = join(dest, 'pip.log')
  writeFileSync(join(bin, 'pip'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(pipLog)}\n`)
  chmodSync(join(bin, 'python'), 0o755)
  chmodSync(join(bin, 'pip'), 0o755)
  return { dest, pipLog }
}

function runStep3(dest: string): { code: number; out: string } {
  const script = [
    'set -euo pipefail',
    `DEST=${JSON.stringify(dest)}`,
    '_pass() { echo "    [PASS] $*"; }',
    '_skip() { echo "    [SKIP] $*"; }',
    '_fail() { echo "    [FAIL] $*" >&2; exit 1; }',
    '_step() { echo ""; echo "==> $*"; }',
    STEP3,
  ].join('\n')
  try {
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

describe('VOICEPYAV930: install-voice.sh step 3 pins PyAV below 19', () => {
  it('re-installs under the pin when the venv already resolved av 19 (the 09-30 venv)', () => {
    const { dest, pipLog } = makeVenv('19.0.0')
    const r = runStep3(dest)
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('[SKIP] packages already installed')
    expect(readFileSync(pipLog, 'utf-8').split('\n')).toContain('av>=11,<19')
  })

  it('installs with the pin on a fresh venv', () => {
    const { dest, pipLog } = makeVenv(null)
    const r = runStep3(dest)
    // pip is a stub, so the final import check still sees no av -- that is fine,
    // it only checks faster_whisper and piper.
    expect(r.code).toBe(0)
    expect(readFileSync(pipLog, 'utf-8').split('\n')).toEqual(
      expect.arrayContaining(['faster-whisper', 'piper-tts', 'av>=11,<19']),
    )
  })

  it('skips a venv that already has av 18 (idempotency)', () => {
    const { dest, pipLog } = makeVenv('18.1.0')
    const r = runStep3(dest)
    expect(r.code).toBe(0)
    expect(r.out).toContain('[SKIP] packages already installed')
    expect(existsSync(pipLog)).toBe(false)
  })
})
