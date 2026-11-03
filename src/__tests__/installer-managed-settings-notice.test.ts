/**
 * #1874: the installers write the machine-wide managed-settings.json with root
 * rights (the channel allowlist on macOS, channelsEnabled on both platforms). The
 * write stays mandatory; what changes is that the operator is told, BEFORE the
 * first root step asks for a password, what is written and why.
 *
 * Nothing here runs an installer. The texts come from install-lang.sh; the helper
 * is cut out of each installer and run on its own; the order is read from the
 * script text.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8')
const MACOS = read('install-macos.sh')
const LINUX = read('install-linux.sh')

function t(lang: string, key: string): string {
  const r = spawnSync('bash', ['-c', `source "${join(ROOT, 'install-lang.sh')}"; _t ${key}`], {
    encoding: 'utf8',
    env: { ...process.env, MARVEEN_LANG: lang },
  })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout.trim()
}

function helperOf(script: string): string {
  const start = script.indexOf('managed_settings_notice() {')
  expect(start).toBeGreaterThan(-1)
  const end = script.indexOf('\n}\n', start)
  return script.slice(start, end + 3)
}

function runHelperTwice(script: string, lang: string): string {
  const body = `source "${join(ROOT, 'install-lang.sh')}"\nORANGE=''; NC=''\nset -e\n${helperOf(script)}\nmanaged_settings_notice\nmanaged_settings_notice\necho END`
  const r = spawnSync('bash', ['-c', body], { encoding: 'utf8', env: { ...process.env, MARVEEN_LANG: lang } })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout
}

const lineOf = (script: string, needle: string, from = 0): number => {
  const lines = script.split('\n')
  for (let i = from; i < lines.length; i++) if (lines[i].includes(needle)) return i
  return -1
}

describe('the notice says what is written, why, and that a password may be asked (hu and en)', () => {
  it('hu', () => {
    const what = t('hu', 'managed.notice_what')
    const sudo = t('hu', 'managed.notice_sudo')
    expect(what).toContain('managed-settings.json')
    expect(what).toMatch(/céges \(Team\/Enterprise\) Claude-fióknál elakadnak a bejövő üzenetek/)
    expect(sudo).toMatch(/jelszavát/)
    expect(sudo).toContain('sudo')
  })
  it('en', () => {
    const what = t('en', 'managed.notice_what')
    const sudo = t('en', 'managed.notice_sudo')
    expect(what).toContain('managed-settings.json')
    expect(what).toMatch(/incoming messages stall on a company \(Team\/Enterprise\) Claude account/)
    expect(sudo).toMatch(/password/)
    expect(sudo).toContain('sudo')
  })
  it('no dashes in the texts', () => {
    for (const lang of ['hu', 'en']) for (const k of ['managed.notice_what', 'managed.notice_sudo']) {
      expect(t(lang, k)).not.toMatch(/[\u2013\u2014]/)
    }
  })
})

describe('the helper prints the notice once, under set -e, in both installers', () => {
  for (const [name, script] of [['install-macos.sh', MACOS], ['install-linux.sh', LINUX]] as const) {
    it(name, () => {
      const out = runHelperTwice(script, 'hu')
      expect(out.split('\n').filter((l) => l.includes('managed-settings.json')).length).toBe(1)
      expect(out.split('\n').filter((l) => l.includes('jelszavát')).length).toBe(1)
      expect(out.trimEnd().endsWith('END')).toBe(true)
    })
  }
})

describe('the notice comes BEFORE each root step on managed-settings.json', () => {
  // The first root step of each block, in file order. Each gets its own call in
  // front of it: which block runs first depends on the chosen channel.
  const MACOS_STEPS = [
    'HAS_DISCORD=$(sudo python3 -c "',
    'HAS_ALL=$(sudo python3 -c "',
    'CHANNELS_GATE_OUT="$(bash "$INSTALL_DIR/scripts/ensure-managed-channels-enabled.sh"',
  ]

  it('install-macos.sh: a call between the previous step and each block\'s first root step', () => {
    let prev = -1
    for (const step of MACOS_STEPS) {
      const at = lineOf(MACOS, step)
      expect(at, step).toBeGreaterThan(prev)
      const call = lineOf(MACOS, '  managed_settings_notice', prev + 1)
      expect(call, `no notice before: ${step}`).toBeGreaterThan(prev)
      expect(call, `notice after: ${step}`).toBeLessThan(at)
      prev = at
    }
  })

  it('install-macos.sh: no root step on managed-settings.json comes before the first call', () => {
    const lines = MACOS.split('\n')
    const firstCall = lineOf(MACOS, '  managed_settings_notice')
    const rootSteps = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /\bsudo\b/.test(l) && /MANAGED|\$\(sudo python3/.test(l))
    expect(rootSteps.length).toBe(6)
    for (const { i } of rootSteps) expect(i).toBeGreaterThan(firstCall)
  })

  it('install-linux.sh: the call precedes the channel gate', () => {
    const call = lineOf(LINUX, '  managed_settings_notice')
    const gate = lineOf(LINUX, 'bash "$INSTALL_DIR/scripts/ensure-managed-channels-enabled.sh" || true')
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(gate)
    expect(gate - call).toBeLessThanOrEqual(3)
  })

  it('the write itself is unchanged: the gate still runs unconditionally, with no opt-out switch', () => {
    for (const script of [MACOS, LINUX]) {
      expect(script).not.toMatch(/SKIP_MANAGED|MANAGED_OPT_OUT|NO_MANAGED/)
      expect(script).toContain('scripts/ensure-managed-channels-enabled.sh')
    }
  })
})
