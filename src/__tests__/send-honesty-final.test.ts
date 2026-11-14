import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync, cpSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// NOTIFYVAKSWEEP826 closing round: the two dashboard-API senders get the
// honest-delivery treatment (channels.sh guard POSTs, the generated prod-tree
// post-checkout hook). channels.sh itself is unsafe to execute even stubbed
// (absolute-path kill reaper, measured in the sweep), so its coverage is
// source-pinned with a known-positive; the hook runs for real. (The watchdog
// replay marker this round also pinned is gone with the replay script itself,
// REPLAYNOENVELOPE1114.)
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

// The watchdog-replay marker block that stood here went away with scripts/watchdog-replay.py
// (REPLAYNOENVELOPE1114): the watchdog no longer types messages into a pane, it asks the server to put them back
// for the router. Its failure lines in $LOG are pinned in watchdog-redeliver-unseen.test.ts.

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
    // The repo root as cwd is the production shape (update.sh cd-s there), kept
    // here deliberately. The installer no longer DEPENDS on it -- it resolves
    // git-common-dir against its own root -- and that independence is pinned
    // separately in hook-installer-cwd-independence.test.ts.
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
