// GROMZOUNITGUARD1109 (Samu 74409, 74412; Dani's #2646 remainder): update.sh moves an install to gromzo ONLY when its
// Linux channels unit really restarts after a clean exit. On gromzo, channels.sh's "gromzo ready" exit ends 0; a unit
// whose effective Restart= is not "always" would leave the main session down. The REAL update.sh functions run here
// under set -e, with uname, systemctl and node as stubs:
//   - systemctl --user show answers first (drop-ins and reloads folded in); the unit file and its drop-ins only when it
//     cannot; when neither can tell, it is fail-closed;
//   - a blocked install is told so in one line ONLY when the migration's dry run says "would-migrate";
//   - no Linux channels unit (macOS, Docker) or every unit on always: the migration runs as before.
import { describe, it, expect } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const UPDATE = readFileSync(join(__dirname, '..', '..', 'update.sh'), 'utf8')
const A = UPDATE.indexOf('gromzo_channels_unit_restart() {')
const B = UPDATE.indexOf('\n}\n', UPDATE.indexOf('migrate_gromzo_provider() {')) + 3
const FNS = UPDATE.slice(A, B)

interface Case {
  uname?: string
  units?: Record<string, string> // file name under ~/.config/systemd/user -> content
  dropins?: Record<string, string> // "<unit>.d/<name>.conf" -> content
  unreadable?: string // a unit file made unreadable
  systemctl?: string // what `systemctl --user show -p Restart --value` prints; 'FAIL' = no answer
  dryRun?: string // what the migration's --dry-run prints
}

function run(c: Case) {
  const root = mkdtempSync(join(tmpdir(), 'gz-unitguard-'))
  const home = join(root, 'home')
  const units = join(home, '.config', 'systemd', 'user')
  const inst = join(root, 'inst')
  const bin = join(root, 'bin')
  for (const d of [units, join(inst, 'scripts'), bin]) mkdirSync(d, { recursive: true })
  writeFileSync(join(inst, 'scripts', 'gromzo-provider-migrate.mjs'), '')
  for (const [n, body] of Object.entries(c.units ?? {})) writeFileSync(join(units, n), body)
  for (const [n, body] of Object.entries(c.dropins ?? {})) {
    mkdirSync(join(units, n.split('/')[0]), { recursive: true })
    writeFileSync(join(units, n), body)
  }
  if (c.unreadable) chmodSync(join(units, c.unreadable), 0o000)
  const log = join(root, 'calls')
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  stub('uname', `echo '${c.uname ?? 'Linux'}'`)
  stub('systemctl', `echo "systemctl $*" >> '${log}'\n${c.systemctl === undefined || c.systemctl === 'FAIL' ? 'exit 1' : `echo '${c.systemctl}'`}`)
  stub('node', `echo "node $*" >> '${log}'\ncase " $* " in *" --dry-run "*) echo '${c.dryRun ?? 'gromzo-provider-migrate: would-migrate'}' ;; *) echo 'gromzo-provider-migrate: migrated' ;; esac`)
  const r = spawnSync('bash', ['-c', ['set -e', `INSTALL_DIR='${inst}'`, FNS, 'migrate_gromzo_provider', 'echo "AFTER rc=$?"'].join('\n')], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
  })
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
  const migrated = calls.split('\n').some((l) => l.startsWith('node ') && !l.includes('--dry-run'))
  return { out: r.stdout, err: r.stderr, status: r.status, calls, migrated }
}

const ALWAYS = '[Service]\nExecStart=/x/channels.sh\nRestart=always\nRestartSec=10\n'
const ONFAIL = '[Service]\nExecStart=/x/channels.sh\nRestart=on-failure\nRestartSec=10\n'

describe('the slice is the real pair of functions', () => {
  it('starts at the check, ends at migrate_gromzo_provider, and the update still calls it bare, last', () => {
    expect(A).toBeGreaterThan(0)
    expect(FNS.startsWith('gromzo_channels_unit_restart() {')).toBe(true)
    expect(FNS).toContain('migrate_gromzo_provider() {')
    expect(FNS.trimEnd().endsWith('}')).toBe(true)
    expect(UPDATE).toMatch(/migrate_channels_restart "\$@"[\s\S]*?scrub_rc_secrets\n {2}migrate_gromzo_provider\n {2}return 0\n\}/)
  })
})

