// The support dispatcher (scripts/support-dispatch.sh), run for real under /bin/sh (SUPPORTKULCS1109, PR1c).
//
// Every case builds a home with a kit, a manifest, a token and the authorized_keys line the REAL line builder
// gives. The dispatcher's ONE test seam is its PATH line: the copy under test puts a fake tools folder in front
// (curl, ps, pgrep), which records what it was called with. Nothing reaches the network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSupportLine } from '../support-access-line.js'
import { fingerprintOfBlob } from '../support-access-pins.js'
import { formatKitManifest } from '../support-kit.js'
import { TEST_ONLY_FROM, TEST_ONLY_KEYS } from './helpers/sk-test-keys.js'

const ROOT = join(__dirname, '..', '..')
const SOURCE = readFileSync(join(ROOT, 'scripts', 'support-dispatch.sh'), 'utf8')
const PATH_LINE = 'PATH=/usr/bin:/bin:/usr/sbin:/sbin\n'
const GRANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const KEY = TEST_ONLY_KEYS[0]
const FP = fingerprintOfBlob(KEY.pub)
const OTHER_FP = fingerprintOfBlob(TEST_ONLY_KEYS[1].pub)
const TOKEN = 'mst_' + 'A'.repeat(43)
// A Slack-token SHAPE for the redactor case, put together at run time so the repo's secret gate does not read a literal.
const SLACK_SHAPE = ['xo', 'xb-1234-5678-abcdef'].join('')
const UNTIL = '"2026-11-15T14:00:00Z"'

const allowBody = (active = [FP], retired: string[] = [], over: Partial<Record<string, string>> = {}): string =>
  '{"armed":' + (over.armed ?? 'true') + ',"armed_until":' + (over.until ?? UNTIL) + ',"subscription_active":' +
  (over.sub ?? 'true') + ',"decision":"' + (over.decision ?? 'allow') + '","active_keys":[' +
  active.map((f) => '"' + f + '"').join(',') + '],"retired_keys":[' + retired.map((f) => '"' + f + '"').join(',') + ']}'

const FAKE_CURL = `#!/bin/sh
# records argv, stdin and env; answers from the scenario files next to it
dir=$(dirname "$0")
printf '%s\\n' "$@" >> "$dir/curl.argv"
printf '%s\\n' '---' >> "$dir/curl.argv"
cat >> "$dir/curl.stdin"
env >> "$dir/curl.env"
out=
while [ $# -gt 0 ]; do
  case $1 in --output) out=$2; shift ;; esac
  last=$1; shift
done
case $last in
  http://127.0.0.1*) echo local >> "$dir/local.calls"; printf '200'; exit 0 ;;
esac
[ -f "$dir/fail" ] && exit 28
cat "$dir/body" > "$out"
cat "$dir/code"
`
const FAKE_PS = `#!/bin/sh
dir=$(dirname "$0")
field=$2; pid=$4
sshd=$(cat "$dir/sshd_pid")
case $field in
  comm=) if [ "$pid" = "$sshd" ]; then cat "$dir/sshd_comm"; else echo sh; fi ;;
  ppid=) echo "$sshd" ;;
  etime=) cat "$dir/etime" ;;
esac
`
const FAKE_PGREP = '#!/bin/sh\nexit 1\n'

let home: string
let bin: string
let kit: string
let dispatch: string
let install: string

function writeExe(path: string, text: string): void {
  writeFileSync(path, text)
  chmodSync(path, 0o755)
}

