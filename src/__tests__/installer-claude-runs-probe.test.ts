import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// CLIRUNSVERZIO923. install-linux.sh and scripts/fix-avx.sh decide "the
// installed claude actually launches" with `_claude_runs`. It used to run
// `claude --version`, and on the AVX-less pilot VPS (measured 2026-09-23) the
// 2.1.200+ Bun ELF answers `--version` with exit 0 and then spins silently on a
// real prompt -- so a host that already carried a latest claude passed the gate
// and got an install on which no agent prompt ever runs. The probe is now a
// real, auth-free `-p` prompt with a timeout. These tests execute the REAL
// functions sliced out of the shipped scripts against mock `claude` binaries
// that reproduce the three measured classes (healthy: exit 1 in ~2 s with a
// "Not logged in" JSON; spin: --version ok, -p hangs; crash: SIGILL).

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
const FIXAVX = readFileSync(join(ROOT, 'scripts', 'fix-avx.sh'), 'utf-8')
const HAVE_TIMEOUT = (() => { try { execFileSync('sh', ['-c', 'command -v timeout'], { stdio: 'ignore' }); return true } catch { return false } })()

function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`function ${name} not found`)
  let i = src.indexOf('{', start) + 1
  let depth = 1
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  return src.slice(start, i)
}

type MockKind = 'healthy' | 'spin' | 'crash'

/** A PATH dir holding a mock `claude` of the given class; -p records its environment. */
function mockClaude(kind: MockKind, envLog: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'clirv-'))
  const body = [
    '#!/bin/bash',
    'if [ "$1" = "--version" ]; then echo "2.1.280 (Claude Code)"; exit 0; fi',
    `if [ "$1" = "-p" ]; then printf 'CFG=%s\\nOAUTH=%s\\nAPIKEY=%s\\nAUTHTOK=%s\\n' "\${CLAUDE_CONFIG_DIR:-}" "\${CLAUDE_CODE_OAUTH_TOKEN:-unset}" "\${ANTHROPIC_API_KEY:-unset}" "\${ANTHROPIC_AUTH_TOKEN:-unset}" > "${envLog}"`,
    kind === 'healthy'
      ? '  echo \'{"type":"result","is_error":true,"result":"Not logged in"}\'; exit 1'
      : kind === 'spin'
        ? '  sleep 60; exit 0'
        : '  kill -ILL $$',
    'fi',
    'exit 0',
  ].join('\n')
  writeFileSync(join(dir, 'claude'), body + '\n')
  chmodSync(join(dir, 'claude'), 0o755)
  return dir
}

