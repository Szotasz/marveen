// GROMZORAPIDREADY1109 (Samu 73998): channels.sh's rapid-failure brake no longer counts a planned "gromzo ready" exit.
// Measured on the QA VPS 11-09: every ready exit was "rapid-exit after 5s reason=gromzo-ready", the 3rd and 4th
// waited 60 s, the 5th 300 s, and the run ended as exit 1 FAILURE. The REAL exit block of channels.sh runs here with
// a temp install dir; `sleep` is a stub that only says how long it would wait.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const CHANNELS = readFileSync(join(__dirname, '..', '..', 'scripts', 'channels.sh'), 'utf8')
const START = 'ELAPSED=$(( $(date +%s) - START_TS ))\n'
const END_MARK = '# GROMZORAPIDREADY1109: except the "gromzo ready" exit'
const a = CHANNELS.indexOf(START)
const b = CHANNELS.indexOf('\nexit 0\n', CHANNELS.indexOf(END_MARK))
const EXIT_BLOCK = CHANNELS.slice(a, b + '\nexit 0\n'.length)
const RAPID_FN = CHANNELS.slice(CHANNELS.indexOf('rapid_exit_log_line() {'), CHANNELS.indexOf('\n}\n', CHANNELS.indexOf('rapid_exit_log_line() {')) + 3)

function run(o: { reason: string; elapsed: number; restart: boolean; priorRapid: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'gz-rapid-'))
  mkdirSync(join(dir, 'store'))
  const log = join(dir, 'store', 'channels-failures.log')
  if (o.priorRapid > 0) writeFileSync(log, Array.from({ length: o.priorRapid }, () => '2026-11-09 09:00:00 rapid-exit after 5s reason=plugin-died\n').join(''))
  const r = spawnSync('bash', ['-c', [
    RAPID_FN,
    'sleep() { echo "SLEPT $1"; }',
    `INSTALL_DIR='${dir}' START_TS=$(( $(date +%s) - ${o.elapsed} )) EXIT_REASON='${o.reason}' RESTART_REQUESTED=${o.restart ? 1 : 0} PANE_EXIT_STATUS=''`,
    EXIT_BLOCK,
  ].join('\n')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })
  return { status: r.status, out: r.stdout + r.stderr, log: existsSync(log) ? readFileSync(log, 'utf8') : null }
}

describe('the exit block slice is the one intended', () => {
  it('starts at ELAPSED, ends at its own exit 0, and holds only the brake and the exit codes', () => {
    expect(a).toBeGreaterThan(0)
    expect(EXIT_BLOCK.startsWith(START)).toBe(true)
    expect(EXIT_BLOCK.endsWith('\nexit 0\n')).toBe(true)
    expect(EXIT_BLOCK).toContain('rapid failures detected. Waiting 300s')
    expect(EXIT_BLOCK).not.toMatch(/\b(tmux|systemctl|launchctl|kill|claude)\b/)
  })
})

describe('a gromzo-ready exit is never a rapid failure (GROMZORAPIDREADY1109)', () => {
  it('after 5 s with 4 earlier rapid exits: no warning, no wait, exit 0, the counter cleared', () => {
    const r = run({ reason: 'gromzo-ready', elapsed: 5, restart: true, priorRapid: 4 })
    expect(r.out).not.toMatch(/exited after|rapid failures|SLEPT/)
    expect(r.status).toBe(0)
    expect(r.log).toBeNull()
  })
  it('five gromzo-ready exits in a row: never a wait, never exit 1', () => {
    for (let i = 0; i < 5; i++) {
      const r = run({ reason: 'gromzo-ready', elapsed: 5, restart: true, priorRapid: i })
      expect(r.out).not.toContain('SLEPT')
      expect(r.status).toBe(0)
    }
  })
  it('a long-running session that exits gromzo-ready: exit 0 too', () => {
    expect(run({ reason: 'gromzo-ready', elapsed: 300, restart: true, priorRapid: 0 }).status).toBe(0)
  })
})

describe('a real rapid failure still counts, as before', () => {
  it('plugin-died after 5 s with 4 earlier: the 5th -> 300 s wait, exit 1, logged with its reason', () => {
    const r = run({ reason: 'plugin-died', elapsed: 5, restart: true, priorRapid: 4 })
    expect(r.out).toContain('exited after 5s')
    expect(r.out).toContain('SLEPT 300')
    expect(r.status).toBe(1)
    expect(r.log).toMatch(/rapid-exit after 5s reason=plugin-died\n$/)
  })
  it('the 3rd rapid failure -> 60 s', () => {
    expect(run({ reason: 'session-gone', elapsed: 3, restart: false, priorRapid: 2 }).out).toContain('SLEPT 60')
  })
  it('another restart reason after a long run still ends exit 1 (not a clean finish)', () => {
    expect(run({ reason: 'plugin-never-started', elapsed: 700, restart: true, priorRapid: 0 }).status).toBe(1)
  })
})
