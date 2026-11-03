import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync, cpSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'

// NOTIFYVAKSWEEP826 round 2: the remaining Telegram senders move to the shared
// contract (telegram_api_call generalizes it beyond sendMessage), their
// cooldown/backoff/state stamps move to after-confirmed-delivery, and the
// watchdog replay path -- until now a fully RECORD-LESS injection route
// (MSGSZIVARGAS826) -- writes a dated marker per injected message. Empirical
// staged-tree tests, PATH-stubbed curl/tmux, nothing leaves the machine.
// stuck-modal-guard is the one static-only conversion (running it needs a live
// stuck tmux session); its alert_owner is byte-identical to the disk-guard
// family measured in round 1, and bash -n covers syntax.
const ROOT = join(__dirname, '..', '..')
const FAKE_TOKEN = '1234567890:TESTTOKENTESTTOKEN'

let stage: string
beforeEach(() => { stage = mkdtempSync(join(tmpdir(), 'send-r2-')) })
afterEach(() => { rmSync(stage, { recursive: true, force: true }) })

function stageTree(scriptNames: string[]): { bin: string } {
  const scripts = join(stage, 'scripts')
  mkdirSync(join(scripts, 'lib'), { recursive: true })
  mkdirSync(join(stage, 'store'), { recursive: true })
  for (const s of scriptNames) cpSync(join(ROOT, 'scripts', s), join(scripts, s))
  cpSync(join(ROOT, 'scripts', 'lib', 'send-telegram.sh'), join(scripts, 'lib', 'send-telegram.sh'))
  cpSync(join(ROOT, 'scripts', 'lib', 'owner-chat.sh'), join(scripts, 'lib', 'owner-chat.sh'))
  cpSync(join(ROOT, 'scripts', 'lib', 'curl-tok.sh'), join(scripts, 'lib', 'curl-tok.sh'))
  const bin = join(stage, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'curl'),
    '#!/bin/bash\necho "$@" >> "${CURL_ARGV_LOG:-/dev/null}"\ncat >> "${CURL_STDIN_LOG:-/dev/null}"\nif [ "${CURL_STUB_EXIT:-0}" -ne 0 ]; then\n  echo "curl: (6) Could not resolve host for https://api.telegram.org/bot${CURL_STUB_TOKEN:-}/x" >&2\n  exit "${CURL_STUB_EXIT}"\nfi\nprintf \'%s\' "${CURL_STUB_BODY:-{\\"ok\\":true}}"\n')
  writeFileSync(join(bin, 'sleep'), '#!/bin/bash\nexit 0\n') // set-bot-menu sleeps 15s; irrelevant here
  writeFileSync(join(bin, 'tmux'), '#!/bin/bash\necho "$@" >> "${TMUX_ARGV_LOG:-/dev/null}"\nexit 0\n')
  for (const b of ['curl', 'sleep', 'tmux']) chmodSync(join(bin, b), 0o755)
  return { bin }
}

function run(rel: string, env: Record<string, string>, bin: string, args: string[] = []) {
  return spawnSync('/bin/bash', [join(stage, 'scripts', rel), ...args], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: stage,
      CURL_STUB_TOKEN: FAKE_TOKEN,
      CURL_ARGV_LOG: join(stage, 'curl-argv.log'),
      CURL_STDIN_LOG: join(stage, 'curl-stdin.log'),
      ...env,
    },
    encoding: 'utf-8',
    timeout: 20000,
  })
}