function setup(opts: { line?: string | null; extraLines?: string[] } = {}): void {
  home = mkdtempSync(join(tmpdir(), 'dispatch-'))
  bin = join(home, 'fakebin')
  kit = join(home, '.marveen', 'support', 'kit')
  install = join(home, 'install')
  mkdirSync(bin, { recursive: true })
  mkdirSync(kit, { recursive: true, mode: 0o700 })
  mkdirSync(join(install, 'store'), { recursive: true })
  mkdirSync(join(home, '.ssh'), { mode: 0o700 })
  writeExe(join(bin, 'curl'), FAKE_CURL)
  writeExe(join(bin, 'ps'), FAKE_PS)
  writeExe(join(bin, 'pgrep'), FAKE_PGREP)
  writeFileSync(join(bin, 'sshd_pid'), '424242\n')
  writeFileSync(join(bin, 'sshd_comm'), 'sshd-session\n')
  writeFileSync(join(bin, 'etime'), '05:00\n')
  writeFileSync(join(bin, 'body'), allowBody())
  writeFileSync(join(bin, 'code'), '200')
  const n = SOURCE.split(PATH_LINE).length - 1
  expect(n).toBe(1)
  dispatch = join(kit, 'support-dispatch.sh')
  writeFileSync(dispatch, SOURCE.replace(PATH_LINE, 'PATH=' + bin + ':/usr/bin:/bin:/usr/sbin:/sbin\n'))
  writeFileSync(
    join(kit, 'manifest'),
    formatKitManifest({ files: { 'support-dispatch.sh': 'a'.repeat(64) }, installRoot: install, nodePath: '/bin/echo', nodeMin: 20, release: 'abcdef1' }),
  )
  writeFileSync(join(home, '.marveen', 'support', 'support-access.token'), TOKEN + '\n', { mode: 0o600 })
  const line = opts.line === undefined
    ? buildSupportLine({ key: KEY, grantId: GRANT, consentVersion: 1, dispatchPath: dispatch, fromCidrs: TEST_ONLY_FROM, sshd: { major: 9, minor: 6 } })
    : opts.line
  const lines = [...(opts.extraLines ?? []), ...(line === null ? [] : [line])]
  writeFileSync(join(home, '.ssh', 'authorized_keys'), lines.join('\n') + '\n', { mode: 0o600 })
}

function args(over: Partial<Record<string, string>> = {}): string[] {
  return [dispatch, '--key', over.key ?? KEY.name, '--fp', over.fp ?? FP, '--grant', over.grant ?? GRANT, '--consent', over.consent ?? '1']
}

