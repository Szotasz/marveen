// #1871 (external report): when the launchd units did not come up, install-macos.sh
// printed the "services not verified" block mid-run, then the unconditional
// "successfully installed" banner, and exited 0 -- automation, and a user who reads
// only the end, saw a healthy install. The fix keeps the outcome in SERVICES_STATE,
// prints the success banner only when both units were seen running, repeats the
// state and the remedy last, and exits 3 -- except in the machine progress mode
// (MARVEEN_JSON_PROGRESS=1), where the Bridge installer's derived script appends
// its final emit_result AFTER the last line and an exit would break it.
//
// The cases run the REAL script text: the start block with a stubbed launchd
// helper, and the closing section from "# Done!" to the end with the real
// install-lang.sh strings.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')

function slice(from: string, to: string | null): string {
  const start = MACOS.indexOf(from)
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1)
  const end = to === null ? MACOS.length : MACOS.indexOf(to, start)
  expect(end, `end anchor not found: ${to}`).toBeGreaterThan(start)
  return MACOS.slice(start, end)
}

const START_BLOCK = slice('print_services_remedy() {', '# Idle-path keepalive probe')
const REMEDY_FN = slice('print_services_remedy() {', '\n}\n') + '\n}\n'
const TAIL = slice('# Done!', null)

const PRELUDE = [
  'set -eE',
  "trap 'echo ERRTRAP; exit 99' ERR",
  'RED=; GREEN=; ORANGE=; BLUE=; BOLD=; DIM=; NC=',
  'warn() { echo "WARN $*"; }',
  'DASHBOARD_PLIST=com.test.dashboard',
  'CHANNELS_PLIST=com.test.channels',
].join('\n')

function run(script: string, env: Record<string, string> = {}): { out: string; code: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'svcstate-'))
  try {
    const f = join(dir, 'run.sh')
    writeFileSync(f, script)
    const r = spawnSync('bash', [f], {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, MARVEEN_LANG: 'en', INSTALL_DIR: dir, ...env },
    })
    return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the start block records the outcome (real block, stubbed launchd helper)', () => {
  const startWith = (dash: string, ch: string) =>
    run(
      [
        PRELUDE,
        `start_launchd_unit() { case "$1" in com.test.dashboard) echo "${dash}" ;; com.test.channels) echo "${ch}" ;; esac; }`,
        START_BLOCK,
        'echo "STATE=$SERVICES_STATE"',
      ].join('\n'),
    )

  it('both units running: ok', () => {
    const r = startWith('101', '202')
    expect(r.code).toBe(0)
    expect(r.out).toContain('STATE=ok')
    expect(r.out).not.toContain('ERRTRAP')
  })
  for (const [label, dash, ch] of [
    ['dashboard missing', '', '202'],
    ['channels missing', '101', ''],
    ['both missing', '', ''],
  ] as const) {
    it(`${label}: down, the mid-run block and its remedy still print, and the ERR trap does not fire`, () => {
      const r = startWith(dash, ch)
      expect(r.code).toBe(0)
      expect(r.out).toContain('STATE=down')
      expect(r.out).toContain('WARN A SZOLGALTATASOK INDULASA NEM IGAZOLT')
      expect(r.out).toContain('launchctl bootstrap gui/')
      expect(r.out).not.toContain('ERRTRAP')
    })
  }
})

describe('the closing section (real text from "# Done!" to the end, real strings)', () => {
  const tail = (state: string, env: Record<string, string> = {}, extra = '') =>
    run(
      [
        PRELUDE,
        `. "${join(ROOT, 'install-lang.sh')}"`,
        REMEDY_FN,
        `SERVICES_STATE=${state}`,
        'CHANNELS_GATE_STATE=ok',
        'INSTALL_AUTH_STATE=OK',
        extra,
        TAIL,
      ].join('\n'),
      env,
    )

  it('ok: the success banner, no services block, exit 0', () => {
    const r = tail('ok', {}, 'DASHBOARD_PID=1; CHANNELS_PID=2')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Marveen successfully installed!')
    expect(r.out).not.toContain('NOT running')
    expect(r.out).not.toContain('A SZOLGÁLTATÁSOK NEM FUTNAK')
  })

  it('down: no success banner; the state and the remedy are repeated last; exit 3', () => {
    const r = tail('down', {}, 'DASHBOARD_PID=; CHANNELS_PID=2')
    expect(r.code).toBe(3)
    expect(r.out).not.toContain('Marveen successfully installed!')
    expect(r.out).toContain('Marveen is installed, but its services are NOT running yet')
    const last = r.out.slice(r.out.lastIndexOf('A SZOLGÁLTATÁSOK NEM FUTNAK'))
    expect(last).toContain('com.test.dashboard: nem fut')
    expect(last).not.toContain('com.test.channels: nem fut')
    expect(last).toContain('launchctl bootstrap gui/')
    expect(last).toContain('launchctl kickstart -p gui/')
    expect(r.out).not.toContain('ERRTRAP')
  })

  it('down in the machine progress mode (Bridge): the block still prints, but exit 0 so its appended emit_result runs', () => {
    const r = tail('down', { MARVEEN_JSON_PROGRESS: '1' }, 'DASHBOARD_PID=; CHANNELS_PID=')
    expect(r.code).toBe(0)
    expect(r.out).toContain('A SZOLGÁLTATÁSOK NEM FUTNAK')
    expect(r.out).not.toContain('Marveen successfully installed!')
  })

  it('down with a broken auth too: both verdicts are repeated, exit 3', () => {
    const r = tail('down', {}, 'DASHBOARD_PID=; CHANNELS_PID=; INSTALL_AUTH_STATE=BROKEN')
    expect(r.code).toBe(3)
    expect(r.out).toContain('AZ UGYNOKOK MEG NEM FOGNAK VALASZOLNI')
    expect(r.out).toContain('A SZOLGÁLTATÁSOK NEM FUTNAK')
  })

  it('an unknown state (the block never ran) is not reported as a failure', () => {
    const r = tail('unknown')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Marveen successfully installed!')
  })
})

describe('the binding', () => {
  it('the state is set on both branches of the start block, before any banner', () => {
    expect(START_BLOCK).toMatch(/then\n\s+SERVICES_STATE="ok"/)
    expect(START_BLOCK).toMatch(/else\n\s+SERVICES_STATE="down"/)
  })
  it('the Bridge derive anchor survives: "# Done!" is a lone line with a blank line above it', () => {
    expect(MACOS.split('\n# Done!\n').length).toBe(2)
    expect(MACOS).toContain('\n\n# Done!\n')
  })
  it('both languages carry the services-down banner', () => {
    const lang = readFileSync(join(ROOT, 'install-lang.sh'), 'utf-8')
    expect(lang).toContain('en:success_installed_services_down)')
    expect(lang).toContain('hu:success_installed_services_down)')
  })
})