describe('telegram_api_call: the generalized contract', () => {
  const driver = (call: string, env: Record<string, string> = {}) => {
    const { bin } = stageTree([])
    writeFileSync(join(stage, 'scripts', 'driver.sh'), `#!/bin/bash\n. "$(dirname "$0")/lib/send-telegram.sh"\n${call}\n`)
    return run('driver.sh', env, bin)
  }
  it('succeeds only on ok:true, for any method', () => {
    expect(driver(`telegram_api_call "${FAKE_TOKEN}" setMyCommands -d '{}'`).status).toBe(0)
  })
  it('POSITIVE CONTROL: rejection is loud, method named, token redacted', () => {
    const r = driver(`telegram_api_call "${FAKE_TOKEN}" setMyCommands -d '{}'`,
      { CURL_STUB_BODY: '{"ok":false,"description":"Bad Request"}' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('setMyCommands')
    expect(r.stderr).not.toContain(FAKE_TOKEN)
  })
  it('send_telegram_message still honors the round-1 contract through the wrapper', () => {
    const r = driver(`send_telegram_message "${FAKE_TOKEN}" 42 "hello"`, { CURL_STUB_EXIT: '6' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('curl exit 6')
    expect(r.stderr).toContain('<token>')
  })
})

describe('telegram_api_call: the token never reaches curl argv', () => {
  // A URL argument is world-readable while curl runs (ps -ww, /proc/<pid>/cmdline),
  // so the Bot API URL travels as a curl -K - config line on stdin instead
  // (the lib/curl-tok.sh trick). The stub records both streams.
  it('one successful call: no token in the argv log, the full url line in the stdin log', () => {
    const { bin } = stageTree([])
    writeFileSync(join(stage, 'scripts', 'driver.sh'),
      `#!/bin/bash\n. "$(dirname "$0")/lib/send-telegram.sh"\ntelegram_api_call "${FAKE_TOKEN}" sendMessage --data-urlencode "chat_id=42" --data-urlencode "text=hi"\n`)
    const r = run('driver.sh', {}, bin)
    expect(r.status).toBe(0)
    const argv = readFileSync(join(stage, 'curl-argv.log'), 'utf-8')
    expect(argv).not.toContain(FAKE_TOKEN)
    expect(argv).toContain('-K -') // the config really came from stdin
    const stdinLog = readFileSync(join(stage, 'curl-stdin.log'), 'utf-8')
    expect(stdinLog).toContain(`url = "https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage"`)
  })
  it('a token containing a double quote is refused before curl is ever reached', () => {
    const { bin } = stageTree([])
    writeFileSync(join(stage, 'scripts', 'driver.sh'),
      `#!/bin/bash\n. "$(dirname "$0")/lib/send-telegram.sh"\ntelegram_api_call 'bad"token' sendMessage\n`)
    const r = run('driver.sh', {}, bin)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('the token, method or API base contains a quote, backslash or newline -- refusing (nothing would be delivered)')
    expect(r.stderr).toContain('telegram_api_call(sendMessage)')
    expect(existsSync(join(stage, 'curl-argv.log'))).toBe(false) // the stub was NOT called
    expect(existsSync(join(stage, 'curl-stdin.log'))).toBe(false)
  })
})

describe('set-bot-menu.sh: honest outcome', () => {
  const setup = () => {
    const { bin } = stageTree(['set-bot-menu.sh'])
    writeFileSync(join(stage, '.env'), `CHANNEL_PROVIDER=telegram\nTELEGRAM_BOT_TOKEN=${FAKE_TOKEN}\n`)
    return { bin }
  }
  it('reports success only on ok:true', () => {
    const { bin } = setup()
    const r = run('set-bot-menu.sh', {}, bin)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Bot menu updated')
  })
  it('RED-BEFORE: a failed call no longer claims "Bot menu updated"', () => {
    const { bin } = setup()
    const r = run('set-bot-menu.sh', { CURL_STUB_EXIT: '6' }, bin)
    expect(r.status).toBe(1)
    expect(r.stdout).not.toContain('Bot menu updated')
    expect(r.stderr).toContain('FAILED')
  })
  it('ELSOKOR922 D-4: registry commands from the dashboard join the menu, on both scopes', () => {
    const { bin } = setup()
    writeFileSync(join(stage, 'store', '.dashboard-token'), 'dash-tok\n')
    // Own curl stub: the shared one's `${CURL_STUB_BODY:-{...}}` default
    // appends a stray `}` to any body that is set, which JSON cannot survive.
    writeFileSync(join(bin, 'curl'), '#!/bin/bash\necho "$@" >> "$CURL_ARGV_LOG"\ncat >> "${CURL_STDIN_LOG:-/dev/null}"\nprintf %s "$MENU_BODY"\n')
    const r = run('set-bot-menu.sh', {
      MENU_BODY: '{"ok":true,"commands":[{"command":"status","description":"Rendszer-állapot"},{"command":"queue","description":"Sor"}]}',
    }, bin)
    expect(r.status).toBe(0)
    const argv = readFileSync(join(stage, 'curl-argv.log'), 'utf-8')
    expect(argv).toContain('/api/commands/menu')
    // The Bot API URL is a curl -K - config line on stdin now, not an argument
    // (token secrecy): the two setMyCommands calls must show up there.
    const stdinLog = readFileSync(join(stage, 'curl-stdin.log'), 'utf-8')
    const urls = stdinLog.split('\n').filter(l => l.includes('setMyCommands'))
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain(`url = "https://api.telegram.org/bot${FAKE_TOKEN}/setMyCommands"`)
    // Their -d payloads are still plain curl arguments.
    const sets = argv.split('\n').filter(l => l.includes('"commands"'))
    expect(sets).toHaveLength(2)
    expect(sets[0]).toContain('"command": "queue"')
    expect(sets[0]).toContain('"description": "Rendszer-állapot"')
    expect(sets[0]).not.toContain('Futó feladatok állapota')
    expect(sets[1]).toContain('all_private_chats')
  })
})

describe('fleet-memory-gate.sh: cooldown stamp only after confirmed delivery', () => {
  const setup = () => {
    const { bin } = stageTree(['fleet-memory-gate.sh'])
    const meminfo = join(stage, 'meminfo')
    // MemAvailable ~3% of MemTotal -> critical band, alert path taken
    writeFileSync(meminfo, 'MemTotal:       16000000 kB\nMemAvailable:     480000 kB\n')
    const tgEnv = join(stage, 'tg.env')
    writeFileSync(tgEnv, `TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}\n`)
    const env = {
      MEMGATE_PROC_MEMINFO: meminfo,
      TELEGRAM_ENV: tgEnv,
      MARVEEN_ALERT_CHAT_ID: '42',
      MEMGATE_STATE_DIR: join(stage, 'store'),
      MARVEEN_STORE: join(stage, 'store'),
    }
    return { bin, env, stamp: join(stage, 'store', '.fleet-memgate-alert') }
  }
  it('confirmed delivery writes the band stamp; failed delivery does not', () => {
    const { bin, env, stamp } = setup()
    const r1 = run('fleet-memory-gate.sh', { ...env, CURL_STUB_EXIT: '6' }, bin)
    // The gate's exit code is its VERDICT (10 = block in the hard band, by
    // design) -- a failed alert must not change the verdict, only the stamp.
    expect(r1.status).toBe(10)
    if (existsSync(stamp)) {
      // If the stamp path resolved elsewhere the assertion below would be
      // vacuous -- so assert the RESOLVED stamp is absent, not just this path.
      expect(readFileSync(stamp, 'utf-8')).toBe('')
    }
    const r2 = run('fleet-memory-gate.sh', env, bin)
    expect(r2.status).toBe(10) // same verdict, delivery now confirmed
    expect(existsSync(stamp)).toBe(true)
    expect(readFileSync(stamp, 'utf-8')).toMatch(/^\w+:\d+/)
  })
})

describe('github-pr-monitor.sh: failed alert keeps the snapshot for retry', () => {
  // The full script needs GNU grep -P (BSD grep exits 2 under set -e) -- known
  // portability note from the sweep; run on Linux CI, skip on darwin dev boxes.
  const linuxOnly = platform() === 'linux' ? it : it.skip
  const setup = () => {
    const { bin } = stageTree(['github-pr-monitor.sh'])
    // The script cd-s to its INSTALL_DIR (= the stage root) and reads .env +
    // store/ relative to it. gh stub: a single PR object with one comment.
    writeFileSync(join(stage, '.env'), `TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}\nALLOWED_CHAT_ID=42\n`)
    writeFileSync(join(stage, 'bin', 'gh'),
      '#!/bin/bash\nprintf \'{"state":"OPEN","reviewDecision":null,"reviews":[],"comments":[{"author":{"login":"x"},"createdAt":"2026-08-26T10:00:00Z"}],"title":"t"}\'\n')
    chmodSync(join(stage, 'bin', 'gh'), 0o755)
    const state = join(stage, 'store', '.github-pr-monitor-state')
    writeFileSync(state, '7\tOPEN|none|0|0|\n') // old signature differs (0 comments) -> change detected
    const envBase = { GITHUB_PR_MONITOR_PRS: '7', GITHUB_PR_MONITOR_REPO: 'o/r' }
    return { bin, state, envBase }
  }
  linuxOnly('keeps the old snapshot when the alert fails, persists on success', () => {
    const { bin, state, envBase } = setup()
    const r1 = run('github-pr-monitor.sh', { ...envBase, CURL_STUB_EXIT: '6' }, bin)
    expect(r1.stderr + r1.stdout).toContain('did NOT deliver')
    expect(readFileSync(state, 'utf-8')).toContain('OPEN|none|0|0|') // old snapshot kept
    const r2 = run('github-pr-monitor.sh', envBase, bin)
    expect(r2.stdout).toContain('change detected, alerted')
    expect(readFileSync(state, 'utf-8')).toContain('OPEN|none|0|1|') // fresh snapshot persisted
  })
  // #1555 review round 1: with no owner chat (the "0" placeholder and nothing
  // to fall back to) nothing is sent, so the change must NOT be marked as
  // reported -- a success return here used to drop the alert for good.
  linuxOnly('keeps the old snapshot when there is no owner chat to send to', () => {
    const { bin, state, envBase } = setup()
    writeFileSync(join(stage, '.env'), `TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}\nALLOWED_CHAT_ID=0\n`)
    const r = run('github-pr-monitor.sh', envBase, bin)
    expect(r.stderr + r.stdout).toContain('did NOT deliver')
    expect(existsSync(join(stage, 'curl-argv.log'))).toBe(false) // nothing went out
    expect(readFileSync(state, 'utf-8')).toContain('OPEN|none|0|0|') // old snapshot kept
  })
})

describe('watchdog-replay.py: the injection path now leaves a record (MSGSZIVARGAS826)', () => {
  const runReplay = (msgs: unknown[], env: Record<string, string> = {}) => {
    const { bin } = stageTree([])
    cpSync(join(ROOT, 'scripts', 'watchdog-replay.py'), join(stage, 'scripts', 'watchdog-replay.py'))
    const data = join(stage, 'msgs.json')
    writeFileSync(data, JSON.stringify(msgs))
    const logTarget = join(stage, 'store', 'dashboard.log')
    const r = spawnSync('python3', [join(stage, 'scripts', 'watchdog-replay.py'),
      'agent-testbot', 'testbot', '0', data, logTarget], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        TMUX_ARGV_LOG: join(stage, 'tmux-argv.log'),
        ...env,
      },
      encoding: 'utf-8',
      timeout: 60000,
    })
    return { r, logTarget, tmuxLog: join(stage, 'tmux-argv.log') }
  }
  it('writes one dated marker per injected message, with the msg id', () => {
    const { r, logTarget, tmuxLog } = runReplay([
      { id: 16029, to_agent: 'testbot', status: 'delivered', completed_at: null, created_at: 5, content: 'hello' },
      { id: 16030, to_agent: 'other', status: 'delivered', completed_at: null, created_at: 5, content: 'not mine' },
    ])
    expect(r.status).toBe(0)
    expect(existsSync(tmuxLog)).toBe(true) // injection provably attempted
    const lines = readFileSync(logTarget, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1) // only the addressed message, not the other agent's
    const marker = JSON.parse(lines[0])
    expect(marker.msg).toBe('watchdog-replay injected')
    expect(marker.id).toBe(16029)
    expect(marker.agent).toBe('testbot')
    // Full date in the stamp -- time-only lines are the measured instrument trap.
    expect(marker.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
  it('RED-BEFORE property: with no pending messages, no marker and no injection', () => {
    const { r, logTarget, tmuxLog } = runReplay([])
    expect(r.status).toBe(0)
    expect(existsSync(logTarget)).toBe(false)
    expect(existsSync(tmuxLog)).toBe(false)
  })
})

describe('stuck-modal-guard.sh: static conversion checks (live run needs a stuck session)', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'stuck-modal-guard.sh'), 'utf-8')
  it('sources the shared library and gates the backoff stamp on alert_owner success', () => {
    expect(src).toContain('lib/send-telegram.sh')
    expect(src).toMatch(/if alert_owner[\s\S]{0,400}BACKOFF_STAMP/)
  })
  it('KNOWN-POSITIVE control for the pattern check: the pre-conversion shape would fail it', () => {
    const old = 'alert_owner "..."\n      date +%s > "$BACKOFF_STAMP"'
    expect(old).not.toMatch(/if alert_owner[\s\S]{0,400}BACKOFF_STAMP.*\n.*else/)
  })
})
