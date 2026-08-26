import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync, cpSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'

// NOTIFYVAKSWEEP826 round 1: the sweep measured 13 Telegram/dashboard senders
// and found only two honest ones. This round extracts the proven notify.sh
// contract into scripts/lib/send-telegram.sh and converts the top of the
// ranking (limit-monitor, unit-fail-notify, host-restart-watchdog,
// disk-space-guard), moving every dedupe/cooldown/baseline stamp to AFTER a
// confirmed delivery. These tests are EMPIRICAL (staged trees, PATH-stubbed
// curl, nothing leaves the machine) so that running them against the pre-fix
// scripts fails: the old senders were silent and stamped state up front --
// that is the red-before baseline Marveen required (msg 16061).
const ROOT = join(__dirname, '..', '..')
const FAKE_TOKEN = '1234567890:TESTTOKENTESTTOKEN'

let stage: string

beforeEach(() => {
  stage = mkdtempSync(join(tmpdir(), 'send-sweep-'))
})
afterEach(() => {
  rmSync(stage, { recursive: true, force: true })
})

// Staged install tree: scripts/ + scripts/lib/ + store/ + .env, plus a bin/
// with a controllable curl stub (CURL_STUB_EXIT / CURL_STUB_BODY) and no-op
// tmux. The stub records its argv so a "send attempted" claim is provable.
function stageTree(scriptNames: string[]): { root: string; bin: string } {
  const scripts = join(stage, 'scripts')
  mkdirSync(join(scripts, 'lib'), { recursive: true })
  mkdirSync(join(stage, 'store'), { recursive: true })
  for (const s of scriptNames) cpSync(join(ROOT, 'scripts', s), join(scripts, s))
  cpSync(join(ROOT, 'scripts', 'lib', 'send-telegram.sh'), join(scripts, 'lib', 'send-telegram.sh'))
  const bin = join(stage, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'curl'),
    '#!/bin/bash\necho "$@" >> "${CURL_ARGV_LOG:-/dev/null}"\nif [ "${CURL_STUB_EXIT:-0}" -ne 0 ]; then\n  echo "curl: (6) Could not resolve host for https://api.telegram.org/bot${CURL_STUB_TOKEN:-}/sendMessage" >&2\n  exit "${CURL_STUB_EXIT}"\nfi\nprintf \'%s\' "${CURL_STUB_BODY:-{\\"ok\\":true}}"\n')
  writeFileSync(join(bin, 'tmux'), '#!/bin/bash\nexit 1\n')
  // limit-monitor hashes with md5sum, which macOS lacks (md5 only); the hash
  // value is irrelevant to these tests, only the stamp lifecycle is.
  writeFileSync(join(bin, 'md5sum'), '#!/bin/bash\ninput=$(cat)\nprintf \'%s  -\\n\' "stubhash$(printf \'%s\' "$input" | wc -c | tr -d \' \')"\n')
  for (const b of ['curl', 'tmux', 'md5sum']) chmodSync(join(bin, b), 0o755)
  return { root: stage, bin }
}

function runScript(rel: string, args: string[], env: Record<string, string>, bin: string) {
  return spawnSync('/bin/bash', [join(stage, 'scripts', rel), ...args], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: stage,
      CURL_STUB_TOKEN: FAKE_TOKEN,
      CURL_ARGV_LOG: join(stage, 'curl-argv.log'),
      ...env,
    },
    encoding: 'utf-8',
    timeout: 20000,
  })
}

const curlWasInvoked = () => existsSync(join(stage, 'curl-argv.log'))

// ---- the shared contract itself -------------------------------------------

