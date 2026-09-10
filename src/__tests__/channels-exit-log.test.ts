import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// CHEXIT910: channels.sh has SEVEN exit-0 paths and zero exit logging --
// channels-failures.log records only failures, so a clean self-exit left no
// trace anywhere (hermes, 2026-09-09 20:25:03: main process exited 0,
// Restart=on-failure did not restart, supervisor lost, nothing to read).
// The EXIT trap closes that: every code-path exit writes a row.
//
// The positive control here is Marveen's explicit stipulation (msg 23453): a
// deliberate exit through the test seam MUST produce a row -- a silent log is
// indistinguishable from "no exit happened", so the proof is a written line,
// never the trap's presence in the source alone. The source assertions below
// are secondary pins on placement, not the proof.

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'channels.sh')
const CHANNELS = readFileSync(SCRIPT, 'utf-8')

function runExitProbe(code: string, logPath: string): number {
  try {
    execFileSync('bash', [SCRIPT, '--exit-probe', code], {
      encoding: 'utf-8',
      env: { ...process.env, CHANNELS_EXITS_LOG: logPath },
    })
    return 0
  } catch (e) {
    return (e as { status?: number }).status ?? -1
  }
}

describe('channels.sh exit logging (CHEXIT910)', () => {
  // CHEXITLINE910: the line must be the exit's OWN source line -- `line=\d+`
  // alone let line=1 pass on bash 5 (where $LINENO in a trap string is always
  // 1), which is exactly the value that cannot say which exit path ran. The
  // expected number is read from the script source, so the pin survives edits
  // above the seam.
  const probeExitLine = CHANNELS.slice(0, CHANNELS.indexOf('exit "${2:-0}"')).split('\n').length

  it('POSITIVE CONTROL: a deliberate exit 0 writes a row with the REAL exit line -- the invisible class', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chexit-'))
    try {
      const log = join(dir, 'exits.log')
      expect(runExitProbe('0', log)).toBe(0)
      expect(existsSync(log)).toBe(true)
      const rows = readFileSync(log, 'utf-8').trim().split('\n')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatch(new RegExp(`channels\\.sh exit code=0 line=${probeExitLine} cmd=\\[exit "\\$\\{2:-0\\}"\\] pid=\\d+`))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a non-zero exit is recorded with ITS code and line, and the trap does not clobber the exit status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chexit-'))
    try {
      const log = join(dir, 'exits.log')
      expect(runExitProbe('7', log)).toBe(7)
      expect(readFileSync(log, 'utf-8')).toMatch(new RegExp(`exit code=7 line=${probeExitLine} `))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the DEBUG tracker preserves $? for the script itself (real tracker source, sliced)', () => {
    // A tracker that ate $? would silently rewrite every `if [ $? -eq 0 ]`
    // decision in the script -- worse than the bug it fixes. Run the REAL
    // tracker (sliced from the source, same pattern as the never-started
    // tests) with a failing command and read $? on the next line.
    const fnStart = CHANNELS.indexOf('chexit_track() {')
    const fnEnd = CHANNELS.indexOf('\n}', fnStart)
    const tracker = CHANNELS.slice(fnStart, fnEnd + 2)
    const dir = mkdtempSync(join(tmpdir(), 'chexit-'))
    try {
      const probe = join(dir, 'probe.sh')
      writeFileSync(probe, [
        '#!/bin/bash',
        'set -o functrace',
        tracker,
        'trap chexit_track DEBUG',
        'false',
        'echo "status=$?"',
      ].join('\n') + '\n')
      const out = execFileSync('bash', [probe], { encoding: 'utf-8' }).trim()
      expect(out).toBe('status=1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the trap sits AFTER the store-free test seams and BEFORE the exit-probe seam', () => {
    const lastSeam = CHANNELS.indexOf('--classify-unlock-residue')
    const trapAt = CHANNELS.indexOf("trap 'record_channels_exit")
    const probeAt = CHANNELS.indexOf('--exit-probe')
    expect(lastSeam).toBeGreaterThan(-1)
    expect(trapAt).toBeGreaterThan(lastSeam)
    expect(probeAt).toBeGreaterThan(trapAt)
  })

  it('seams before the trap stay store-free: a seam invocation writes NO exit row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chexit-'))
    try {
      const log = join(dir, 'exits.log')
      execFileSync('bash', [SCRIPT, '--classify-unlock-residue'], {
        encoding: 'utf-8',
        input: '/mcp',
        env: { ...process.env, CHANNELS_EXITS_LOG: log },
      })
      expect(existsSync(log)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exit rows go to their own log, never into channels-failures.log', () => {
    // A clean exit 0 rendered as a "failure" row would misclassify for the
    // next reader (Marveen msg 23453) -- the handler must reference only the
    // dedicated target.
    const fnStart = CHANNELS.indexOf('record_channels_exit() {')
    const fnEnd = CHANNELS.indexOf('\n}', fnStart)
    const fn = CHANNELS.slice(fnStart, fnEnd)
    expect(fn).toContain('CHANNELS_EXITS_LOG')
    expect(fn).not.toContain('channels-failures.log')
    expect(CHANNELS).toContain('CHANNELS_EXITS_LOG="${CHANNELS_EXITS_LOG:-$INSTALL_DIR/store/channels-exits.log}"')
  })
})
