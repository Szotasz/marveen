import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The 2026-07-30 bug: every affected install completed "successfully" while the
// agents sat at "Not logged in" forever. Root cause, measured on a live host:
// the installer gated its whole auth block on `claude auth status`, which
// answers "can the OPERATOR's shell reach Claude?" -- and that succeeded
// because a previous run had exported a (stale) CLAUDE_CODE_OAUTH_TOKEN from
// ~/.bashrc. The SERVICES read only <install>/.env and
// <install>/store/.claude-oauth-token, so they got nothing.
//
// Same host, same command:
//   non-interactive shell (how systemd starts a unit): auth status -> FAILS
//   interactive shell     (how the installer runs):    auth status -> SUCCEEDS

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')

/** Pull one shell function out of a script so it can be executed for real. */
function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`function ${name}() not found`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`unterminated ${name}()`)
  return src.slice(start, end + 2)
}

/** Run service_auth_present against a real directory; return its exit status. */
function runServiceAuthPresent(src: string, installDir: string): boolean {
  const fn = sliceShellFn(src, 'service_auth_present')
  const script = `INSTALL_DIR="${installDir}"\n${fn}\nif service_auth_present; then exit 0; else exit 1; fi\n`
  try {
    execFileSync('bash', ['-c', script], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

describe.each([
  ['install-linux.sh', LINUX],
  ['install-macos.sh', MACOS],
])('%s -- service-side auth gate', (_name, SRC) => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'svcauth-'))
    mkdirSync(join(dir, 'store'), { recursive: true })
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // --- behavioural: the helper is EXECUTED, not pattern-matched -------------

  it('is FALSE on a bare install (no .env, no fleet token)', () => {
    rmSync(join(dir, '.env'), { force: true })
    rmSync(join(dir, 'store', '.claude-oauth-token'), { force: true })
    expect(runServiceAuthPresent(SRC, dir)).toBe(false)
  })

  it('is FALSE when .env exists but carries no auth key', () => {
    writeFileSync(join(dir, '.env'), 'OWNER_NAME=Teszt\nWEB_PORT=3420\n')
    expect(runServiceAuthPresent(SRC, dir)).toBe(false)
  })

  it('is FALSE when the auth key is present but EMPTY (the skipped-prompt case)', () => {
    writeFileSync(join(dir, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=\n')
    expect(runServiceAuthPresent(SRC, dir)).toBe(false)
  })

  it('is TRUE when .env carries an OAuth token', () => {
    writeFileSync(join(dir, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-' + 'x'.repeat(44) + '\n')
    expect(runServiceAuthPresent(SRC, dir)).toBe(true)
  })

  it('is TRUE when .env carries an API key instead', () => {
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-api03-something\n')
    expect(runServiceAuthPresent(SRC, dir)).toBe(true)
  })

  it('is TRUE on the fleet token file alone (sub-agent isolation path)', () => {
    writeFileSync(join(dir, '.env'), 'OWNER_NAME=Teszt\n')
    writeFileSync(join(dir, 'store', '.claude-oauth-token'), 'sk-ant-oat01-' + 'y'.repeat(44))
    expect(runServiceAuthPresent(SRC, dir)).toBe(true)
  })

  it('is FALSE when the fleet token file exists but is EMPTY', () => {
    writeFileSync(join(dir, '.env'), 'OWNER_NAME=Teszt\n')
    writeFileSync(join(dir, 'store', '.claude-oauth-token'), '')
    expect(runServiceAuthPresent(SRC, dir)).toBe(false)
  })

  // --- the credential the OPERATOR has must not count ----------------------

  it('never consults ~/.claude, the Keychain, or an exported env token', () => {
    const fn = sliceShellFn(SRC, 'service_auth_present')
    expect(fn).not.toMatch(/claude auth status/)
    expect(fn).not.toMatch(/\.credentials\.json/)
    expect(fn).not.toMatch(/security find-generic-password/)
    // reading $CLAUDE_CODE_OAUTH_TOKEN from the environment would reintroduce
    // the exact ~/.bashrc contamination that caused the bug
    expect(fn).not.toMatch(/\$\{?CLAUDE_CODE_OAUTH_TOKEN\}?[^=]/)
  })

  // --- fail-closed: a broken install must not read as success --------------

  it('declares a three-state auth verdict and defaults to BROKEN', () => {
    expect(SRC).toContain('INSTALL_AUTH_STATE="BROKEN"')
    expect(SRC).toContain('INSTALL_AUTH_STATE="OK"')
    expect(SRC).toContain('INSTALL_AUTH_STATE="UNKNOWN"')
    // the default assignment must come before the probe can set OK
    expect(SRC.indexOf('INSTALL_AUTH_STATE="BROKEN"'))
      .toBeLessThan(SRC.indexOf('INSTALL_AUTH_STATE="OK"'))
  })

  it('probes with an ISOLATED config dir so ambient credentials cannot fake health', () => {
    expect(SRC).toContain('CLAUDE_CONFIG_DIR="$_probe_cfg"')
    expect(SRC).toMatch(/env -i /)
  })

  it('repeats the verdict at the very end when auth is not OK', () => {
    const guard = SRC.lastIndexOf('${INSTALL_AUTH_STATE:-UNKNOWN}" != "OK"')
    expect(guard).toBeGreaterThan(0)
    // nothing but the closing banner may follow -- it must be the last word
    expect(SRC.slice(guard)).not.toContain('Kovetkezo lepesek')
  })

  // --- the pipeline-exit trap ---------------------------------------------

  it('captures the probe exit WITHOUT a pipe, so it is claude\'s own status', () => {
    // `VAR=$(claude ... | head)` reports head's status, and PIPESTATUS does not
    // rescue it either (after an assignment PIPESTATUS describes the
    // assignment, not the pipeline inside the substitution). The only correct
    // form is no pipe at all -- truncate afterwards in the shell.
    for (const l of SRC.split('\n')) {
      if (l.includes('claude --print "ping"')) expect(l).not.toContain('| head')
    }
    expect(SRC).toMatch(/CLAUDE_PROBE_OUT=\$\{CLAUDE_PROBE_OUT:0:200\}/)
  })
})

describe('the PIPESTATUS trap is real (guards the premise of the test above)', () => {
  it('$? after `VAR=$(cmd | head)` reports head -- and PIPESTATUS does NOT rescue it', () => {
    const sh = (script: string) =>
      execFileSync('bash', ['-c', script], { encoding: 'utf-8' }).trim()

    // the original bug: a failing command reads as success
    expect(sh('out=$(false | head -c 10); echo $?')).toBe('0')

    // the tempting "fix" that does nothing: after an ASSIGNMENT, PIPESTATUS
    // describes the assignment, not the pipeline inside the substitution
    expect(sh('out=$(false | head -c 10); echo ${PIPESTATUS[0]}')).toBe('0')

    // PIPESTATUS only works on a BARE pipeline (no assignment) -- which is not
    // the shape the installer needs, because it wants the output too
    expect(sh('false | head -c 10 >/dev/null; echo ${PIPESTATUS[0]}')).toBe('1')

    // the form actually shipped: no pipe, truncate afterwards
    expect(sh('out=$(false 2>&1); rc=$?; out=${out:0:200}; echo $rc')).toBe('1')
    expect(sh('out=$(echo hi 2>&1); rc=$?; out=${out:0:200}; echo "$rc:$out"')).toBe('0:hi')
  })
})

describe('both installers stay parseable', () => {
  it.each(['install-linux.sh', 'install-macos.sh'])('bash -n %s', (f) => {
    expect(() => execFileSync('bash', ['-n', join(ROOT, f)], { stdio: 'pipe' })).not.toThrow()
  })
})
