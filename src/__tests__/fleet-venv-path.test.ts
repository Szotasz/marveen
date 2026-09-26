// FLEETVENV923: an opt-in fleet Python venv, exposed to every agent launch
// through a python-only shim directory that leads the launch PATH.
//
// Measured 2026-09-23 on the Mac mini: the Homebrew python3 carried zero
// packages, so every skill `python3` call import-failed, while a venv with the
// packages sat next to it. Rather than sprinkle `<venv>/bin/python3` over every
// skill, the venv is named ONCE (FLEET_PYTHON_VENV in .env, empty = off) and a
// shim with only python3/python/pip/pip3 is prepended in the five places a
// launch PATH is built: startAgentProcess (sub-agents), the channel-monitor
// recovery relaunch, background `claude -p`, channels.sh (main session boot)
// and watchdog.sh (agent restart). Review on #1504 asked for exactly this
// shape: default off, all launch sites, quotes stripped on the shell side too,
// and a shim instead of the whole bin/ so a pip console-script can never
// shadow a system tool for every agent.

import { describe, it, expect } from 'vitest'
import { fleetPythonShimPrefix, PYTHON_SHIM_TOOLS } from '../web/agent-process.js'
import { SETTINGS_REGISTRY } from '../config-registry.js'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const AGENT_PROCESS = readFileSync(join(ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')
const CHANNEL_MONITOR = readFileSync(join(ROOT, 'src', 'web', 'channel-monitor.ts'), 'utf-8')
const BACKGROUND_TASKS = readFileSync(join(ROOT, 'src', 'web', 'routes', 'background-tasks.ts'), 'utf-8')
const CONFIG = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf-8')
const CHANNELS_SH = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')
const WATCHDOG_SH = readFileSync(join(ROOT, 'scripts', 'watchdog.sh'), 'utf-8')
const SHIM_SH = join(ROOT, 'scripts', 'python-shim-prefix.sh')

describe('fleetPythonShimPrefix (pure)', () => {
  const venv = '/Users/x/.venv'
  const shim = '/opt/app/store/python-shim'
  const fsWith = (present: string[], ensure = () => true) => ({
    exists: (p: string) => present.includes(p),
    ensureShim: (_d: string, _l: Array<[string, string]>) => ensure(),
  })

  it('returns "<shim>:" and links only the tools the venv has', () => {
    let got: Array<[string, string]> = []
    const fs = { exists: (p: string) => [`${venv}/bin/python3`, `${venv}/bin/pip`].includes(p), ensureShim: (_d: string, l: Array<[string, string]>) => { got = l; return true } }
    expect(fleetPythonShimPrefix(venv, shim, fs)).toBe(`${shim}:`)
    expect(got).toEqual([['python3', `${venv}/bin/python3`], ['pip', `${venv}/bin/pip`]])
  })

  it('exposes only the python tools, never the whole bin/', () => {
    expect([...PYTHON_SHIM_TOOLS]).toEqual(['python3', 'python', 'pip', 'pip3'])
  })

  it('returns "" for an empty venv setting (off by default)', () => {
    expect(fleetPythonShimPrefix('', shim, fsWith(['anything']))).toBe('')
  })

  it('returns "" when the venv has no bin/python3', () => {
    expect(fleetPythonShimPrefix(venv, shim, fsWith([`${venv}/bin/pip`]))).toBe('')
  })

  it('returns "" when the shim cannot be built', () => {
    expect(fleetPythonShimPrefix(venv, shim, fsWith([`${venv}/bin/python3`], () => false))).toBe('')
  })

  it('refuses a shim path with a shell-active character instead of injecting it into the double-quoted export', () => {
    for (const bad of ['/opt/"x/shim', '/opt/$x/shim', '/opt/`x/shim', '/opt/\\x/shim']) {
      expect(fleetPythonShimPrefix(venv, bad, fsWith([`${venv}/bin/python3`]))).toBe('')
    }
  })

  it('accepts a shim path with a space (safe inside the double quotes)', () => {
    expect(fleetPythonShimPrefix(venv, '/opt/my app/store/python-shim', fsWith([`${venv}/bin/python3`]))).toBe('/opt/my app/store/python-shim:')
  })
})

describe('FLEETVENV923 wiring (source-level)', () => {
  it('config.ts defaults FLEET_PYTHON_VENV to empty (opt-in) with tilde expansion', () => {
    expect(CONFIG).toContain("const _fleetVenvRaw = (cfg('FLEET_PYTHON_VENV') ?? '').trim()")
    expect(CONFIG).toContain("export const FLEET_PYTHON_VENV = _fleetVenvRaw.startsWith('~') ? join(homedir(), _fleetVenvRaw.slice(1)) : _fleetVenvRaw")
    expect(CONFIG).not.toContain('klaudia-venv')
  })

  it('the config registry documents the key as an empty-by-default, restart-requiring system string', () => {
    const entry = SETTINGS_REGISTRY.find((e) => e.key === 'FLEET_PYTHON_VENV')
    expect(entry).toBeDefined()
    expect(entry?.type).toBe('string')
    expect(entry?.default).toBe('')
    expect(entry?.requiresRestart).toBe(true)
    expect(entry?.secret).toBe(false)
  })

  it('startAgentProcess puts the shim prefix FIRST in the launch PATH', () => {
    expect(AGENT_PROCESS).toContain('const venvPathPrefix = fleetVenvPathPrefix()')
    expect(AGENT_PROCESS).toContain('export PATH="${venvPathPrefix}/opt/homebrew/bin:$HOME/.bun/bin:')
  })

  it('the channel-monitor recovery relaunch uses the same prefix first', () => {
    expect(CHANNEL_MONITOR).toContain('`export PATH="${fleetVenvPathPrefix()}/opt/homebrew/bin:$HOME/.bun/bin:')
  })

  it('background claude -p uses the same prefix first', () => {
    expect(BACKGROUND_TASKS).toContain('`export PATH="${fleetVenvPathPrefix()}/opt/homebrew/bin:$HOME/.bun/bin:')
  })

  it('channels.sh and watchdog.sh take the prefix from the shim script, never from a `set -a` of .env', () => {
    for (const src of [CHANNELS_SH, WATCHDOG_SH]) {
      expect(src).toContain('PYTHON_SHIM_PREFIX="$(bash "$INSTALL_DIR/scripts/python-shim-prefix.sh" "$INSTALL_DIR" 2>/dev/null || true)"')
      expect(src).not.toContain('source "$INSTALL_DIR/.env"')
    }
    expect(CHANNELS_SH).toContain('export PATH="${PYTHON_SHIM_PREFIX}$PATH"')
    expect(WATCHDOG_SH).toContain('export PATH=\\"${PYTHON_SHIM_PREFIX}/opt/homebrew/bin:')
  })
})

describe('scripts/python-shim-prefix.sh (executed)', () => {
  // A fake install dir with .env, a fake venv with executable python3/pip, a
  // fake HOME; the script prints the prefix and builds the shim.
  function run(envLine: string | null, venvTools: string[] | null, venvRel = '.venv') {
    const home = mkdtempSync(join(tmpdir(), 'fleet-venv-'))
    const install = join(home, 'install')
    mkdirSync(join(install, 'store'), { recursive: true })
    if (envLine !== null) writeFileSync(join(install, '.env'), envLine + '\n')
    if (venvTools) {
      mkdirSync(join(home, venvRel, 'bin'), { recursive: true })
      for (const t of venvTools) writeFileSync(join(home, venvRel, 'bin', t), '#!/bin/sh\n', { mode: 0o755 })
    }
    const out = execFileSync('bash', [SHIM_SH, install], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf-8' })
    return { home, install, out: out.replace(home, '$HOME'), shim: join(install, 'store', 'python-shim'), cleanup: () => rmSync(home, { recursive: true, force: true }) }
  }

  it('prints nothing when FLEET_PYTHON_VENV is unset (off by default), even if a venv exists', () => {
    const r = run('OTHER=1', ['python3'])
    try {
      expect(r.out).toBe('')
      expect(existsSync(r.shim)).toBe(false)
    } finally { r.cleanup() }
  })

  it('prints nothing when the named venv has no bin/python3', () => {
    const r = run('FLEET_PYTHON_VENV=~/.venv', ['pip'])
    try { expect(r.out).toBe('') } finally { r.cleanup() }
  })

  it('builds the shim with only the python tools and prints "<shim>:"', () => {
    const r = run('FLEET_PYTHON_VENV=~/.venv', ['python3', 'pip', 'markitdown'])
    try {
      expect(r.out).toBe('$HOME/install/store/python-shim:')
      expect(readlinkSync(join(r.shim, 'python3'))).toBe(join(r.home, '.venv', 'bin', 'python3'))
      expect(readlinkSync(join(r.shim, 'pip'))).toBe(join(r.home, '.venv', 'bin', 'pip'))
      expect(existsSync(join(r.shim, 'markitdown'))).toBe(false)
      expect(existsSync(join(r.shim, 'python'))).toBe(false)
    } finally { r.cleanup() }
  })

  it('strips surrounding double or single quotes, like the TS readEnvFile does', () => {
    for (const line of ['FLEET_PYTHON_VENV="~/.venv"', "FLEET_PYTHON_VENV='~/.venv'", 'FLEET_PYTHON_VENV=~/.venv']) {
      const r = run(line, ['python3'])
      try { expect(r.out, line).toBe('$HOME/install/store/python-shim:') } finally { r.cleanup() }
    }
  })

  it('is idempotent and re-points a stale link', () => {
    const r = run('FLEET_PYTHON_VENV=~/.venv', ['python3', 'python'])
    try {
      execFileSync('bash', [SHIM_SH, r.install], { env: { HOME: r.home, PATH: '/usr/bin:/bin' } })
      expect(readlinkSync(join(r.shim, 'python'))).toBe(join(r.home, '.venv', 'bin', 'python'))
      rmSync(join(r.home, '.venv', 'bin', 'python'))
      const again = execFileSync('bash', [SHIM_SH, r.install], { env: { HOME: r.home, PATH: '/usr/bin:/bin' }, encoding: 'utf-8' })
      expect(again).toBe(`${r.shim}:`)
      expect(existsSync(join(r.shim, 'python'))).toBe(false)
    } finally { r.cleanup() }
  })

  it('does not export unrelated .env keys', () => {
    const r = run('TELEGRAM_BOT_TOKEN=secret\nFLEET_PYTHON_VENV=~/.venv', ['python3'])
    try {
      const out = execFileSync('bash', ['-c', `P="$(bash "${SHIM_SH}" "${r.install}")"; printf '%s|%s' "$P" "\${TELEGRAM_BOT_TOKEN:-unset}"`], { env: { HOME: r.home, PATH: '/usr/bin:/bin' }, encoding: 'utf-8' })
      expect(out).toBe(`${r.shim}:|unset`)
    } finally { r.cleanup() }
  })
})
