import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// APTPROMPT802, measured on a live host during a real first install:
//
//   bash install-linux.sh
//     -> sudo apt-get $APT_OPTS install -y nodejs -qq
//       -> sh -c "/usr/lib/needrestart/apt-pinvoke -m u"
//         -> whiptail --msgbox "Pending kernel upgrade"      <-- install stops here
//
// The customer installs from the Marveen app: no terminal, no stdin, nothing to
// dismiss the dialog with. It appears on any machine with a pending kernel
// upgrade or a service needing restart. It had been hidden until now because the
// test machines already had node from earlier rounds, so this apt-install step
// never ran.
//
// Three layers are needed and none is sufficient alone:
//   DEBIAN_FRONTEND=noninteractive  -- debconf prompts
//   NEEDRESTART_SUSPEND=1           -- the needrestart apt hook, which the
//                                      frontend variable does NOT cover. Its
//                                      pinvoke wrapper exits BEFORE exec'ing
//                                      needrestart when this is set, so nothing
//                                      prompts and nothing restarts.
//   NEEDRESTART_MODE=l              -- the fallback for older hooks that may
//                                      not honour SUSPEND. "l" is list-only on
//                                      purpose: "a" would silently RESTART the
//                                      pending services mid-install (dbus and
//                                      systemd-logind were both pending on the
//                                      target host), and this installer depends
//                                      on the user session bus later on.
//   </dev/null                      -- so a hook that still asks gets EOF
//                                      instead of the installer's own stdin
//
// And the delivery matters as much as the values: `sudo` runs with env_reset by
// default, so an exported variable never reaches apt-get. Measured on Debian 13:
//   export DEBIAN_FRONTEND=... ; sudo printenv DEBIAN_FRONTEND -> empty
//   sudo DEBIAN_FRONTEND=... printenv DEBIAN_FRONTEND          -> noninteractive
// The wrappers therefore pass the variables INLINE. These tests execute the real
// wrappers out of the shipped script with `sudo` stubbed, because "the script
// says noninteractive somewhere" is exactly the check that would have passed on
// the broken version.

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')

/** Pull one shell function out of the script so it can be executed for real. */
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

/**
 * Stub `sudo` that stands in for the whole apt chain. It reports what it was
 * handed, and -- the point of the exercise -- whether a needrestart-style hook
 * COULD have opened a dialog: that happens when the suspend/mode variables are
 * absent AND stdin still has something to read (a tty, or in this harness the
 * parent's pipe). With the fix both conditions fail.
 */
function stubDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aptprompt-'))
  const sudo = join(dir, 'sudo')
  writeFileSync(
    sudo,
    [
      '#!/usr/bin/env bash',
      'ARGV="$*"',
      '# Leading VAR=value assignments are how sudo receives environment.',
      'HAS_FRONTEND=no; HAS_MODE=no; HAS_SUSPEND=no',
      'case "$ARGV" in *DEBIAN_FRONTEND=noninteractive*) HAS_FRONTEND=yes ;; esac',
      'case "$ARGV" in *NEEDRESTART_MODE=l*) HAS_MODE=yes ;; esac',
      'case "$ARGV" in *NEEDRESTART_SUSPEND=1*) HAS_SUSPEND=yes ;; esac',
      '# Anything left on stdin? A prompting hook would read it and wait.',
      'STDIN_DATA=$(head -c 16 2>/dev/null || true)',
      'if [ -n "$STDIN_DATA" ]; then HAS_STDIN=yes; else HAS_STDIN=no; fi',
      'if [ "$HAS_SUSPEND" = no ] && [ "$HAS_MODE" = no ] && [ "$HAS_STDIN" = yes ]; then',
      '  echo "DIALOG_OPENED"',
      'fi',
      'echo "ARGV=$ARGV"',
      'echo "FRONTEND=$HAS_FRONTEND MODE=$HAS_MODE SUSPEND=$HAS_SUSPEND STDIN=$HAS_STDIN"',
    ].join('\n'),
    'utf-8',
  )
  chmodSync(sudo, 0o755)
  return dir
}

/**
 * Run a shell snippet with the real wrapper definitions in scope and `sudo`
 * stubbed. The parent stdin deliberately CARRIES DATA, so a missing </dev/null
 * shows up as STDIN=yes rather than as a silent pass.
 */
