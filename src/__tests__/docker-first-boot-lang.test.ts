// DOCKERUX1118 (Geri 33317): the container's first start sets the dashboard's default language from the install's
// (.lang, written from MARVEEN_LANG), so an en install's wizard does not come up in Hungarian (DASHBOARD_LANG's
// registry default is hu). The REAL docker/first-boot.sh runs in a temp install with no scripts/lib: it stops at the
// seed helpers (rc 1, "the image is broken"), after .env and .lang are written, which is all this test reads.
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const FIRSTBOOT = join(__dirname, '..', '..', 'docker', 'first-boot.sh')

let base: string | null = null
afterEach(() => {
  if (base !== null) rmSync(base, { recursive: true, force: true })
  base = null
})

function firstBoot(opts: { lang?: string; env?: string; dotLang?: string; platform?: string; dotPlatform?: string }) {
  base = mkdtempSync(join(tmpdir(), 'dfb-lang-'))
  const install = join(base, 'opt-marveen')
  const home = join(base, 'home')
  mkdirSync(install, { recursive: true })
  mkdirSync(home, { recursive: true })
  if (opts.env !== undefined) writeFileSync(join(install, '.env'), opts.env, { mode: 0o600 })
  if (opts.dotLang !== undefined) writeFileSync(join(install, '.lang'), opts.dotLang)
  if (opts.dotPlatform !== undefined) { mkdirSync(join(install, 'store'), { recursive: true }); writeFileSync(join(install, 'store', '.platform'), opts.dotPlatform) }
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, MARVEEN_INSTALL_DIR: install }
  if (opts.lang !== undefined) env.MARVEEN_LANG = opts.lang
  if (opts.platform !== undefined) env.MARVEEN_PLATFORM = opts.platform
  const r = spawnSync('bash', [FIRSTBOOT], { env, encoding: 'utf-8' })
  const dotEnv = readFileSync(join(install, '.env'), 'utf-8')
  return {
    out: (r.stdout ?? '') + (r.stderr ?? ''),
    code: r.status,
    dotEnv,
    langLines: dotEnv.split('\n').filter((l) => l.startsWith('DASHBOARD_LANG=')),
    envMode: statSync(join(install, '.env')).mode & 0o777,
    platform: (() => { try { return readFileSync(join(install, 'store', '.platform'), 'utf-8') } catch { return null } })(),
  }
}

describe('docker/first-boot.sh: DASHBOARD_LANG from the install language', () => {
  it('stops where this test expects: after .env and .lang, at the missing seed helpers', () => {
    const r = firstBoot({ lang: 'en' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('scripts/lib/seed-refresh.sh is missing')
  })

  it.each<[string | undefined, string]>([
    ['en', 'en'],
    ['hu', 'hu'],
    [undefined, 'en'],
  ])('a fresh volume with MARVEEN_LANG=%s: DASHBOARD_LANG=%s, once, and .env stays 0600', (lang, want) => {
    const r = firstBoot({ lang })
    expect(r.langLines).toEqual(['DASHBOARD_LANG=' + want])
    expect(r.out).toContain('first-boot: DASHBOARD_LANG=' + want)
    expect(r.envMode).toBe(0o600)
  })

  it('an existing volume without the line gets it from its .lang, not from a changed MARVEEN_LANG', () => {
    const r = firstBoot({ lang: 'hu', env: 'CHANNEL_PROVIDER=telegram\nMAIN_AGENT_ID=marveen\n', dotLang: 'en\n' })
    expect(r.langLines).toEqual(['DASHBOARD_LANG=en'])
  })

  it('a line already in .env is kept as it is (a hand edit is not overwritten)', () => {
    const r = firstBoot({ lang: 'en', env: 'MAIN_AGENT_ID=marveen\nDASHBOARD_LANG=hu\n', dotLang: 'en\n' })
    expect(r.langLines).toEqual(['DASHBOARD_LANG=hu'])
    expect(r.out).not.toContain('first-boot: DASHBOARD_LANG=')
  })

  it.each(['de', '', 'en hu', 'EN'])('a .lang that is not en or hu (%j) writes no line', (dotLang) => {
    const r = firstBoot({ lang: 'en', env: 'MAIN_AGENT_ID=marveen\n', dotLang: dotLang + '\n' })
    expect(r.langLines).toEqual([])
  })
})

// HOSTINGERROUTER1122: the platform marker, written once and only when the compose file sets MARVEEN_PLATFORM.
describe('docker/first-boot.sh: store/.platform', () => {
  it('MARVEEN_PLATFORM=hostinger writes it', () => {
    expect(firstBoot({ platform: 'hostinger' }).platform).toBe('hostinger\n')
  })
  it('no MARVEEN_PLATFORM (the main compose): no marker', () => {
    expect(firstBoot({}).platform).toBeNull()
  })
  it('an existing marker is kept', () => {
    expect(firstBoot({ platform: 'hostinger', dotPlatform: 'other\n' }).platform).toBe('other\n')
  })
})
