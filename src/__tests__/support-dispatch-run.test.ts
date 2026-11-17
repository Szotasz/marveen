// The `run <text>` subcommand of the support dispatcher (SUPPORTKULCS1109, v8 D7), run for real under /bin/sh.
//
// Same harness as support-dispatch.test.ts: a home with a kit, a manifest, a token and the line the REAL line builder
// gives (here with consent 2), and the dispatcher's one test seam, its PATH line, with a fake tools folder in front.
// The fakes added here: getent and `id -P` give a password-database line whose home is the test home and whose shell
// is a fake login shell; od fails for /dev/urandom on request. The command itself runs for real.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { buildSupportLine } from '../support-access-line.js'
import { fingerprintOfBlob } from '../support-access-pins.js'
import { SUPPORT_TOKEN_FILE } from '../support-access-token.js'
import { formatKitManifest } from '../support-kit.js'
import { SUPPORT_CONSENT_VERSION } from '../support-standby-enable.js'
import { stopRunningDispatchers, SUPPORT_SPOOL_DIR } from '../support-group-record.js'
import { TEST_ONLY_FROM, TEST_ONLY_KEYS } from './helpers/sk-test-keys.js'

const ROOT = join(__dirname, '..', '..')
const SOURCE = readFileSync(join(ROOT, 'scripts', 'support-dispatch.sh'), 'utf8')
const PATH_LINE = 'PATH=/usr/bin:/bin:/usr/sbin:/sbin\n'
const GRANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const KEY = TEST_ONLY_KEYS[0]
const FP = fingerprintOfBlob(KEY.pub)
const TOKEN = 'mst_' + 'A'.repeat(43)
const UNTIL = '"2026-11-15T14:00:00Z"'
const allowBody = (decision = 'allow'): string =>
  '{"armed":true,"armed_until":' + UNTIL + ',"subscription_active":true,"decision":"' + decision + '","active_keys":["' + FP + '"],"retired_keys":[]}'

const FAKE_CURL = `#!/bin/sh
dir=$(dirname "$0")
cat > /dev/null
out=
while [ $# -gt 0 ]; do
  case $1 in --output) out=$2; shift ;; esac
  last=$1; shift
done
case $last in
  http://127.0.0.1*) printf '200'; exit 0 ;;
esac
echo check >> "$dir/checks"
cat "$dir/body" > "$out"
cat "$dir/code"
`
const FAKE_PS = `#!/bin/sh
dir=$(dirname "$0")
field=$2; pid=$4
sshd=$(cat "$dir/sshd_pid")
case $field in
  comm=) if [ "$pid" = "$sshd" ]; then echo sshd-session; else echo sh; fi ;;
  ppid=) echo "$sshd" ;;
  etime=) cat "$dir/etime" ;;
esac
`
const FAKE_GETENT = '#!/bin/sh\ncat "$(dirname "$0")/pwline"\n'
const FAKE_ID = '#!/bin/sh\ncase $1 in -P) cat "$(dirname "$0")/pwline" ;; *) exec /usr/bin/id "$@" ;; esac\n'
// for /dev/urandom: fails (no_random), or gives 32 characters of the right length that are not hex (bad_random)
const FAKE_OD =
  '#!/bin/sh\ncase "$*" in *urandom*)\n  [ -f "$(dirname "$0")/no_random" ] && exit 1\n' +
  '  [ -f "$(dirname "$0")/bad_random" ] && { echo " zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz"; exit 0; } ;;\nesac\nexec /usr/bin/od "$@"\n'
// A login shell whose profile talks, sets a PATH, and prints a marker-like line of its own BEFORE the dispatcher's.
const FAKE_LOGIN_SH = `#!/bin/sh
echo login >> "$(dirname "$0")/login.calls"
echo 'profile says hello MVPATH=/not/at/line/start'
echo 'MVPATH=/early/one'
PATH=/opt/login/bin:$PATH
export PATH
exec /bin/sh -c "$2"
`

