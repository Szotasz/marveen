// VAULTLOGIN1112: the Vault page's web logins section. Pinned: it sits on the Vault page with its texts in both
// languages, the password field is a new-password field the page never fills back, an edit sends the password only
// when one was typed, the agent checkboxes start unchecked, and the copy carries no dash (owner rule) and no
// statement about the password and the browser snapshots (owner decision: "nem kell kiírni sehova").
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HTML = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf-8')
const HU = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

const between = (src: string, from: string, to: string) => {
  const i = src.indexOf(from)
  const j = i < 0 ? -1 : src.indexOf(to, i)
  return i < 0 || j < 0 ? '' : src.slice(i, j)
}
const PAGE = between(HTML, '<div class="page" id="vaultPage"', '<!-- === Token Usage Page === -->')
const SECTION = between(HTML, '<!-- === Web logins section (VAULTLOGIN1112) === -->', '<!-- SSH Key Generation modal')
const JS = between(APP, '// --- Web logins (VAULTLOGIN1112) ---', '// --- Vault Page ---')
const keysOf = (lang: string) => new Map([...lang.matchAll(/^  '(vault\.weblogin\.[^']+)':\s*'((?:[^'\\]|\\.)*)'/gm)].map((m) => [m[1]!, m[2]!]))

describe('the web logins section of the Vault page', () => {
  it('is on the Vault page, and its JS was found', () => {
    expect(SECTION.length).toBeGreaterThan(500)
    expect(PAGE).toContain('id="webLoginSection"')
    expect(JS.length).toBeGreaterThan(1000)
    expect(APP).toContain('loadSshServers(), loadWebLogins()')
  })

  it('every key the section and its JS use exists in Hungarian and in English', () => {
    const used = new Set([...(SECTION + JS).matchAll(/vault\.weblogin\.[a-z0-9_.-]+/g)].map((m) => m[0]))
    // The result keys are built from the outcome name.
    used.delete('vault.weblogin.result.')
    const hu = keysOf(HU)
    const en = keysOf(EN)
    expect(used.size).toBeGreaterThan(20)
    for (const k of used) {
      expect(hu.has(k), `hu ${k}`).toBe(true)
      expect(en.has(k), `en ${k}`).toBe(true)
    }
    for (const o of ['success', '2fa', 'wrong', 'unknown', 'origin-mismatch', 'no-form', 'browser-unavailable']) {
      expect(hu.has(`vault.weblogin.result.${o}`), o).toBe(true)
      expect(en.has(`vault.weblogin.result.${o}`), o).toBe(true)
    }
    expect([...hu.keys()].sort()).toEqual([...en.keys()].sort())
  })

  it('no em or en dash in the copy, and no statement about the password and the snapshots', () => {
    const copy = [...keysOf(HU).values(), ...keysOf(EN).values(), SECTION].join('\n')
    expect(copy).not.toMatch(/[–—]/)
    expect(copy).not.toMatch(/ezredmásodperc|millisecond|pillanatkép|snapshot|abszolút garancia|absolute guarantee/i)
  })

  it('the password is a new-password field that the page never fills back', () => {
    expect(SECTION).toMatch(/<input type="password" id="webLoginPassInput"[^>]*autocomplete="new-password"/)
    expect(JS).not.toMatch(/webLoginPassInput'\)\.value = entry/)
    expect(JS).toContain("pass.value = ''")
    expect(JS).not.toMatch(/\.password\b(?!\s*=\s*password)/)
  })

  it('an edit sends the password only when one was typed', () => {
    expect(JS).toContain('if (password) body.password = password')
    expect(JS).not.toMatch(/body\s*=\s*\{[^}]*password/)
  })

  it('the agent checkboxes start unchecked for a new entry, and the hint says an empty list means nobody', () => {
    expect(JS).toContain('_renderWebLoginAgentChecks(entry ? entry.allowedAgents || [] : [])')
    expect(keysOf(HU).get('vault.weblogin.form.agents_hint')).toBe('Ha egy ügynök sincs bejelölve, a belépést senki nem használhatja.')
  })
})