function run(command: string, argv: string[] = args(), env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('/bin/sh', argv, {
    encoding: 'utf8',
    env: { SSH_ORIGINAL_COMMAND: command, SSH_CONNECTION: '203.0.113.7 51000 198.51.100.2 22', ...env },
    timeout: 20_000,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

const reason = (stderr: string) => /\(([a-z_]+)\)/.exec(stderr)?.[1] ?? ''
const subcommandRan = () => existsSync(join(bin, 'local.calls'))

beforeEach(() => setup())
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('a complete yes runs the subcommand', () => {
  it('status runs, and only through the gate', () => {
    const r = run('status')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('dashboard_http=200')
    expect(subcommandRan()).toBe(true)
  })
  it('versions reads the release from the manifest', () => {
    const r = run('versions')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('release=abcdef1')
  })
})

describe('the token reaches curl only on standard input; curl gets a clean environment', () => {
  it('no token in any argument, the header on stdin, -q first, https only, no redirect', () => {
    run('status', args(), { HTTPS_PROXY: 'http://evil.invalid:1', CURL_HOME: '/evil', SSL_CERT_FILE: '/evil' })
    const argv = readFileSync(join(bin, 'curl.argv'), 'utf8')
    const first = argv.split('---\n')[0].split('\n')
    expect(argv).not.toContain(TOKEN)
    expect(first[0]).toBe('-q')
    expect(first).toEqual(expect.arrayContaining(['--proto', '=https', '--max-redirs', '0', '--max-time', '5']))
    expect(readFileSync(join(bin, 'curl.stdin'), 'utf8')).toContain('Authorization: Bearer ' + TOKEN)
    const env = readFileSync(join(bin, 'curl.env'), 'utf8')
    expect(env).not.toMatch(/HTTPS_PROXY|CURL_HOME|SSL_CERT_FILE|SSH_ORIGINAL_COMMAND/)
  })
})

describe('Y1-Y6: anything but a complete yes for THIS key refuses, and no subcommand starts', () => {
  const cases: Array<[string, () => void, string]> = [
    ['armed false', () => writeFileSync(join(bin, 'body'), allowBody([FP], [], { armed: 'false' })), 'inconsistent'],
    ['armed_until null', () => writeFileSync(join(bin, 'body'), allowBody([FP], [], { until: 'null' })), 'inconsistent'],
    ['subscription inactive', () => writeFileSync(join(bin, 'body'), allowBody([FP], [], { sub: 'false' })), 'inconsistent'],
    ['decision deny', () => writeFileSync(join(bin, 'body'), allowBody([FP], [], { decision: 'deny' })), 'not_allowed'],
    ['another key only', () => writeFileSync(join(bin, 'body'), allowBody([OTHER_FP])), 'inconsistent'],
    ['own key retired too', () => writeFileSync(join(bin, 'body'), allowBody([FP], [FP])), 'inconsistent'],
    ['a prefix of the own key', () => writeFileSync(join(bin, 'body'), allowBody([FP.slice(0, -1) + 'A'])), 'inconsistent'],
    ['"true" as a string', () => writeFileSync(join(bin, 'body'), allowBody([FP], [], { armed: '"true"' })), 'access_check_failed'],
    ['another key order', () => writeFileSync(join(bin, 'body'), allowBody().replace('{"armed":true,', '{').replace('}', ',"armed":true}')), 'access_check_failed'],
    ['an extra key', () => writeFileSync(join(bin, 'body'), allowBody().replace(/}$/, ',"x":1}')), 'access_check_failed'],
    ['a trailing line end', () => writeFileSync(join(bin, 'body'), allowBody() + '\n'), 'access_check_failed'],
    ['a body over 2048 bytes', () => writeFileSync(join(bin, 'body'), allowBody([FP]) + ' '.repeat(2100)), 'access_check_failed'],
    ['HTTP 401', () => writeFileSync(join(bin, 'code'), '401'), 'access_check_failed'],
    ['HTTP 401 token_revoked (only refuses here)', () => { writeFileSync(join(bin, 'code'), '401'); writeFileSync(join(bin, 'body'), '{"error":"token_revoked"}') }, 'access_check_failed'],
    ['HTTP 500', () => writeFileSync(join(bin, 'code'), '500'), 'access_check_failed'],
    ['network error', () => { writeFileSync(join(bin, 'fail'), ''); writeFileSync(join(bin, 'code'), '000') }, 'access_check_failed'],
    ['no token', () => rmSync(join(home, '.marveen', 'support', 'support-access.token')), 'no_token'],
    ['a token of another shape', () => writeFileSync(join(home, '.marveen', 'support', 'support-access.token'), 'mst_short\n'), 'no_token'],
    ['the connection is 60 min 1 s old', () => writeFileSync(join(bin, 'etime'), '01:00:01\n'), 'connection_too_old'],
    ['no sshd ancestor', () => writeFileSync(join(bin, 'sshd_comm'), 'bash\n'), 'connection_unknown'],
    ['an etime of another shape', () => writeFileSync(join(bin, 'etime'), 'x\n'), 'connection_unknown'],
  ]
  it.each(cases)('%s', (_name, change, expected) => {
    change()
    const r = run('status')
    expect(r.status).toBe(1)
    expect(reason(r.stderr)).toBe(expected)
    expect(r.stdout).toBe('')
    expect(subcommandRan()).toBe(false)
  })
  it('59 min 59 s is still in time', () => {
    writeFileSync(join(bin, 'etime'), '59:59\n')
    expect(run('status').status).toBe(0)
  })
})

describe('the own line: exactly one line binding THIS command', () => {
  const lineFor = (over: Partial<{ consent: number; grant: string }> = {}) =>
    buildSupportLine({ key: KEY, grantId: over.grant ?? GRANT, consentVersion: over.consent ?? 1, dispatchPath: dispatch, fromCidrs: TEST_ONLY_FROM, sshd: { major: 9, minor: 6 } })
  const variants: Array<[string, (l: string) => string | null, string[]?]> = [
    ['missing', () => null],
    ['twice', (l) => l, ['__SAME__']],
    ['an option added (no-touch-required)', (l) => l.replace(',verify-required', ',no-touch-required,verify-required')],
    ['an option added (pty)', (l) => l.replace('restrict,', 'restrict,pty,')],
    ['verify-required dropped', (l) => l.replace(',verify-required', '')],
    ['another comment', (l) => l.replace('marveen-support:', 'marveen-supporx:')],
    ['another key type', (l) => l.replace('sk-ssh-ed25519@openssh.com', 'ssh-ed25519')],
    // Options, key type and blob cut out, leaving a "from" text that would pass both character checks on its own.
    ['the option tail and the key cut out', (l) => l.replace(/from="[^"]*",verify-required sk-ssh-ed25519@openssh\.com [A-Za-z0-9+/=]+/, 'from="abcd')],
  ]
  it.each(variants)('%s: refused', (_name, change, extra) => {
    const good = lineFor()
    const changed = change(good)
    rmSync(home, { recursive: true, force: true })
    setup({ line: changed, extraLines: extra?.map((e) => (e === '__SAME__' ? good : e)) })
    // setup() rebuilt the paths; rebuild the line for the new dispatch path
    const rebuilt = lineFor()
    const final = change(rebuilt)
    writeFileSync(join(home, '.ssh', 'authorized_keys'), [...(extra ? [rebuilt] : []), ...(final === null ? [] : [final])].join('\n') + '\n')
    const r = run('status')
    expect(r.status).toBe(1)
    expect(reason(r.stderr)).toBe('own_line_missing')
    expect(subcommandRan()).toBe(false)
  })
  it('another consent or grant in the arguments than in the line: refused', () => {
    expect(reason(run('status', args({ consent: '2' })).stderr)).toBe('own_line_missing')
    expect(reason(run('status', args({ grant: '9b2e7c1a-5d44-4e0b-8f3a-6c1d2e3f4a5b' })).stderr)).toBe('own_line_missing')
  })
})

describe('arguments and command: exact shapes, a closed list, no free argument', () => {
  it.each([
    [['--key', KEY.name]],
    [['--key', 'Bad!', '--fp', FP, '--grant', GRANT, '--consent', '1']],
    [['--key', KEY.name, '--fp', 'SHA256:short', '--grant', GRANT, '--consent', '1']],
    [['--key', KEY.name, '--fp', FP, '--grant', 'not-a-uuid', '--consent', '1']],
    [['--key', KEY.name, '--fp', FP, '--grant', GRANT, '--consent', '0']],
    [['--fp', FP, '--key', KEY.name, '--grant', GRANT, '--consent', '1']],
  ])('arguments %j: refused', (a) => {
    const r = run('status', [dispatch, ...a])
    expect(r.status).toBe(1)
    expect(reason(r.stderr)).toBe('bad_arguments')
  })
  it.each(['', 'status x', 'status; id', 'logs dashboard 201', 'logs dashboard 0', 'logs dashboard 5 x', 'logs other 5', 'restart now', 'update', 'sh'])(
    'command %j: refused after the gate, nothing runs',
    (command) => {
      const r = run(command)
      expect(r.status).toBe(1)
      expect(reason(r.stderr)).toBe('unknown_command')
      expect(subcommandRan()).toBe(false)
    },
  )
})

describe('logs go through the redactor', () => {
  it('secrets, personal data and terminal control bytes do not come out', () => {
    writeFileSync(
      join(install, 'store', 'dashboard.log'),
      [
        'token mst_' + 'B'.repeat(43) + ' and mrv_' + 'C'.repeat(20),
        'anthropic sk-ant-api03-' + 'D'.repeat(40),
        'slack ' + SLACK_SHAPE,
        'Authorization: Bearer abc.def.ghi',
        'mail owner@example.com phone +36 30 123 4567',
        'hex ' + 'a1'.repeat(20),
        'esc \u001b]0;title\u0007 and \u001b[31mred',
        'link \u001b]8;;http://x\u001b\\here\u001b]8;;\u001b\\ bold \u001b[1;33;40mx\u001b[0m\u001b[K end',
        // Lone control bytes outside any sequence: a backspace, a bare ESC, a BEL, a carriage return.
        'lone a\u0008b c\u001b d\u0007e f\rg',
        'plain 2026-11-15 07:12:33 ok',
      ].join('\n') + '\n',
    )
    const r = run('logs dashboard 20')
    expect(r.status).toBe(0)
    for (const leak of ['mst_BBB', 'mrv_CCC', 'sk-ant-', SLACK_SHAPE.slice(0, 9), 'abc.def.ghi', 'owner@example.com', '123 4567', 'a1a1a1a1a1a1', '\u001b', '\u0007', '\u0008', '\r', '[31m', '[0m', '[K', ']0;', ']8;;', 'title']) {
      expect(r.stdout).not.toContain(leak)
    }
    expect(r.stdout).toContain('lone ab c d')
    // Whole sequences go, the text around them stays.
    expect(r.stdout).toContain('esc  and red')
    expect(r.stdout).toContain('link here bold x end')
    expect(r.stdout).toContain('plain 2026-11-15 07:12:33 ok')
  })
})

describe('the self-probe never opens anything', () => {
  it('reaches marveen.io and prints one line; a command in the environment does not run', () => {
    writeFileSync(join(bin, 'body'), allowBody([FP], [], { decision: 'deny', armed: 'false' }))
    const r = run('status', [dispatch, '--probe-fp', FP])
    expect(r.stdout).toBe('probe=reached\n')
    expect(r.status).toBe(0)
    expect(subcommandRan()).toBe(false)
    const argv = readFileSync(join(bin, 'curl.argv'), 'utf8')
    expect(argv).toContain('{"key_fingerprint":"' + FP + '","probe":true}')
  })
})

describe('restart is limited', () => {
  it('a restart already done on this connection: refused before anything runs', () => {
    const spool = join(home, '.marveen', 'support', 'support-access.spool')
    mkdirSync(spool, { recursive: true })
    writeFileSync(join(spool, '1.1.0.evt'), 'time=' + Math.floor(Date.now() / 1000) + '\nevent=restart\nreason=conn-424242\n')
    const r = run('restart')
    expect(r.status).toBe(1)
    expect(reason(r.stderr)).toBe('restart_limit')
  })
  it('three restarts in the last day from other connections: refused', () => {
    const spool = join(home, '.marveen', 'support', 'support-access.spool')
    mkdirSync(spool, { recursive: true })
    const now = Math.floor(Date.now() / 1000)
    for (let i = 0; i < 3; i++) writeFileSync(join(spool, now + '.' + i + '.0.evt'), 'time=' + (now - 600 * i) + '\nevent=restart\nreason=conn-' + (1000 + i) + '\n')
    expect(reason(run('restart').stderr)).toBe('restart_limit')
  })
  it('restarts older than a day do not count; a spool time with a leading zero is ignored', () => {
    const spool = join(home, '.marveen', 'support', 'support-access.spool')
    mkdirSync(spool, { recursive: true })
    const now = Math.floor(Date.now() / 1000)
    for (let i = 0; i < 3; i++) writeFileSync(join(spool, 'old.' + i + '.evt'), 'time=' + (now - 90000 - i) + '\nevent=restart\nreason=conn-' + (2000 + i) + '\n')
    writeFileSync(join(spool, 'odd.evt'), 'time=0899\nevent=restart\nreason=conn-3000\n')
    const r = run('restart')
    // past the limit check: the fake install has no stop.sh, so the restart itself fails, but it was not refused
    expect(reason(r.stderr)).not.toBe('restart_limit')
    expect(r.stdout).toBe('restart=failed\n')
  })
})

describe('events in the spool carry only enumerated values', () => {
  it('a refusal leaves one event with its reason and no client text', () => {
    run('status; cat /etc/passwd')
    const spool = join(home, '.marveen', 'support', 'support-access.spool')
    const files = readdirSync(spool)
    expect(files.length).toBeGreaterThan(0)
    const text = files.map((f) => readFileSync(join(spool, f), 'utf8')).join('')
    expect(text).toContain('reason=unknown_command')
    expect(text).not.toContain('passwd')
    expect(text).not.toContain(TOKEN)
  })
})

describe('a truncated dispatcher with a denying gate starts no subcommand (cut at every line boundary)', () => {
  it('no prefix of the file runs a subcommand', () => {
    writeFileSync(join(bin, 'body'), allowBody([FP], [], { decision: 'deny' }))
    const full = readFileSync(dispatch, 'utf8')
    const lines = full.split('\n')
    for (let i = 1; i < lines.length; i++) {
      writeFileSync(dispatch, lines.slice(0, i).join('\n') + '\n')
      run('status')
      expect(subcommandRan(), 'cut after line ' + i).toBe(false)
    }
    // One run per line: since #2800 the file has about 900 lines. Alone this takes about 36 s (measured on macOS); in
    // the full suite, next to the other workers, it went past 120 s once, so the limit leaves room for a loaded machine.
  }, 300_000)
})