describe('the migration runs as before', () => {
  it('a channels unit on always (systemd says so): migrated, no extra line', () => {
    const r = run({ units: { 'marveen-channels.service': ALWAYS }, systemctl: 'always' })
    expect(r.migrated).toBe(true)
    expect(r.out).toBe('gromzo-provider-migrate: migrated\nAFTER rc=0\n')
  })
  it('systemd cannot answer, the file says always: migrated', () => {
    const r = run({ units: { 'marveen-channels.service': ALWAYS }, systemctl: 'FAIL' })
    expect(r.migrated).toBe(true)
  })
  it("the installer's own onfailure.conf drop-in (OnFailure= only, no Restart=), systemd cannot answer: migrated", () => {
    // the shape install-linux.sh writes and the QA VPS carries (V34, Marveen 74428): it must not read as a Restart policy
    const r = run({
      units: { 'marveen-channels.service': ALWAYS },
      dropins: { 'marveen-channels.service.d/onfailure.conf': '[Unit]\nOnFailure=marveen-notify@%n.service\n' },
      systemctl: 'FAIL',
    })
    expect(r.migrated).toBe(true)
    expect(r.out).toBe('gromzo-provider-migrate: migrated\nAFTER rc=0\n')
  })
  it('no Linux channels unit (macOS KeepAlive, Docker supervisor): migrated, systemctl not even asked', () => {
    expect(run({ uname: 'Darwin', units: { 'marveen-channels.service': ONFAIL } }).migrated).toBe(true)
    const none = run({ units: {} })
    expect(none.migrated).toBe(true)
    expect(none.calls).not.toContain('systemctl')
  })
})

describe('a unit that would not restart after the clean "gromzo ready" exit: NOT migrated', () => {
  const blocked: Array<[string, Case, string]> = [
    ['the file on on-failure (its rewrite failed), systemd cannot answer', { units: { 'marveen-channels.service': ONFAIL }, systemctl: 'FAIL' }, 'Restart=on-failure'],
    ['systemd says on-failure while the file says always (a drop-in or no reload)', { units: { 'marveen-channels.service': ALWAYS }, systemctl: 'on-failure' }, 'Restart=on-failure'],
    ['a drop-in overrides always, systemd cannot answer', { units: { 'marveen-channels.service': ALWAYS }, dropins: { 'marveen-channels.service.d/override.conf': '[Service]\nRestart=on-failure\n' }, systemctl: 'FAIL' }, 'Restart=on-failure'],
    ['no Restart= line at all (systemd default "no"), systemd cannot answer', { units: { 'marveen-channels.service': '[Service]\nExecStart=/x\n' }, systemctl: 'FAIL' }, 'Restart=no-default'],
    ['fail-closed: the unit file unreadable and systemd cannot answer', { units: { 'marveen-channels.service': ALWAYS }, unreadable: 'marveen-channels.service', systemctl: 'FAIL' }, 'Restart=unreadable'],
    ['one of two channels units not on always', { units: { 'a-channels.service': ALWAYS, 'b-channels.service': ONFAIL }, systemctl: 'FAIL' }, 'b-channels.service Restart=on-failure'],
  ]
  for (const [name, c, why] of blocked) {
    it(`${name}: not migrated, one line names the unit and why`, () => {
      if (c.unreadable && process.getuid?.() === 0) return // root reads a 000 file; the fail-closed branch is then unreachable
      const r = run(c)
      expect(r.migrated).toBe(false)
      expect(r.out).toContain(`Gromzo-migracio kihagyva: a csatorna-unit ujrainditasi szabalya nem always (`)
      expect(r.out).toContain(why)
      expect(r.out.endsWith('AFTER rc=0\n')).toBe(true)
      expect(r.out.split('\n').filter((l) => l.includes('Gromzo-migracio')).length).toBe(1)
    })
  }
  it('an install the migration would not touch anyway (dry run: skip): no line, no migration', () => {
    const r = run({ units: { 'marveen-channels.service': ONFAIL }, systemctl: 'FAIL', dryRun: 'gromzo-provider-migrate: skip has-token' })
    expect(r.migrated).toBe(false)
    expect(r.out).toBe('AFTER rc=0\n')
    expect(r.calls).toContain('--dry-run')
  })
})
