import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync, cpSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// NOTIFYVAKSWEEP826 closing round: the two dashboard-API senders get the
// honest-delivery treatment (channels.sh guard POSTs, the generated prod-tree
// post-checkout hook), and the watchdog replay's stderr is routed to the
// watchdog log instead of /dev/null. Marveen's stipulation (msg 16091): the
// marker fix needs its own POSITIVE CONTROL -- a deliberately unwritable log
// target must leave a visible trace, otherwise the fix is as unmeasurable as
// the failure was. channels.sh itself is unsafe to execute even stubbed
// (absolute-path kill reaper, measured in the sweep), so its coverage is
// source-pinned with a known-positive; the hook and the replay run for real.
const ROOT = join(__dirname, '..', '..')

let stage: string
// realpath, mert a macOS /var/folders symlink miatt a hook TOPLEVEL==PROD_ROOT
// osszevetese kulonben hamisan elterne (a show-toplevel felold, a cd+pwd nem).
beforeEach(() => { stage = realpathSync(mkdtempSync(join(tmpdir(), 'send-final-'))) })
afterEach(() => { rmSync(stage, { recursive: true, force: true }) })

function stubBin(): string {
  const bin = join(stage, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'curl'),
    '#!/bin/bash\necho "$@" >> "${CURL_ARGV_LOG:-/dev/null}"\nif [ "${CURL_STUB_EXIT:-0}" -ne 0 ]; then exit "${CURL_STUB_EXIT}"; fi\nprintf \'%s\' "${CURL_STUB_HTTP:-200}"\n')
  writeFileSync(join(bin, 'tmux'), '#!/bin/bash\necho "$@" >> "${TMUX_ARGV_LOG:-/dev/null}"\nexit 0\n')
  for (const b of ['curl', 'tmux']) chmodSync(join(bin, b), 0o755)
  return bin
}

describe('watchdog-replay marker: POSITIVE CONTROL for the failure trace (Marveen msg 16091)', () => {
  const run = (logTarget: string) => {
    const bin = stubBin()
    const data = join(stage, 'msgs.json')
    writeFileSync(data, JSON.stringify([
      { id: 424242, to_agent: 'probetest', status: 'delivered', completed_at: null, created_at: 5, content: 'probe' },
    ]))
    return spawnSync('python3', [join(ROOT, 'scripts', 'watchdog-replay.py'),
      'agent-probetest', 'probetest', '0', data, logTarget], {
      env: { PATH: `${bin}:/usr/bin:/bin`, TMUX_ARGV_LOG: join(stage, 'tmux.log') },
      encoding: 'utf-8',
      timeout: 60000,
    })
  }
  it('an unwritable log target leaves a LOUD stderr trace and does not stop the replay', () => {
    const r = run(join(stage, 'no-such-dir', 'nested', 'dashboard.log'))
    expect(r.status).toBe(0) // replay priority holds
    expect(existsSync(join(stage, 'tmux.log'))).toBe(true) // injection still happened
    expect(r.stderr).toContain('marker write failed')
    expect(r.stderr).toContain('424242')
  })
  it('control pair: a writable target produces the marker and NO failure trace', () => {
    const target = join(stage, 'dashboard.log')
    const r = run(target)
    expect(r.status).toBe(0)
    expect(readFileSync(target, 'utf-8')).toContain('"id": 424242')
    expect(r.stderr).not.toContain('marker write failed')
  })
  it('watchdog.sh routes the replay stderr to its log, not /dev/null', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'watchdog.sh'), 'utf-8')
    expect(src).toMatch(/watchdog-replay\.py[\s\S]{0,200}2>>"\$LOG"/)
    expect(src).not.toMatch(/watchdog-replay\.py[\s\S]{0,200}2>\/dev\/null/)
  })
  it('KNOWN-POSITIVE for the pin: the pre-fix invocation shape fails it', () => {
    const preFix = 'python3 "$INSTALL_DIR/scripts/watchdog-replay.py" \\\n "$SESSION_NAME" "$AGENT_ID" "$CUTOFF" "$TMPDATA" \\\n "$INSTALL_DIR/store/dashboard.log" 2>/dev/null'
    expect(preFix).toMatch(/watchdog-replay\.py[\s\S]{0,200}2>\/dev\/null/)
  })
})

