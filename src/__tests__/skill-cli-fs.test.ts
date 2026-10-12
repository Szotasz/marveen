import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialsPermissionError,
  credentialsPath,
  loadCredentials,
  saveCredentials,
  skillTargetDir,
  tarolasiHatter,
  writeSkillFiles,
} from '../skill-cli-fs.js'

/**
 * A JOGOSULTSAG NEM KOMMENT-KERDES, HANEM MERHETO: az itteni allitasok a
 * TENYLEGES mode-biteket olvassak vissza, nem azt, hogy a kod atadta-e a
 * `mode` opciot. A ketto nem ugyanaz -- egy mar letezo, tagabb jogu fajlt a
 * writeFileSync modja nem allit vissza.
 */
let elozoHome: string | undefined
let tmp: string

beforeEach(() => {
  elozoHome = process.env.MARVEEN_SKILL_HOME
  tmp = mkdtempSync(join(tmpdir(), 'skill-cli-fs-'))
  process.env.MARVEEN_SKILL_HOME = join(tmp, 'skill')
})

afterEach(() => {
  if (elozoHome === undefined) delete process.env.MARVEEN_SKILL_HOME
  else process.env.MARVEEN_SKILL_HOME = elozoHome
  rmSync(tmp, { recursive: true, force: true })
})

const cred = {
  memberId: '6b1f0d3e-8a24-4c1b-9f70-2f1a3c5d7e90',
  keyId: 'mak_teszt',
  attestKey: 'titok-kulcs',
  apiBase: 'https://example.supabase.co',
  enrolledAt: '2026-08-31T05:00:00Z',
}

describe('hitelesito tarolas', () => {
  it('a hatter EGY es megnevezett (nincs csendes OS-kulcstarto-feltetelezes)', () => {
    expect(tarolasiHatter()).toBe('file-0600')
  })

  it('a fajl 0600, a konyvtar 0700 -- visszaolvasott mode-bitekbol', () => {
    const ut = saveCredentials(cred)
    expect(statSync(ut).mode & 0o777).toBe(0o600)
    expect(statSync(join(tmp, 'skill')).mode & 0o777).toBe(0o700)
  })

  it('egy MAR LETEZO, tagabb jogu fajlt VISSZASZUKIT (a writeFileSync modja onmagaban nem tenne)', () => {
    const ut = credentialsPath()
    saveCredentials(cred)
    chmodSync(ut, 0o644)
    expect(statSync(ut).mode & 0o777).toBe(0o644) // kontroll: a lazitas tenyleg megtortent
    saveCredentials(cred)
    expect(statSync(ut).mode & 0o777).toBe(0o600)
  })

  it('visszaolvasva ugyanaz jon vissza', () => {
    saveCredentials(cred)
    expect(loadCredentials()).toEqual(cred)
  })

  it('ha nincs fajl, null -- nem hiba', () => {
    expect(loadCredentials()).toBeNull()
  })

  it('FAIL-CLOSED: tul tag jogosultsagnal NEM tolti be, hanem hibat dob', () => {
    const ut = saveCredentials(cred)
    chmodSync(ut, 0o644)
    expect(() => loadCredentials()).toThrow(CredentialsPermissionError)
  })

  it('a hibauzenet MEGMONDJA a javitast, es NEM irja ki a titkot', () => {
    const ut = saveCredentials(cred)
    chmodSync(ut, 0o604)
    try {
      loadCredentials()
      throw new Error('nem dobott')
    } catch (e) {
      const uzenet = (e as Error).message
      expect(uzenet).toContain('chmod 600')
      expect(uzenet).not.toContain(cred.attestKey)
    }
  })
})

describe('skill-fajlok kiirasa', () => {
  it('a projekt- es a user-hatokor kulon utat ad', () => {
    expect(skillTargetDir('project', '/x/y')).toBe('/x/y/.claude/skills')
    expect(skillTargetDir('user')).toContain(join('.claude', 'skills'))
  })

  it('alkonyvtarba is ir', () => {
    const cel = join(tmp, 'cel')
    const kiirt = writeSkillFiles(cel, [{ relPath: 'marveen-upload/SKILL.md', content: '# x\n' }])
    expect(existsSync(kiirt[0])).toBe(true)
    expect(readFileSync(kiirt[0], 'utf8')).toBe('# x\n')
  })

  it('ELUTASITJA a cel-konyvtarbol kilepo utat (a szerver valasza sem megbizhato bemenet)', () => {
    const cel = join(tmp, 'cel')
    expect(() => writeSkillFiles(cel, [{ relPath: '../../evil.md', content: 'x' }])).toThrow(/Elutasitott/)
    expect(() => writeSkillFiles(cel, [{ relPath: '/etc/evil.md', content: 'x' }])).toThrow(/Elutasitott/)
    // KONTROLL: a szabalyos ut UGYANEZEN a hivason atmegy
    expect(() => writeSkillFiles(cel, [{ relPath: 'ok/SKILL.md', content: 'x' }])).not.toThrow()
  })

  it('a kilepo ut elutasitasa UTAN semmi nem keletkezett a celon kivul', () => {
    const cel = join(tmp, 'cel')
    try {
      writeSkillFiles(cel, [{ relPath: '../szivargas.md', content: 'x' }])
    } catch { /* vart */ }
    expect(existsSync(join(tmp, 'szivargas.md'))).toBe(false)
  })
})
