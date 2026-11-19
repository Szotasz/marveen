// MANAGEDUMASK1119: install-macos.sh repairs an EXISTING managed-settings dir that an older install left 0700 (a root
// umask of 077): the session cannot read the policy inside, and the installer's own checks, which read as the user,
// see no file there. The real managed_dir_repair() is cut out of install-macos.sh and run against temp dirs with
// stubs: /usr/bin/sudo runs the command and logs it, /usr/bin/stat reports a chosen owner (root ownership cannot be
// made without root) and the real mode, computed portably so the test runs on Linux CI too.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MACOS = readFileSync(join(__dirname, '..', '..', 'install-macos.sh'), 'utf-8')
const FN = (() => {
  const m = MACOS.match(/^managed_dir_repair\(\) \{[\s\S]*?^\}$/m)
  if (!m) throw new Error('managed_dir_repair() not found in install-macos.sh')
  return m[0]
})()

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const mode = (p: string) => statSync(p).mode & 0o777

function run(o: { owner?: string; existing?: number | 'symlink' | 'missing'; sudoFails?: boolean }) {
  const base = mkdtempSync(join(tmpdir(), 'marveen-macos-repair-'))
  dirs.push(base)
  const dir = join(base, 'ClaudeCode')
  let target: string | undefined
  if (o.existing === 'symlink') {
    target = join(base, 'elsewhere')
    mkdirSync(target)
    chmodSync(target, 0o700)
    symlinkSync(target, dir)
  } else if (o.existing !== 'missing') {
    mkdirSync(dir)
    chmodSync(dir, o.existing ?? 0o700)
  }
  const log = join(base, 'log')
  writeFileSync(log, '')
  const body = FN.replaceAll('/usr/bin/stat', 'fake_stat').replaceAll('/usr/bin/sudo ', 'fake_sudo ')
  expect(body).not.toContain('/usr/bin/sudo')
  const script = [
    'set -u',
    'ORANGE= RED= NC= DIM=',
    `LOG=${JSON.stringify(log)}`,
    'managed_settings_notice() { echo NOTICE >> "$LOG"; }',
    `fake_sudo() { echo "SUDO $*" >> "$LOG"; ${o.sudoFails ? 'return 1' : '"$@"'}; }`,
    `fake_stat() { local p="\${@: -1}"; echo "${o.owner ?? '0'} $(python3 -I -c 'import os,sys;print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$p")"; }`,
    body,
    `managed_dir_repair ${JSON.stringify(dir)}`,
    'echo "RC=$?"',
  ].join('\n')
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf-8' })
  return { out, dir, target, log: readFileSync(log, 'utf-8') }
}

describe('install-macos.sh managed_dir_repair (MANAGEDUMASK1119)', () => {
  it('a root-owned 0700 dir becomes 0755, loudly, the notice before the root step', () => {
    const r = run({ existing: 0o700 })
    expect(mode(r.dir)).toBe(0o755)
    expect(r.out).toContain('700 volt')
    expect(r.out).toContain('0755-re allitva')
    expect(r.log.split('\n').filter(Boolean)).toEqual(['NOTICE', `SUDO /bin/chmod 0755 ${r.dir}`])
  })

  it('a 0777 dir is narrowed to 0755, never widened', () => {
    expect(mode(run({ existing: 0o777 }).dir)).toBe(0o755)
  })

  it('a 0755 dir: nothing happens, no notice, no password', () => {
    const r = run({ existing: 0o755 })
    expect(mode(r.dir)).toBe(0o755)
    expect(r.log).toBe('')
    expect(r.out.trim()).toBe('RC=0')
  })

  it('a dir owned by someone else is not touched', () => {
    const r = run({ owner: '501', existing: 0o700 })
    expect(mode(r.dir)).toBe(0o700)
    expect(r.log).toBe('')
  })

  it('a symlink at the path is not followed: its target keeps its mode', () => {
    const r = run({ existing: 'symlink' })
    expect(mode(r.target!)).toBe(0o700)
    expect(r.log).toBe('')
  })

  it('no dir yet: nothing to repair (the block creates it with -m 0755)', () => {
    const r = run({ existing: 'missing' })
    expect(existsSync(r.dir)).toBe(false)
    expect(r.log).toBe('')
  })

  it('a failed chmod says the manual step and does not fail the install', () => {
    const r = run({ existing: 0o700, sudoFails: true })
    expect(mode(r.dir)).toBe(0o700)
    expect(r.out).toContain('sudo chmod 0755')
    expect(r.out).toContain('RC=0')
  })
})

describe('install-macos.sh calls the repair before each managed block reads as the user', () => {
  const lines = MACOS.split('\n')
  const at = (needle: string, from = 0) => lines.findIndex((l, i) => i >= from && l.includes(needle))

  it('three calls, each right before the block\'s user-level check', () => {
    const calls = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\s*managed_dir_repair "/.test(l))
    expect(calls.length).toBe(3)
    // the Discord merge and the Slack block check the file with -f; the channels gate with managed_has
    const checks = [
      at('if [ -f "$MANAGED_FILE" ]; then', calls[0].i),
      at('if [ -f "$MANAGED_FILE" ]; then', calls[1].i),
      at('if managed_has "$MANAGED_FILE" --channels; then', calls[2].i),
    ]
    for (let k = 0; k < 3; k++) {
      expect(checks[k], `check after call ${k}`).toBeGreaterThan(calls[k].i)
      expect(checks[k] - calls[k].i, `call ${k} is right before its check`).toBeLessThanOrEqual(1)
    }
  })

  it('the repair runs as root only through absolute program paths (MACROOTFROMCLONE1106)', () => {
    expect(FN).toContain('/usr/bin/sudo /bin/chmod 0755')
    expect(FN).toContain('/usr/bin/stat -f')
    // a bare `sudo` may appear only in the printed manual step, never as a call
    expect(FN.split('\n').filter((l) => !l.includes('echo')).join('\n')).not.toMatch(/(^|\s)sudo /)
  })
})
