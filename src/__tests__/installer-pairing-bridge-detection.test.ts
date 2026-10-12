import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Measured on a Linux/Docker install 2026-09-01: [7/7] printed
//   "systemd --user nem elerheto (WSL / konteneren / VPS user-session nelkul)"
//   "Channels (Telegram bridge) fut (nohup, pid 782)"
// and the pairing step that follows it printed
//   "A marveen-channels service nem indult el. Parositas kihagyva."
// about that same, running bridge -- then the install ended on the red
// "FIGYELEM: Telegram parositas nem tortent meg!" banner with ALLOWED_CHAT_ID=0.
//
// Cause: the readiness probe asked `systemctl --user is-active`, which answers
// "is there a systemd USER unit" -- a narrower question than "is the bridge
// running". [7/7] itself already treats a missing user session as a normal
// shape and launches directly instead, so the probe contradicted the launch it
// was waiting on. WSL is a documented supported platform and ships no systemd
// user session by default, so this is not an exotic host.
//
// These tests run the REAL probe + wait loop out of the shipped
// install-linux.sh against the three launch shapes start.sh distinguishes.

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')

/**
 * Pull the readiness probe + the wait loop that consumes it out of the script.
 *
 * Anchored on `BRIDGE_OK=false` -- which both the old (systemctl-only) and the
 * fixed shape contain -- and widened backwards over the `_bridge_is_up` helper
 * when one is present. That is deliberate: it lets these tests run unchanged
 * against the PRE-fix install-linux.sh, where they fail on the ANSWER
 * (BRIDGE_OK=false for a running bridge) rather than on a missing symbol. A
 * test that only failed because a function had not been written yet would
 * prove nothing about the bug.
 */
function bridgeProbeBlock(src: string): string {
  const flag = src.indexOf('  BRIDGE_OK=false')
  if (flag < 0) throw new Error('BRIDGE_OK not found')
  const probeDef = src.indexOf('  _bridge_is_up() {')
  const start = probeDef >= 0 && probeDef < flag ? probeDef : flag
  // The first `done` after the flag closes the readiness wait loop.
  const end = src.indexOf('\n  done\n', flag)
  if (end < 0) throw new Error('wait loop not found')
  return src.slice(start, end + '\n  done\n'.length)
}

/**
 * Run the REAL probe with a chosen host shape.
 *  - systemdUser/systemdSystem: what `systemctl` reports
 *  - pid: written to store/channels.pid ('' writes no file at all)
 * `sleep` is stubbed so the 15s wait costs nothing.
 */
function runProbe(opts: { systemdUser?: boolean; systemdSystem?: boolean; pid?: number | '' }): string {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-pairprobe-'))
  mkdirSync(join(dir, 'store'), { recursive: true })
  if (opts.pid !== undefined && opts.pid !== '') {
    writeFileSync(join(dir, 'store', 'channels.pid'), String(opts.pid))
  }

  // `systemctl --user is-active` vs `systemctl is-active`: the stub tells them
  // apart the same way the probe calls them.
  const systemctlStub = [
    'systemctl() {',
    '  if [ "$1" = "--user" ]; then',
    `    return ${opts.systemdUser ? 0 : 1}`,
    '  fi',
    `  return ${opts.systemdSystem ? 0 : 1}`,
    '}',
  ]

  const script = [
    'set -e',
    `INSTALL_DIR=${JSON.stringify(dir)}`,
    'CHAN_UNIT=marveen-channels',
    ...systemctlStub,
    'sleep() { :; }',
    bridgeProbeBlock(LINUX),
    'echo "BRIDGE_OK=$BRIDGE_OK"',
  ].join('\n')

  return execFileSync('bash', ['-c', script], { encoding: 'utf-8' }).trim()
}

describe('installer: Telegram pairing bridge readiness', () => {
  it('sees a bridge started directly (no systemd) -- the regression', () => {
    // process.pid is this test runner: alive by construction.
    expect(runProbe({ pid: process.pid })).toContain('BRIDGE_OK=true')
  })

  it('still sees a bridge run by a systemd USER unit', () => {
    expect(runProbe({ systemdUser: true })).toContain('BRIDGE_OK=true')
  })

  it('sees a bridge run by a SYSTEM-scope unit (root-style install)', () => {
    expect(runProbe({ systemdSystem: true })).toContain('BRIDGE_OK=true')
  })

  it('reports down when the pidfile is stale', () => {
    // Above Linux's default pid_max, so it cannot name a live process.
    expect(runProbe({ pid: 2147483646 })).toContain('BRIDGE_OK=false')
  })

  it('reports down when there is no unit and no pidfile', () => {
    expect(runProbe({})).toContain('BRIDGE_OK=false')
  })
})
