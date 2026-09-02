import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
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
// WRITE resolves sudo. The check is asked a second time WITH sudo when there
// is sudo, so a locked-down file still gets the early exit rather than a
// privileged rewrite on every run.
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

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Run the REAL body against a fixture.
 *  - managed: JSON to place at MANAGED_FILE, or null to leave it absent
 *  - sudo: 'hidden' (not installed), 'broken' (present but always fails),
 *          'usable' (present and works), or 'root' (uid 0, no sudo needed)
 *  - mode: chmod applied to the fixture before the run
 *  - umask: set before the body runs, so the mode of what it WRITES is pinned
 *
 * Returns the stdout AND the fixture path: several of these tests are about
 * what the script did to the file, which the report alone cannot show.
 */
function runGate(opts: {
  managed: string | null
  sudo: 'hidden' | 'broken' | 'usable' | 'root'
  mode?: number
  umask?: string
}): { out: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-gate-'))
  dirs.push(dir)
  const file = join(dir, 'managed-settings.json')
  if (opts.managed !== null) writeFileSync(file, opts.managed)
  if (opts.mode !== undefined) chmodSync(file, opts.mode)

  const stubs: string[] = []
  if (opts.sudo === 'root') {
    stubs.push('id() { echo 0; }')
  } else {
    // Every non-root case must SAY it is non-root. Without this the suite is
    // green as an ordinary user and red as root -- `[ "$(id -u)" -ne 0 ]` is
    // false, the whole sudo block is skipped, and a test that asserts "manual
    // because there is no privilege" gets a successful write instead.
    stubs.push('id() { echo 1000; }')
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
      // Present and working. `command -v` finds a function, so defining one is
      // enough to be "installed". Privilege is modelled as the one thing that
      // actually distinguishes root here: it can read a file whose mode denies
      // the caller, exactly like `sudo cat` on a root-owned 0600 file.
      stubs.push(
        'sudo() { chmod u+r "$MANAGED_FILE" 2>/dev/null; "$@"; __rc=$?; chmod u-r "$MANAGED_FILE" 2>/dev/null; return $__rc; }',
      )
    }
  }

  const script = [
    'set -u',
    ...(opts.umask ? [`umask ${opts.umask}`] : []),
    `MANAGED_FILE=${JSON.stringify(file)}`,
    ...stubs,
    scriptBody(SCRIPT),
  ].join('\n')

  const out = execFileSync('bash', ['-c', script], { encoding: 'utf-8' }).trim()
  return { out, file }
}

const ENABLED = JSON.stringify({ channelsEnabled: true })
const mode = (file: string) => statSync(file).mode & 0o777

describe('ensure-managed-channels-enabled: report what is true, not what is reachable', () => {
  it('reports ok when already enabled and sudo is not installed -- the regression', () => {
    const { out, file } = runGate({ managed: ENABLED, sudo: 'hidden' })
    expect(out).toContain('MARVEEN_CHANNELS_GATE=ok')
    // Not just the report: the claim is that an already-configured host needs
    // no write at all. A rewrite would reformat the JSON, so byte equality with
    // the fixture is what proves the early exit was taken.
    expect(readFileSync(file, 'utf-8')).toBe(ENABLED)
  })

  it('reports ok when already enabled and sudo exists but cannot be used', () => {
    const { out, file } = runGate({ managed: ENABLED, sudo: 'broken' })
    expect(out).toContain('MARVEEN_CHANNELS_GATE=ok')
    expect(readFileSync(file, 'utf-8')).toBe(ENABLED)
  })

  it('takes the early exit when only privilege can read an already-enabled file', () => {
    // The unprivileged read is an optimisation, not the only attempt. On a host
    // whose managed file is not world-readable it fails, and without the second
    // privileged ask the script would fall through and rewrite -- with a sudo
    // prompt -- a file that was already correct, on every single run.
    const { out, file } = runGate({ managed: ENABLED, sudo: 'usable', mode: 0o000 })
    expect(out).toContain('mar be van kapcsolva')
    expect(out).toContain('MARVEEN_CHANNELS_GATE=ok')
    chmodSync(file, 0o644)
    expect(readFileSync(file, 'utf-8')).toBe(ENABLED)
  })

  it('preserves other managed keys when it has to write', () => {
    const { out, file } = runGate({
      managed: JSON.stringify({ allowedChannelPlugins: ['telegram'] }),
      sudo: 'root',
    })
    expect(out).toContain('MARVEEN_CHANNELS_GATE=ok')

    // The point of the test is the FILE, not the report: a merge that threw the
    // existing org policy away would still report ok. allowedChannelPlugins is
    // the key this script's own header promises to keep, and losing it does not
    // fail loudly -- the channel plugin just silently drops out of the policy.
    const merged = JSON.parse(readFileSync(file, 'utf-8'))
    expect(merged.channelsEnabled).toBe(true)
    expect(merged.allowedChannelPlugins).toEqual(['telegram'])
  })

  it('creates the managed file world-readable even under a restrictive umask', () => {
    // The header calls this file org policy at 0644, not a secret, and the
    // unprivileged read is built on that. os.replace carries the tmp file's
    // mode, so without an explicit chmod a root run under `umask 077` left it
    // 0600 -- and the next run's unprivileged check fell back to the manual
    // branch on a host that was already configured.
    const { out, file } = runGate({ managed: null, sudo: 'root', umask: '077' })
    expect(out).toContain('MARVEEN_CHANNELS_GATE=ok')
    expect(mode(file)).toBe(0o644)
  })

  it('does not widen the mode of a managed file it did not create', () => {
    // Managed settings may legitimately carry env and apiKeyHelper, so an admin
    // can have locked this file down on purpose. Flipping one boolean is not a
    // licence to publish the rest of it to every local user.
    const { out, file } = runGate({
      managed: JSON.stringify({ allowedChannelPlugins: ['telegram'] }),
      sudo: 'root',
      mode: 0o600,
    })
    expect(out).toContain('MARVEEN_CHANNELS_GATE=ok')
    expect(mode(file)).toBe(0o600)
  })

  it('still reports manual when a write is needed but cannot be made', () => {
    expect(runGate({ managed: null, sudo: 'hidden' }).out).toContain('MARVEEN_CHANNELS_GATE=manual')
  })

  it('still reports manual when the key is present but false and there is no privilege', () => {
    expect(runGate({ managed: JSON.stringify({ channelsEnabled: false }), sudo: 'hidden' }).out)
      .toContain('MARVEEN_CHANNELS_GATE=manual')
  })
})