/** Run the REAL _claude_runs (from the given script) with the mock dir first on PATH. */
function runProbe(src: string, pathDir: string, extraEnv: Record<string, string> = {}): number {
  const script = [
    'warn() { echo "warn: $*"; }',
    sliceShellFn(src, '_claude_runs'),
    'if _claude_runs; then echo RUNS; exit 0; else echo NO; exit 3; fi',
  ].join('\n')
  try {
    execFileSync('bash', ['-c', script], {
      env: { ...process.env, PATH: `${pathDir}:${process.env.PATH}`, CLAUDE_PROBE_TIMEOUT: '2', ...extraEnv },
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return 0
  } catch (err: any) {
    return err.status ?? 1
  }
}

/** The OLD instrument (`--version` with a timeout), kept only as the control. */
function runOldGate(pathDir: string): number {
  try {
    execFileSync('bash', ['-c', 'command -v claude >/dev/null 2>&1 && timeout 2 claude --version </dev/null >/dev/null 2>&1'], {
      env: { ...process.env, PATH: `${pathDir}:${process.env.PATH}` }, stdio: 'ignore',
    })
    return 0
  } catch (err: any) { return err.status ?? 1 }
}

describe.skipIf(!HAVE_TIMEOUT)('_claude_runs is a real launch probe, not --version', () => {
  for (const [label, src] of [['install-linux.sh', LINUX], ['scripts/fix-avx.sh', FIXAVX]] as const) {
    describe(label, () => {
      it('spin class (--version exits 0, -p hangs): NO -- and the old --version gate said RUNS', () => {
        const log = join(mkdtempSync(join(tmpdir(), 'clirv-log-')), 'env')
        const dir = mockClaude('spin', log)
        expect(runProbe(src, dir)).toBe(3)
        expect(runOldGate(dir), 'instrument control: the old gate is fooled by this class').toBe(0)
      })
      it('healthy class (-p exits 1 fast with the Not-logged-in JSON): RUNS, auth-free, isolated config dir, cleaned up', () => {
        const log = join(mkdtempSync(join(tmpdir(), 'clirv-log-')), 'env')
        const dir = mockClaude('healthy', log)
        expect(runProbe(src, dir, { CLAUDE_CODE_OAUTH_TOKEN: 'leak-oauth', ANTHROPIC_API_KEY: 'leak-key', ANTHROPIC_AUTH_TOKEN: 'leak-tok' })).toBe(0)
        const seen = Object.fromEntries(readFileSync(log, 'utf-8').trim().split('\n').map(l => l.split('=', 2)))
        expect(seen.OAUTH).toBe('unset')
        expect(seen.APIKEY).toBe('unset')
        expect(seen.AUTHTOK).toBe('unset')
        expect(seen.CFG).not.toBe('')
        expect(seen.CFG).not.toContain('/.claude')
        expect(existsSync(seen.CFG), 'the probe config dir is removed afterwards').toBe(false)
      })
      it('crash class (SIGILL on -p): NO', () => {
        const log = join(mkdtempSync(join(tmpdir(), 'clirv-log-')), 'env')
        expect(runProbe(src, mockClaude('crash', log))).toBe(3)
      })
      it('no claude on PATH: NO', () => {
        const empty = mkdtempSync(join(tmpdir(), 'clirv-empty-'))
        expect(runProbe(src, empty, { PATH: `${empty}:/usr/bin:/bin` })).toBe(3)
      })
    })
  }
  it('the probe function is the same text in both scripts and never decides on --version', () => {
    const a = sliceShellFn(LINUX, '_claude_runs')
    const b = sliceShellFn(FIXAVX, '_claude_runs')
    expect(a).toBe(b)
    expect(a).not.toContain('--version')
    expect(a).toContain("claude -p 'ping' --max-turns 1")
    expect(a).toContain('timeout "${CLAUDE_PROBE_TIMEOUT:-25}"')
    expect(a).toContain('[ "$rc" -lt 124 ]')
  })
})

describe('_shelve_broken_claude moves a non-launching claude off PATH so the pin can win', () => {
  for (const [label, src] of [['install-linux.sh', LINUX], ['scripts/fix-avx.sh', FIXAVX]] as const) {
    it(`${label}: the binary is renamed to <path>.avx-broken and claude no longer resolves`, () => {
      const dir = mockClaude('spin', join(mkdtempSync(join(tmpdir(), 'clirv-log-')), 'env'))
      const script = [
        'warn() { echo "warn: $*"; }',
        sliceShellFn(src, '_shelve_broken_claude'),
        '_shelve_broken_claude',
        'command -v claude >/dev/null 2>&1 && echo STILL_RESOLVES || echo GONE',
      ].join('\n')
      const out = execFileSync('bash', ['-c', script], { env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf-8' })
      expect(out).toContain('felretettem')
      expect(out).toContain('GONE')
      expect(readdirSync(dir)).toEqual(['claude.avx-broken'])
    })
  }
  it('install-linux.sh shelves only in the AVX-less branch, only when the pre-existing claude failed the probe', () => {
    expect(LINUX).toContain('CLAUDE_PREEXISTING_BROKEN="$(command -v claude 2>/dev/null || true)"')
    const avx = LINUX.indexOf("warn \"A CPU nem tamogatja az AVX-et")
    const shelve = LINUX.indexOf('[ -n "${CLAUDE_PREEXISTING_BROKEN:-}" ] && _shelve_broken_claude')
    const npm = LINUX.indexOf('npm install -g "@anthropic-ai/claude-code@${CLAUDE_PIN}"', avx)
    expect(avx).toBeGreaterThan(-1)
    expect(shelve).toBeGreaterThan(avx)
    expect(npm).toBeGreaterThan(shelve)
  })
  it('fix-avx.sh shelves when the probe failed and a claude is on PATH, before the pinned install', () => {
    const shelve = FIXAVX.indexOf('if [ "$CLAUDE_LAUNCHES" = "0" ] && command -v claude >/dev/null 2>&1; then _shelve_broken_claude; fi')
    const npm = FIXAVX.indexOf('npm install -g "@anthropic-ai/claude-code@${CLAUDE_PIN}"')
    expect(shelve).toBeGreaterThan(-1)
    expect(npm).toBeGreaterThan(shelve)
  })
})