describe('send-telegram.sh library contract', () => {
  const driver = (call: string) => {
    const { bin } = stageTree([])
    writeFileSync(join(stage, 'scripts', 'driver.sh'), `#!/bin/bash\n. "$(dirname "$0")/lib/send-telegram.sh"\n${call}\n`)
    return runScript('driver.sh', [], {}, bin)
  }

  it('returns 0 only on curl exit 0 + Bot API ok:true', () => {
    const r = driver(`send_telegram_message "${FAKE_TOKEN}" 42 "hello"`)
    expect(r.status).toBe(0)
  })
  it('POSITIVE CONTROL: transport failure returns 1, loud, token redacted', () => {
    const { bin } = stageTree([])
    writeFileSync(join(stage, 'scripts', 'driver.sh'), `#!/bin/bash\n. "$(dirname "$0")/lib/send-telegram.sh"\nsend_telegram_message "${FAKE_TOKEN}" 42 "hello"\n`)
    const r = runScript('driver.sh', [], { CURL_STUB_EXIT: '6' }, bin)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('curl exit 6')
    expect(r.stderr).toContain('<token>')
    expect(r.stderr).not.toContain(FAKE_TOKEN)
  })
  it('an HTTP-200 ok:false rejection returns 1 with the API reason', () => {
    const { bin } = stageTree([])
    writeFileSync(join(stage, 'scripts', 'driver.sh'), `#!/bin/bash\n. "$(dirname "$0")/lib/send-telegram.sh"\nsend_telegram_message "${FAKE_TOKEN}" 42 "hello"\n`)
    const r = runScript('driver.sh', [], { CURL_STUB_BODY: '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}' }, bin)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('chat not found')
  })
  it('misuse (empty token) is loud and never reaches curl', () => {
    const r = driver('send_telegram_message "" 42 "hello"')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('empty token')
    expect(curlWasInvoked()).toBe(false)
  })
})

// ---- unit-fail-notify.sh ---------------------------------------------------

describe('unit-fail-notify.sh: honest journal, exit 0 by design', () => {
  const setup = () => {
    const { bin } = stageTree(['unit-fail-notify.sh'])
    const tgEnv = join(stage, 'tg.env')
    writeFileSync(tgEnv, `TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}\n`)
    return { bin, env: { TELEGRAM_ENV: tgEnv, MARVEEN_ALERT_CHAT_ID: '42' } }
  }
  it('confirmed delivery is stated in the journal', () => {
    const { bin, env } = setup()
    const r = runScript('unit-fail-notify.sh', ['dash.service'], env, bin)
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('delivered')
  })
  it('RED-BEFORE: a failed send is no longer silent (old script emitted nothing)', () => {
    const { bin, env } = setup()
    const r = runScript('unit-fail-notify.sh', ['dash.service'], { ...env, CURL_STUB_EXIT: '6' }, bin)
    expect(r.status).toBe(0) // OnFailure handler must never itself fail
    expect(r.stderr).toContain('did NOT deliver')
    expect(curlWasInvoked()).toBe(true) // the attempt provably happened
  })
})

// ---- limit-monitor.sh ------------------------------------------------------

describe('limit-monitor.sh: dedupe stamp only after confirmed delivery', () => {
  const setup = () => {
    const { bin } = stageTree(['limit-monitor.sh'])
    writeFileSync(join(stage, '.env'), 'MAIN_AGENT_ID=testbot\nBOT_NAME=Testbot\nALLOWED_CHAT_ID=42\n')
    mkdirSync(join(stage, '.claude', 'channels', 'telegram'), { recursive: true })
    writeFileSync(join(stage, '.claude', 'channels', 'telegram', '.env'), `TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}\n`)
    writeFileSync(join(stage, 'store', 'channels.log'), 'usage limit reached -- upgrade or wait\n')
    return { bin, state: join(stage, 'store', '.limit-monitor-state'), log: join(stage, 'store', 'limit-monitor.log') }
  }
  it('successful send writes the dedupe stamp and logs ALERT sent', () => {
    const { bin, state, log } = setup()
    const r = runScript('limit-monitor.sh', [], {}, bin)
    expect(r.status).toBe(0)
    expect(existsSync(state)).toBe(true)
    expect(readFileSync(log, 'utf-8')).toContain('ALERT sent')
  })
  it('RED-BEFORE: failed send does NOT stamp (old script stamped up front) and the retry then delivers', () => {
    const { bin, state, log } = setup()
    const r1 = runScript('limit-monitor.sh', [], { CURL_STUB_EXIT: '6' }, bin)
    expect(r1.status).toBe(0)
    expect(existsSync(state)).toBe(false) // the alert is NOT buried
    expect(readFileSync(log, 'utf-8')).toContain('FAILED')
    expect(readFileSync(log, 'utf-8')).not.toContain('ALERT sent to')
    const r2 = runScript('limit-monitor.sh', [], {}, bin) // next tick, transport back
    expect(r2.status).toBe(0)
    expect(existsSync(state)).toBe(true)
    expect(readFileSync(log, 'utf-8')).toContain('ALERT sent to')
  })
})