describe('generated prod-tree post-checkout hook: honest alert delivery', () => {
  const setupRepoWithHook = (): { hook: string; repo: string } => {
    const repo = join(stage, 'repo')
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    mkdirSync(join(repo, 'store'), { recursive: true })
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'develop'])
    writeFileSync(join(repo, 'x.txt'), 'x')
    execFileSync('git', ['-C', repo, 'add', '.'], { env: { ...process.env } })
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    cpSync(join(ROOT, 'scripts', 'install-prod-tree-guard-hook.sh'), join(repo, 'scripts', 'install-prod-tree-guard-hook.sh'))
    writeFileSync(join(repo, 'store', '.dashboard-token'), 'test-token\n')
    // git-common-dir returns a RELATIVE .git from inside the repo, so the
    // installer must run with the repo root as cwd (it does in production).
    const r = spawnSync('/bin/bash', [join(repo, 'scripts', 'install-prod-tree-guard-hook.sh')], { cwd: repo, encoding: 'utf-8', timeout: 20000 })
    expect(r.status).toBe(0)
    const hook = join(repo, '.git', 'hooks', 'post-checkout')
    expect(existsSync(hook)).toBe(true)
    return { hook, repo }
  }
  const runHook = (hook: string, repo: string, env: Record<string, string>) => {
    const bin = stubBin()
    // The hook only alerts on a NON-home branch -- park the scratch repo on a
    // feature branch first. CRITICAL: this setup checkout itself FIRES the
    // installed post-checkout hook, which would alert (live curl!) and
    // auto-revert back to develop, making the measured run a silent no-op --
    // exactly what the first draft of this test did. Waive the hook for the
    // setup step (MARVEEN_PROD_CHECKOUT_OK=1) and keep the stub curl on PATH
    // so no invocation can ever reach a live endpoint.
    execFileSync('git', ['-C', repo, 'checkout', '-q', '-B', 'feature-probe'], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, MARVEEN_PROD_CHECKOUT_OK: '1' },
    })
    return spawnSync('/bin/bash', [hook, 'a'.repeat(40), 'b'.repeat(40), '1'], {
      cwd: repo,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: stage,
        CURL_ARGV_LOG: join(stage, 'curl.log'),
        ...env,
      },
      encoding: 'utf-8',
      timeout: 20000,
    })
  }
  it('a delivered alert (HTTP 2xx) stays quiet; a failed one is loud on stderr but exit 0', () => {
    const { hook, repo } = setupRepoWithHook()
    const ok = runHook(hook, repo, { CURL_STUB_HTTP: '200' })
    expect(ok.status).toBe(0)
    expect(ok.stderr).not.toContain('NEM ert celba')
    const bad = runHook(hook, repo, { CURL_STUB_HTTP: '500' })
    expect(bad.status).toBe(0) // a guard must not break git
    expect(bad.stderr).toContain('NEM ert celba')
    const dead = runHook(hook, repo, { CURL_STUB_EXIT: '6' })
    expect(dead.status).toBe(0)
    expect(dead.stderr).toContain('NEM ert celba')
  })
})

describe('channels.sh guard POSTs: source-pinned honest delivery (unsafe to execute)', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')
  it('both guard POSTs capture the HTTP code and log a delivery failure', () => {
    const matches = src.match(/guard alert POST failed/g) ?? []
    expect(matches.length).toBe(2)
    expect(src).not.toMatch(/api\/messages[\s\S]{0,400}>\/dev\/null 2>&1 \|\| true/)
  })
  it('KNOWN-POSITIVE for the pin: the pre-fix shape fails it', () => {
    const preFix = 'curl ... "http://localhost:3420/api/messages" -d "{}" >/dev/null 2>&1 || true'
    expect(preFix).toMatch(/api\/messages[\s\S]{0,400}>\/dev\/null 2>&1 \|\| true/)
  })
})
