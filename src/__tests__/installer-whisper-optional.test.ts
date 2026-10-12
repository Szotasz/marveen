import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The 2026-08-03 bug: the macOS installer died with
//
//     Varatlan hiba a(z) 'configuration' lepesben (sor: 982).
//
// Line 982 is the CLOSING `fi` of the whisper block -- nothing fails there.
// Whisper is an OPTIONAL dependency (video transcription); on an Intel Mac
// `pipx install mlx-whisper` cannot work at all (MLX is Apple-Silicon only) and
// the `brew install openai-whisper` fallback is a long source-ish build that can
// fail for a dozen unrelated reasons. Either way the install ended there.
//
// Two defects, both already seen elsewhere in this script (the `claude --print`
// probe at ~line 371 and the service-auth probe at ~line 672 carry the same
// comment: "blaming the enclosing `fi`"):
//
//   1. macOS ships bash 3.2, where a command that fails inside a `{ ... }` group
//      on the RHS of `||` STILL reaches the ERR trap, and $LINENO reports the
//      enclosing `fi`. So an optional dependency killed a mandatory install.
//   2. Every install command in the block was silenced with `2>/dev/null`, so
//      the operator was shown a line number and nothing else -- the actual
//      upstream error ("pipx needs uv>=0.9.17") never reached the screen or the
//      installer's own stderr log.
//
// The behavioural test below executes the REAL block out of the shipped script
// with every installer stubbed to fail, under the REAL ERR trap. The install
// must survive and continue.

const ROOT = join(__dirname, '..', '..')
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')

/** Pull the whisper section out of the script so it can be executed for real. */
function whisperBlock(src: string): string {
  const start = src.indexOf('# Whisper (speech-to-text')
  const end = src.indexOf('# ffmpeg (audio/video processing)')

  if (start < 0 || end < 0 || end <= start) throw new Error('whisper block not found')

  return src.slice(start, end)
}

/**
 * Run the REAL whisper block under `set -e` + the REAL ERR trap, with pipx and
 * brew stubbed to the chosen exit code. Returns the script's status and output.
 */
function runWhisperBlock(installerRc: number, stderrMsg = ''): { code: number; out: string } {
  const script = [
    'set -e',
    // The installer's own trap, verbatim in spirit: report and abort.
    'on_error() { echo "TRAP_FIRED line $1"; exit 1; }',
    'trap \'on_error $LINENO\' ERR',
    'GREEN=""; ORANGE=""; RED=""; NC=""; DIM=""',
    '_t() { echo "$1"; }',
    'ok() { echo "ok: $*"; }',
    'warn() { echo "warn: $*"; }',
    // No whisper is installed; pipx/brew exist but every attempt fails. A
    // `command` function shadows the builtin, so this holds whatever the test
    // machine happens to have on its PATH.
    'HOME="$(mktemp -d)"',
    'command() {',
    '  if [ "$1" = "-v" ]; then',
    '    case "$2" in mlx_whisper|whisper) return 1 ;; pipx|brew) return 0 ;; esac',
    '  fi',
    '  builtin command "$@"',
    '}',
    `pipx() { ${stderrMsg ? `echo "${stderrMsg}" >&2;` : ''} return ${installerRc}; }`,
    `brew() { ${stderrMsg ? `echo "${stderrMsg}" >&2;` : ''} return ${installerRc}; }`,
    whisperBlock(MACOS),
    'echo REACHED_THE_END',
  ].join('\n')

  const file = join(mkdtempSync(join(tmpdir(), 'marveen-whisper-')), 'block.sh')
  writeFileSync(file, script)

  try {
    // /bin/bash deliberately: that is bash 3.2 on macOS, the shell the shipped
    // installer actually runs under and the only one that shows defect (1).
    const out = execFileSync('/bin/bash', [file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('install-macos.sh: whisper is an optional dependency', () => {
  it('continues the install when every whisper installer fails', () => {
    const { code, out } = runWhisperBlock(1, 'pipx needs uv>=0.9.17')

    expect(out).not.toContain('TRAP_FIRED')
    expect(out).toContain('REACHED_THE_END')
    expect(code).toBe(0)
  })

  it('tells the operator whisper was skipped instead of failing silently', () => {
    const { out } = runWhisperBlock(1)

    expect(out.toLowerCase()).toMatch(/whisper/)
    expect(out).toContain('warn:')
  })

  it('does not swallow the installer error that explains the skip', () => {
    // `2>/dev/null` on the pipx/brew calls is what reduced a real, actionable
    // upstream message to a bare line number.
    const code = whisperBlock(MACOS)
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))

    expect(code.filter((l) => l.includes('2>/dev/null'))).toEqual([])
  })

  it('still reports success when an installer works', () => {
    const { code, out } = runWhisperBlock(0)

    expect(out).toContain('REACHED_THE_END')
    expect(out).toContain('✓')
    expect(out).not.toContain('warn:')
    expect(code).toBe(0)
  })
})