// ---- host-restart-watchdog.sh ---------------------------------------------

describe('host-restart-watchdog.sh: one-shot notice retries until delivered', () => {
  const setup = () => {
    const { bin } = stageTree(['host-restart-watchdog.sh'])
    const procStat = join(stage, 'proc-stat')
    writeFileSync(procStat, 'cpu 1 2 3\nbtime 1000\n')
    const tgEnv = join(stage, 'tg.env')
    writeFileSync(tgEnv, `TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}\n`)
    const env = {
      HOSTWD_PROC_STAT: procStat,
      MARVEEN_STORE: join(stage, 'store'),
      TELEGRAM_ENV: tgEnv,
      MARVEEN_ALERT_CHAT_ID: '42',
    }
    return { bin, env, procStat, state: join(stage, 'store', '.last-btime') }
  }
  it('baseline init stamps without sending; a detected restart stamps ONLY on delivery', () => {
    const { bin, env, procStat, state } = setup()
    const r1 = runScript('host-restart-watchdog.sh', [], env, bin)
    expect(r1.status).toBe(0)
    expect(readFileSync(state, 'utf-8').trim()).toBe('1000')
    expect(curlWasInvoked()).toBe(false)

    writeFileSync(procStat, 'cpu 1 2 3\nbtime 2000\n') // the host rebooted
    const r2 = runScript('host-restart-watchdog.sh', [], { ...env, CURL_STUB_EXIT: '6' }, bin)
    expect(r2.status).toBe(0)
    // RED-BEFORE: the old script stamped btime up front, losing the notice.
    expect(readFileSync(state, 'utf-8').trim()).toBe('1000')

    const r3 = runScript('host-restart-watchdog.sh', [], env, bin) // retry succeeds
    expect(r3.status).toBe(0)
    expect(readFileSync(state, 'utf-8').trim()).toBe('2000')
  })
})

// ---- disk-space-guard.sh ---------------------------------------------------

describe('disk-space-guard.sh: cooldown stamp only after confirmed delivery', () => {
  const setup = () => {
    const { bin } = stageTree(['disk-space-guard.sh'])
    writeFileSync(join(stage, '.env'), 'ALLOWED_CHAT_ID=42\n')
    mkdirSync(join(stage, '.claude', 'channels', 'telegram'), { recursive: true })
    writeFileSync(join(stage, '.claude', 'channels', 'telegram', '.env'), `TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}\n`)
    const scratch = join(stage, 'scratch')
    mkdirSync(scratch, { recursive: true })
    const env = {
      DISK_GUARD_USAGE_OVERRIDE: '96',
      DISK_GUARD_SCRATCH_DIR: scratch,
      DISK_GUARD_STATE_DIR: join(stage, 'store'),
    }
    return { bin, env, stamp: join(stage, 'store', '.disk-guard-alerted') }
  }
  it('an ok:false rejection no longer logs "owner alerted" and does NOT start the 1h cooldown', () => {
    const { bin, env, stamp } = setup()
    const r = runScript('disk-space-guard.sh', [], { ...env, CURL_STUB_BODY: '{"ok":false,"error_code":400,"description":"chat not found"}' }, bin)
    expect(r.status).toBe(0)
    // RED-BEFORE: the old script logged "owner alerted via direct Bot API"
    // on exactly this input and stamped the cooldown.
    expect(existsSync(stamp)).toBe(false)
    expect(r.stdout + r.stderr).not.toContain('owner alerted')
  })
  it('confirmed delivery stamps the cooldown', () => {
    const { bin, env, stamp } = setup()
    const r = runScript('disk-space-guard.sh', [], env, bin)
    expect(r.status).toBe(0)
    expect(existsSync(stamp)).toBe(true)
    expect(r.stdout + r.stderr).toContain('delivery confirmed')
  })
})
