import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isNativeClaudeBin, workerAutoUpdaterEnv } from '../web/agent-worker.js'

// WORKERAUTOUPDATE1011: both workers used to launch with a live Claude Code
// auto-updater (the tmux global DISABLE_AUTOUPDATER reaches only sessions
// created after channels.sh sets it, and after a reboot the worker usually
// creates the tmux server). Measured 2026-10-11: a native 2.1.296 landed 14s
// after the two workers came up, the only claude processes without the variable.

const __dirname = dirname(fileURLToPath(import.meta.url))
const workerSrc = readFileSync(join(__dirname, '../web/agent-worker.ts'), 'utf-8')

function runClause(clause: string, inherited: string | undefined): string {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH }
  if (inherited !== undefined) env.DISABLE_AUTOUPDATER = inherited
  return execFileSync('bash', ['-c', `${clause}printf '%s' "\${DISABLE_AUTOUPDATER-<unset>}"`], { env }).toString()
}

describe('workerAutoUpdaterEnv', () => {
  it('pins every worker by default, the slow one included', () => {
    for (const role of ['slow', 'fast'] as const) {
      for (const nativeInstall of [true, false]) {
        expect(workerAutoUpdaterEnv({ role, optIn: false, nativeInstall })).toBe('export DISABLE_AUTOUPDATER=1; ')
      }
    }
  })

  it('opt-in on a native install makes ONLY the slow worker the updater', () => {
    expect(workerAutoUpdaterEnv({ role: 'slow', optIn: true, nativeInstall: true })).toBe('unset DISABLE_AUTOUPDATER; ')
    expect(workerAutoUpdaterEnv({ role: 'fast', optIn: true, nativeInstall: true })).toBe('export DISABLE_AUTOUPDATER=1; ')
  })

  it('opt-in is ignored on a non-native install (channels.sh claude_ensure owns npm updates)', () => {
    expect(workerAutoUpdaterEnv({ role: 'slow', optIn: true, nativeInstall: false })).toBe('export DISABLE_AUTOUPDATER=1; ')
  })

  it('the pinned clause sets the variable in a real shell even when nothing was inherited', () => {
    expect(runClause(workerAutoUpdaterEnv({ role: 'fast', optIn: true, nativeInstall: true }), undefined)).toBe('1')
  })

  it('the updater clause clears a variable inherited from the tmux global env', () => {
    expect(runClause(workerAutoUpdaterEnv({ role: 'slow', optIn: true, nativeInstall: true }), '1')).toBe('<unset>')
  })
})

describe('isNativeClaudeBin', () => {
  function fixture(): string {
    const home = mkdtempSync(join(tmpdir(), 'worker-autoupdate-'))
    const versions = join(home, '.local', 'share', 'claude', 'versions')
    mkdirSync(versions, { recursive: true })
    writeFileSync(join(versions, '9.9.9'), '')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    symlinkSync(join(versions, '9.9.9'), join(home, '.local', 'bin', 'claude'))
    mkdirSync(join(home, 'npm', 'bin'), { recursive: true })
    writeFileSync(join(home, 'npm', 'bin', 'claude'), '')
    return home
  }

  it('is true for the native launcher symlink into the versions dir', () => {
    const home = fixture()
    try {
      expect(isNativeClaudeBin(join(home, '.local', 'bin', 'claude'), home)).toBe(true)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('is false for an npm-global binary, a missing path and no binary at all', () => {
    const home = fixture()
    try {
      expect(isNativeClaudeBin(join(home, 'npm', 'bin', 'claude'), home)).toBe(false)
      expect(isNativeClaudeBin(join(home, 'nope', 'claude'), home)).toBe(false)
      expect(isNativeClaudeBin(null, home)).toBe(false)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('is false when the versions dir itself is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'worker-autoupdate-'))
    try {
      expect(isNativeClaudeBin('/bin/sh', home)).toBe(false)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('worker launch line carries the auto-updater clause', () => {
  it('the clause sits in the launch chain before the claude invocation', () => {
    const launchBlock = workerSrc.slice(workerSrc.indexOf('const launch ='), workerSrc.indexOf("execFileSync(TMUX, ['new-session'"))
    expect(launchBlock).toContain('autoUpdaterEnv +')
    expect(launchBlock.indexOf('autoUpdaterEnv +')).toBeLessThan(launchBlock.indexOf('shArg(claudeLaunchBin)'))
  })

  it('the role is the slow-worker identity, and the opt-in comes from config', () => {
    expect(workerSrc).toMatch(/role:\s*ctx === ctxSlow \? 'slow' : 'fast'/)
    expect(workerSrc).toMatch(/optIn:\s*WORKER_AUTOUPDATE/)
  })
})