let home: string
let bin: string
let kit: string
let dispatch: string
let supportDir: string

function writeExe(path: string, text: string): void {
  writeFileSync(path, text)
  chmodSync(path, 0o755)
}

function setup(consent = 2): void {
  home = mkdtempSync(join(tmpdir(), 'dispatch-run-'))
  bin = join(home, 'fakebin')
  supportDir = join(home, '.marveen', 'support')
  kit = join(supportDir, 'kit')
  const install = join(home, 'install')
  mkdirSync(bin, { recursive: true })
  mkdirSync(kit, { recursive: true, mode: 0o700 })
  mkdirSync(join(install, 'store'), { recursive: true })
  mkdirSync(join(home, '.ssh'), { mode: 0o700 })
  writeExe(join(bin, 'curl'), FAKE_CURL)
  writeExe(join(bin, 'ps'), FAKE_PS)
  writeExe(join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n')
  writeExe(join(bin, 'getent'), FAKE_GETENT)
  writeExe(join(bin, 'id'), FAKE_ID)
  writeExe(join(bin, 'od'), FAKE_OD)
  writeExe(join(bin, 'loginsh'), FAKE_LOGIN_SH)
  const u = userInfo()
  writeFileSync(join(bin, 'pwline'), u.username + ':x:' + u.uid + ':' + u.gid + '::' + home + ':' + join(bin, 'loginsh') + '\n')
  writeFileSync(join(bin, 'sshd_pid'), '424242\n')
  writeFileSync(join(bin, 'etime'), '05:00\n')
  writeFileSync(join(bin, 'body'), allowBody())
  writeFileSync(join(bin, 'code'), '200')
  expect(SOURCE.split(PATH_LINE).length - 1).toBe(1)
  dispatch = join(kit, 'support-dispatch.sh')
  writeFileSync(dispatch, SOURCE.replace(PATH_LINE, 'PATH=' + bin + ':/usr/bin:/bin:/usr/sbin:/sbin\n'))
  writeFileSync(
    join(kit, 'manifest'),
    formatKitManifest({ files: { 'support-dispatch.sh': 'a'.repeat(64) }, installRoot: install, nodePath: '/bin/echo', nodeMin: 20, release: 'abcdef1' }),
  )
  writeFileSync(join(supportDir, SUPPORT_TOKEN_FILE), TOKEN + '\n', { mode: 0o600 })
  const line = buildSupportLine({ key: KEY, grantId: GRANT, consentVersion: consent, dispatchPath: dispatch, fromCidrs: TEST_ONLY_FROM, sshd: { major: 9, minor: 6 } })
  writeFileSync(join(home, '.ssh', 'authorized_keys'), line + '\n', { mode: 0o600 })
}

const args = (consent = '2'): string[] => [dispatch, '--key', KEY.name, '--fp', FP, '--grant', GRANT, '--consent', consent]
const ENV = (extra: Record<string, string> = {}) => ({ SSH_CONNECTION: '203.0.113.7 51000 198.51.100.2 22', ...extra })

type Result = { status: number | null; stdout: Buffer; stderr: string }

function ssh(command: string, opts: { input?: Buffer | string; consent?: string; env?: Record<string, string> } = {}): Result {
  const r = spawnSync('/bin/sh', args(opts.consent), {
    env: ENV({ SSH_ORIGINAL_COMMAND: command, ...opts.env }),
    input: opts.input ?? '',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.toString('utf8') }
}
const run = (text: string, opts: { input?: Buffer | string; consent?: string; env?: Record<string, string> } = {}): Result => ssh('run ' + text, opts)

function runAsync(command: string): { done: Promise<Result & { ms: number }> } {
  const started = Date.now()
  const child = spawn('/bin/sh', args(), { env: ENV({ SSH_ORIGINAL_COMMAND: 'run ' + command }), stdio: ['ignore', 'pipe', 'pipe'] })
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout.on('data', (d: Buffer) => out.push(d))
  child.stderr.on('data', (d: Buffer) => err.push(d))
  const done = new Promise<Result & { ms: number }>((resolve) => {
    child.on('close', (status) => resolve({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), ms: Date.now() - started }))
  })
  return { done }
}

type Event = Record<string, string>
function events(): Event[] {
  const spool = join(supportDir, SUPPORT_SPOOL_DIR)
  if (!existsSync(spool)) return []
  return readdirSync(spool)
    .filter((f) => f.endsWith('.evt'))
    .map((f) => Object.fromEntries(readFileSync(join(spool, f), 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])))
}
const runEvents = (kind = 'run') => events().filter((e) => e.event === kind)
const reason = (stderr: string) => /\(([a-z_]+)\)/.exec(stderr)?.[1] ?? ''
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Wait for an observable state, never for a fixed time (a loaded machine is slow: Samu's review of #2800, as on #2786).
async function waitFor(what: string, ok: () => boolean, limitMs = 20_000): Promise<void> {
  const until = Date.now() + limitMs
  while (!ok()) {
    if (Date.now() > until) throw new Error('timed out waiting for: ' + what)
    await sleepMs(50)
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeEach(() => setup())
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('run <text>: the command runs, and is logged before and after', () => {
  it('stdout, exit code and one start and one end event with the same random id', () => {
    const r = run('printf hi')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout.toString()).toBe('hi')
    const [start] = runEvents('run_start')
    const [end] = runEvents('run')
    expect(start.id).toMatch(/^[0-9a-f]{32}$/)
    expect(end.id).toBe(start.id)
    expect(start).toMatchObject({ exit: '-1', command: 'printf hi', fp: FP, key: KEY.name, grant: GRANT, client: '203.0.113.7' })
    expect(end).toMatchObject({ exit: '0', reason: 'done', stdout_bytes: '2', stderr_bytes: '0', stdin_bytes: '0', env: 'passwd', command: 'printf hi', fp: FP })
    expect(Number(end.duration_ms)).toBeGreaterThanOrEqual(0)
  })

  it('two runs get two different ids', () => {
    run('true')
    run('true')
    const ids = runEvents().map((e) => e.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('the exit code and stderr pass through; stderr is counted', () => {
    const r = run('printf abc >&2; exit 7')
    expect(r.status).toBe(7)
    expect(r.stderr).toBe('abc')
    expect(runEvents()[0]).toMatchObject({ exit: '7', stderr_bytes: '3', stdout_bytes: '0' })
  })

  it('stdin reaches the command byte for byte (file transfer by run \'cat > path\'), and is counted', () => {
    const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256))
    const target = join(home, 'copied.bin')
    const r = run("cat > '" + target + "'", { input: bytes })
    expect(r.status).toBe(0)
    expect(readFileSync(target).equals(bytes)).toBe(true)
    expect(runEvents()[0].stdin_bytes).toBe(String(bytes.length))
  })

  it('a 3 MB output written as fast as it goes reaches the client whole and is counted', () => {
    // 3 MB written as fast as possible, then the command exits at once: the last pipe-buffer of it is still on its
    // way through the relay when the dispatcher sees the exit, and must not be cut off.
    const r = run('head -c 3000000 /dev/zero')
    expect(r.status).toBe(0)
    expect(r.stdout.length).toBe(3_000_000)
    expect(runEvents()[0].stdout_bytes).toBe('3000000')
  })

  it('a slow client still gets all of it: the command exits while its output waits in the relay (M31)', () => {
    // A reader that waits 1 s before it reads, like a slow ssh client: every byte must still arrive and be counted.
    // This guards the relay against cutting a slow reader. It does NOT reliably catch the mutant that drops the
    // relay grace (M31): whether bytes are still in the relay when the command exits depends on how the pipes fill
    // on this machine. That mutant is measured outside the suite (meres/d7/slow-reader.sh, a 2 s reader): Debian 12,
    // 100 kB: with the grace 100000 of 100000, without it 65536 of 100000, 3 of 3 runs each.
    const r = spawnSync('/bin/sh', ['-c', '"$@" | (sleep 1; wc -c)', 'sh', '/bin/sh', ...args()], {
      env: ENV({ SSH_ORIGINAL_COMMAND: 'run head -c 80000 /dev/zero' }),
      input: '',
      timeout: 30_000,
    })
    expect(r.stdout.toString().trim()).toBe('80000')
    expect(runEvents()[0]).toMatchObject({ exit: '0', stdout_bytes: '80000' })
  })

  it('a large stdout passes whole and is counted', () => {
    const r = run('i=0; while [ $i -lt 2000 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done')
    expect(r.stdout.length).toBe(2000 * 41)
    expect(runEvents()[0].stdout_bytes).toBe(String(2000 * 41))
  })
})

describe('run <text>: the environment is assembled here, nothing comes from the client', () => {
  it('HOME, USER, LOGNAME, SHELL from the password database, PATH from the login shell, LANG=C.UTF-8, and nothing else', () => {
    const r = run('env', { env: { LANG: 'hu_HU.UTF-8', LC_ALL: 'hu_HU.UTF-8', LC_FOO: 'client', EVIL: '1' } })
    const env = Object.fromEntries(r.stdout.toString().trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    const u = userInfo()
    expect(env.HOME).toBe(home)
    expect(env.USER).toBe(u.username)
    expect(env.LOGNAME).toBe(u.username)
    expect(env.SHELL).toBe(join(bin, 'loginsh'))
    expect(env.LANG).toBe('C.UTF-8')
    expect(env.PATH.startsWith('/opt/login/bin:')).toBe(true)
    for (const k of ['LC_ALL', 'LC_FOO', 'EVIL', 'SSH_ORIGINAL_COMMAND', 'SSH_CONNECTION']) expect(env[k], k).toBeUndefined()
  })

  it('the login shell is asked once, its own output never reaches the client, and only the last marker line counts', () => {
    const r = run('echo "$PATH"')
    expect(readFileSync(join(bin, 'login.calls'), 'utf8')).toBe('login\n')
    expect(r.stdout.toString()).not.toContain('profile says hello')
    expect(r.stdout.toString()).not.toContain('/early/one')
  })

  it('a login PATH of another shape is not taken: the fixed PATH', () => {
    writeExe(join(bin, 'loginsh'), '#!/bin/sh\nprintf "\\nMVPATH=relative/bin:/usr/bin\\n"\n')
    const r = run('echo "$PATH"')
    expect(r.stdout.toString()).toBe(bin + ':/usr/bin:/bin:/usr/sbin:/sbin\n')
  })

  it('no usable password entry: the support home, /bin/sh, the fixed PATH, and the event says fallback', () => {
    writeFileSync(join(bin, 'pwline'), 'someoneelse:x:1:1::/home/x:/bin/sh\n')
    const r = run('echo "$HOME $SHELL $PATH"')
    expect(r.stdout.toString()).toBe(home + ' /bin/sh ' + bin + ':/usr/bin:/bin:/usr/sbin:/sbin\n')
    expect(existsSync(join(bin, 'login.calls'))).toBe(false)
    expect(runEvents()[0].env).toBe('fallback')
  })
})

describe('run <text>: refused before anything runs', () => {
  const marker = () => join(home, 'ran')
  it('under consent 1 (a v1 machine keeps the fixed subcommands)', () => {
    rmSync(home, { recursive: true, force: true })
    setup(1)
    const r = run("touch '" + marker() + "'", { consent: '1' })
    expect(r.status).toBe(1)
    expect(reason(r.stderr)).toBe('consent_too_old')
    expect(existsSync(marker())).toBe(false)
    expect(runEvents('run_start')).toEqual([])
  })
  it('NOT refused: a line made with the consent version this release enables (2, the approved v2 text) runs (Samu 78909)', () => {
    // Until the approved v2 text shipped, the constant was 1 and this test pinned the refusal; now it pins the opening.
    expect(SUPPORT_CONSENT_VERSION).toBe(2)
    rmSync(home, { recursive: true, force: true })
    setup(SUPPORT_CONSENT_VERSION)
    const r = run("touch '" + marker() + "'", { consent: String(SUPPORT_CONSENT_VERSION) })
    expect(r.status).toBe(0)
    expect(existsSync(marker())).toBe(true)
  })
  it('without a yes from marveen.io', () => {
    writeFileSync(join(bin, 'body'), allowBody('deny'))
    const r = run("touch '" + marker() + "'")
    expect(reason(r.stderr)).toBe('not_allowed')
    expect(existsSync(marker())).toBe(false)
  })
  it('when the connection is 60 minutes old', () => {
    writeFileSync(join(bin, 'etime'), '01:00:00\n')
    const r = run("touch '" + marker() + "'")
    expect(reason(r.stderr)).toBe('connection_too_old')
    expect(existsSync(marker())).toBe(false)
  })
  it('when the random event id has the right length but is not hex', () => {
    writeFileSync(join(bin, 'bad_random'), '')
    const r = run("touch '" + marker() + "'")
    expect(reason(r.stderr)).toBe('no_event_id')
    expect(existsSync(marker())).toBe(false)
  })
  it('when no random event id can be read', () => {
    writeFileSync(join(bin, 'no_random'), '')
    const r = run("touch '" + marker() + "'")
    expect(reason(r.stderr)).toBe('no_event_id')
    expect(existsSync(marker())).toBe(false)
  })
  it('when the start cannot be logged', () => {
    const spool = join(supportDir, SUPPORT_SPOOL_DIR)
    mkdirSync(spool, { recursive: true })
    chmodSync(spool, 0o500)
    try {
      const r = run("touch '" + marker() + "'")
      expect(reason(r.stderr)).toBe('spool_unwritable')
      expect(existsSync(marker())).toBe(false)
    } finally {
      chmodSync(spool, 0o700)
    }
  })
  // The measured subsystem forms (16.1): under a forced command they arrive as the command, and the closed list refuses them.
  it.each(['run', 'internal-sftp', '/usr/lib/openssh/sftp-server', '/usr/lib/openssh/sftp-server ', 'scp -t x', 'scp -f x', 'RUN true', ' run true'])(
    '%j is not a run: unknown_command',
    (command) => {
      const r = ssh(command)
      expect(r.status).toBe(1)
      expect(reason(r.stderr)).toBe('unknown_command')
      expect(runEvents('run_start')).toEqual([])
    },
  )
})

describe('run <text>: the logged text is redacted, then escaped, then cut', () => {
  it('a secret goes, control bytes and backslash are escaped, the text stays on one line', () => {
    run('printf "%s\\n" "Authorization: Bearer abcdefghij" ' + TOKEN + ' \'a\\b\'\nexit 0')
    const cmd = runEvents()[0].command
    expect(cmd).not.toContain('abcdefghij')
    expect(cmd).not.toContain(TOKEN)
    expect(cmd).toContain('[redacted')
    expect(cmd).toContain('\\x0Aexit 0')
    expect(cmd).toContain("'a\\\\b'")
  })
  it('cut at 4096 bytes on a character boundary; a long secret is redacted whole before the cut', () => {
    const long = 'echo ' + 'é'.repeat(3000) + ' mst_' + 'B'.repeat(43)
    run(long)
    const cmd = runEvents()[0].command
    expect(Buffer.byteLength(cmd)).toBeLessThanOrEqual(4096)
    expect(Buffer.byteLength(cmd)).toBeGreaterThan(4090)
    expect(cmd).not.toContain('\ufffd')
    expect(cmd).not.toContain('BBBB')
  })
})

describe('run <text>: stopped at the cap, by a disable, by a revoke; the whole group goes', () => {
  // A grandchild in the background, left to init when its parent dies: only a stop of the whole process group
  // reaches it (the fake pgrep sees no children). One ignores TERM, so only the group KILL ends it; the other leaves
  // a marker on TERM and exits, which shows the group TERM comes first (Dani's review of #2800).
  const pidFile = () => join(home, 'grandchild.pid')
  const termMarker = () => join(home, 'grandchild.term')
  const ignoresTerm = () => "sh -c 'echo $$ > " + pidFile() + "; trap \"\" TERM; while :; do sleep 1; done' & sleep 60"
  const leavesOnTerm = () => "sh -c 'echo $$ > " + pidFile() + '; trap "sleep 1; touch ' + termMarker() + "; exit 0\" TERM; while :; do sleep 1; done' & sleep 60"

  it('the cap is what is left of the 60 minutes; a grandchild that ignores TERM is killed with the group; the end event says -1', async () => {
    writeFileSync(join(bin, 'etime'), '59:57\n')
    const { done } = runAsync(ignoresTerm())
    const r = await done
    expect(r.status).toBe(1)
    expect(reason(r.stderr)).toBe('time_cap')
    expect(r.ms).toBeLessThan(20_000)
    const pid = Number(readFileSync(pidFile(), 'utf8'))
    await waitFor('the grandchild to be gone', () => !alive(pid), 5_000)
    expect(runEvents()[0]).toMatchObject({ exit: '-1', reason: 'time_cap' })
  }, 60_000)

  it('the group gets TERM before KILL: a grandchild that exits on TERM leaves its marker', async () => {
    writeFileSync(join(bin, 'etime'), '59:57\n')
    const { done } = runAsync(leavesOnTerm())
    expect(reason((await done).stderr)).toBe('time_cap')
    const pid = Number(readFileSync(pidFile(), 'utf8'))
    await waitFor('the grandchild to be gone', () => !alive(pid), 5_000)
    expect(existsSync(termMarker())).toBe(true)
  }, 60_000)

  it('a disable stops the whole group too (a grandchild that ignores TERM)', async () => {
    const { done } = runAsync(ignoresTerm())
    await waitFor('the grandchild to run', () => existsSync(pidFile()) && readFileSync(pidFile(), 'utf8').trim() !== '')
    const pid = Number(readFileSync(pidFile(), 'utf8'))
    expect(stopRunningDispatchers(supportDir)).toBe(1)
    expect(reason((await done).stderr)).toBe('disabled')
    await waitFor('the grandchild to be gone', () => !alive(pid), 5_000)
  }, 60_000)

  // The command itself writes the marker, so the stop below always hits a command that is running (past the gate).
  const running = () => join(home, 'running')
  const startedCommand = (rest: string) => "touch '" + running() + "'; " + rest

  it('a disable (the run file goes) stops a running run at once', async () => {
    const { done } = runAsync(startedCommand('sleep 30'))
    await waitFor('the command to run', () => existsSync(running()))
    const triggered = Date.now()
    expect(stopRunningDispatchers(supportDir)).toBe(1)
    const r = await done
    expect(reason(r.stderr)).toBe('disabled')
    expect(Date.now() - triggered).toBeLessThan(10_000)
    expect(runEvents()[0]).toMatchObject({ exit: '-1', reason: 'disabled' })
  }, 60_000)

  it('the token going stops a running run at once', async () => {
    const { done } = runAsync(startedCommand('sleep 30'))
    await waitFor('the command to run', () => existsSync(running()))
    const triggered = Date.now()
    rmSync(join(supportDir, SUPPORT_TOKEN_FILE))
    const r = await done
    expect(reason(r.stderr)).toBe('disabled')
    expect(Date.now() - triggered).toBeLessThan(10_000)
  }, 60_000)

  it('marveen.io saying no at the minute recheck stops a running run (R4)', async () => {
    const { done } = runAsync(startedCommand('sleep 120'))
    await waitFor('the command to run', () => existsSync(running()))
    const triggered = Date.now()
    writeFileSync(join(bin, 'body'), allowBody('deny'))
    const r = await done
    expect(reason(r.stderr)).toBe('revoked')
    expect(Date.now() - triggered).toBeLessThan(70_000)
    expect(readFileSync(join(bin, 'checks'), 'utf8').trim().split('\n')).toHaveLength(2)
    expect(runEvents()[0]).toMatchObject({ exit: '-1', reason: 'revoked' })
  }, 90_000)
})

describe('run <text>: persistence points before and after (R3)', () => {
  it('a new user unit shows up in the end event', () => {
    run('mkdir -p "$HOME/.config/systemd/user" && echo x > "$HOME/.config/systemd/user/evil.service"')
    expect(runEvents()[0].persistence).toContain('+~/.config/systemd/user/evil.service')
  })
  it('a point the login profile itself writes is in the diff too (the snapshot is taken before the login shell)', () => {
    writeExe(join(bin, 'loginsh'), '#!/bin/sh\nmkdir -p "$HOME/.config/systemd/user"\necho x > "$HOME/.config/systemd/user/profile.service"\nexec /bin/sh -c "$2"\n')
    run('true')
    expect(runEvents()[0].persistence).toContain('+~/.config/systemd/user/profile.service')
  })
  it('nothing changed: empty', () => {
    run('true')
    expect(runEvents()[0].persistence).toBe('')
  })
})

describe('run <text>: a byte that is not UTF-8 in the command', () => {
  it('is logged escaped, a valid character next to it passes whole, and the text stays valid UTF-8', () => {
    // node cannot put a raw byte into an environment value; a shell in front of the dispatcher does
    const r = spawnSync('/bin/sh', ['-c', 'SSH_ORIGINAL_COMMAND="run true a$(printf \'\\377\\303\')b é" exec /bin/sh "$@"', 'sh', ...args()], {
      env: ENV(),
      input: '',
    })
    expect(r.status).toBe(0)
    const cmd = runEvents()[0].command
    expect(cmd).toBe('true a\\xFF\\xC3b é')
  })
})

describe('a fixed subcommand stops at once on a disable too', () => {
  it('restart (a slow stop.sh) stops when the token goes', async () => {
    const scripts = join(home, 'install', 'scripts')
    mkdirSync(scripts, { recursive: true })
    const marker = join(home, 'stopping')
    // stop.sh says it is running before it waits, so the token goes only after the gate let the subcommand start
    writeFileSync(join(scripts, 'stop.sh'), "touch '" + marker + "'\nsleep 30\n")
    const child = spawn('/bin/sh', args(), { env: ENV({ SSH_ORIGINAL_COMMAND: 'restart' }), stdio: ['ignore', 'pipe', 'pipe'] })
    const err: Buffer[] = []
    child.stderr.on('data', (d: Buffer) => err.push(d))
    const done = new Promise<number | null>((resolve) => child.on('close', resolve))
    await waitFor('stop.sh to run', () => existsSync(marker))
    const triggered = Date.now()
    rmSync(join(supportDir, SUPPORT_TOKEN_FILE))
    expect(await done).toBe(1)
    expect(reason(Buffer.concat(err).toString())).toBe('disabled')
    expect(Date.now() - triggered).toBeLessThan(10_000)
    expect(events().some((e) => e.event === 'stopped' && e.reason === 'disabled')).toBe(true)
  }, 60_000)
})

describe('status prints the last runs from the spool (D5)', () => {
  it('oldest first, at most 20, with the exit code and the logged text', () => {
    run('printf one')
    run('exit 3')
    const r = ssh('status')
    const lines = r.stdout.toString().split('\n').filter((l) => l.startsWith('run '))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^run time=\d+ exit=0 ms=\d+ command=printf one$/)
    expect(lines[1]).toMatch(/ exit=3 .*command=exit 3$/)
  })
})
