import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ensure-managed-channels-enabled.sh resolved `sudo` BEFORE it looked at the
// file, so on a host where channelsEnabled was ALREADY true but the invoking
// user had no usable sudo it reported
//   ! channelsEnabled: nem root es nincs sudo -- kihagyva.
//   MARVEEN_CHANNELS_GATE=manual
// and pointed the operator at a manual root step that had nothing left to do.
// The reverse of the usual failure: the work was done, the report said it was
// not. Measured 2026-09-01 on a Linux/Docker install whose image already
// carried /etc/claude-code/managed-settings.json.
//
// Reading that file needs no privilege -- it is org policy at 0644, not a
// secret -- so the idempotent check now runs unprivileged and first; only a
// WRITE resolves sudo.
//
// These tests run the REAL script body out of the shipped file, sliced after
// the OS `case` so the harness can point MANAGED_FILE at a fixture.

const ROOT = join(__dirname, '..', '..')
const SCRIPT = readFileSync(join(ROOT, 'scripts', 'ensure-managed-channels-enabled.sh'), 'utf-8')

/**
 * Everything after the OS `case`, so the harness can point MANAGED_FILE at a
 * fixture instead of /etc.
 *
 * Anchored on `esac` rather than on either of the two blocks this change
 * reorders -- that is what lets these tests run unchanged against the pre-fix
 * script, where they fail on the REPORT ("manual" for an already-configured
 * host) instead of on an unbound variable.
 */
function scriptBody(src: string): string {
  const end = src.indexOf('esac')
  if (end < 0) throw new Error('OS case not found')
  return src.slice(end + 'esac'.length)
}

/**
 * Run the REAL body against a fixture.
 *  - managed: JSON to place at MANAGED_FILE, or null to leave it absent
 *  - sudo: 'hidden' (not installed), 'broken' (present but always fails),
 *          or 'root' (running as uid 0, so no sudo is used at all)
 */
function runGate(opts: { managed: string | null; sudo: 'hidden' | 'broken' | 'root' }): string {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-gate-'))
  const file = join(dir, 'managed-settings.json')
  if (opts.managed !== null) writeFileSync(file, opts.managed)

  const stubs: string[] = []
  if (opts.sudo === 'hidden') {
    // `command -v sudo` must miss. Overriding the `command` builtin with a
    // function is the only way to hide it without rewriting PATH, which would
    // also hide python3 and coreutils that the script legitimately needs.
    stubs.push('command() { if [ "$1" = "-v" ] && [ "$2" = "sudo" ]; then return 1; fi; builtin command "$@"; }')
  } else if (opts.sudo === 'broken') {
    // Present on PATH but unusable -- no password, no sudoers entry. This is
    // the shape that produced three password prompts and then gave up.
    stubs.push('sudo() { return 1; }')
  } else {
    stubs.push('id() { echo 0; }')
  }

  const script = [
    'set -u',
    `MANAGED_FILE=${JSON.stringify(file)}`,
    ...stubs,
    scriptBody(SCRIPT),
  ].join('\n')

  return execFileSync('bash', ['-c', script], { encoding: 'utf-8' }).trim()
}

const ENABLED = JSON.stringify({ channelsEnabled: true })

describe('ensure-managed-channels-enabled: report what is true, not what is reachable', () => {
  it('reports ok when already enabled and sudo is not installed -- the regression', () => {
    expect(runGate({ managed: ENABLED, sudo: 'hidden' })).toContain('MARVEEN_CHANNELS_GATE=ok')
  })

  it('reports ok when already enabled and sudo exists but cannot be used', () => {
    expect(runGate({ managed: ENABLED, sudo: 'broken' })).toContain('MARVEEN_CHANNELS_GATE=ok')
  })

  it('preserves other managed keys when it has to write', () => {
    const out = runGate({
      managed: JSON.stringify({ allowedChannelPlugins: ['telegram'] }),
      sudo: 'root',
    })
    expect(out).toContain('MARVEEN_CHANNELS_GATE=ok')
  })

  it('still reports manual when a write is needed but cannot be made', () => {
    expect(runGate({ managed: null, sudo: 'hidden' })).toContain('MARVEEN_CHANNELS_GATE=manual')
  })

  it('still reports manual when the key is present but false and there is no privilege', () => {
    expect(runGate({ managed: JSON.stringify({ channelsEnabled: false }), sudo: 'hidden' }))
      .toContain('MARVEEN_CHANNELS_GATE=manual')
  })
})