function runWithStub(snippet: string, defs: string): string {
  const dir = stubDir()
  const script = [
    'set -e',
    'APT_OPTS="-o DPkg::Lock::Timeout=180"',
    'NONINTERACTIVE_ENV="DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1"',
    'DPKG_KEEP_CONF="-o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef"',
    'PKG_MANAGER=dnf',
    defs,
    snippet,
  ].join('\n')
  return execFileSync('bash', ['-c', script], {
    encoding: 'utf-8',
    input: 'PROMPT-ANSWER\n'.repeat(4),
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  })
}

// Sliced lazily, per test. Doing it at module load would turn a DELETED wrapper
// into a collection error ("no tests"), and a run that reports nothing is the
// worst outcome for a guard: it looks like an infrastructure problem rather
// than the regression it is. Lazily, each test fails with the missing name.
const aptRun = () => sliceShellFn(LINUX, 'apt_run')
const pkgInstall = () => sliceShellFn(LINUX, 'pkg_install_noninteractive')

describe('APTPROMPT802: the Linux installer can never stop on a dialog', () => {
  it('apt_run hands apt-get all three non-interactive signals, inline through sudo', () => {
    const out = runWithStub('apt_run install -y nodejs -qq', aptRun())
    expect(out).toContain('FRONTEND=yes MODE=yes SUSPEND=yes')
    // Inline, i.e. before the command: an exported variable would not survive
    // sudo's env_reset, which is the whole reason this is not just an export.
    expect(out).toMatch(/ARGV=.*DEBIAN_FRONTEND=noninteractive.*apt-get/)
  })

  it('apt_run closes stdin, so a hook that still asks gets EOF', () => {
    const out = runWithStub('apt_run update -qq', aptRun())
    expect(out).toContain('STDIN=no')
    expect(out).not.toContain('DIALOG_OPENED')
  })

  it('apt_run keeps existing config files instead of asking which to keep', () => {
    const out = runWithStub('apt_run install -y nodejs -qq', aptRun())
    expect(out).toContain('--force-confold')
    expect(out).toContain('--force-confdef')
  })

  it('the fallback mode is list-only, so it can never restart a service mid-install', () => {
    // Read from the shipped script, not from the harness constant: the harness
    // could keep passing while the script drifted back to "a".
    const line = LINUX.split('\n').find((l) => l.startsWith('NONINTERACTIVE_ENV='))
    expect(line).toBeDefined()
    expect(line).toContain('NEEDRESTART_MODE=l')
    expect(line).not.toContain('NEEDRESTART_MODE=a')
    expect(LINUX).not.toContain('NEEDRESTART_MODE=a')
  })

  it('the dnf/yum path is closed the same way', () => {
    const out = runWithStub('pkg_install_noninteractive ffmpeg git', pkgInstall())
    expect(out).toMatch(/ARGV=.*dnf install -y ffmpeg git/)
    expect(out).toContain('STDIN=no')
    expect(out).not.toContain('DIALOG_OPENED')
  })

  // The instrument control. Without it the four tests above could be green
  // against a script that never changed: they must FAIL on the pre-fix form.
  it('CONTROL: the pre-fix call shape opens the dialog and is seen doing it', () => {
    const preFix = 'legacy_apt() { sudo apt-get $APT_OPTS "$@"; }'
    const out = runWithStub('legacy_apt install -y nodejs -qq', preFix)
    expect(out).toContain('DIALOG_OPENED')
    expect(out).toContain('FRONTEND=no MODE=no SUSPEND=no STDIN=yes')
    expect(out).not.toContain('--force-confold')
  })

  it('no package-manager call bypasses the wrappers', () => {
    // A hint string printed for a human at a terminal is not an invocation; an
    // executed one always begins the line (possibly indented).
    const executed = LINUX.split('\n').filter((l) =>
      /^\s*(sudo\s+apt-get|sudo\s+"?\$PKG_MANAGER"?\s+install|sudo\s+dnf|sudo\s+yum)\b/.test(l),
    )
    expect(executed).toEqual([])
  })

  it('the nodesource setup script inherits the same signals', () => {
    // It runs its own apt-get update/install inside, so it can hit the very same
    // needrestart hook. `sudo -E` alone would depend on sudoers policy.
    const line = LINUX.split('\n').find((l) => l.includes('sudo -E') && l.includes('bash -'))
    expect(line).toBeDefined()
    expect(line).toContain('$NONINTERACTIVE_ENV')
  })
})
