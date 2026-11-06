// MXDAGENTSOCKID1106: the Gromzo token protection where the owner sees it (Samu 71344 (1), 71418): the doctor lines
// (scripts/lib/gromzo-protection-check.sh, fed the dash status JSON) and the panel (web/app.js, the HU/EN strings).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const LIB = join(ROOT, 'scripts', 'lib', 'gromzo-protection-check.sh')

function lines(status: unknown): string[] {
  const out = execFileSync('/bin/bash', ['-c', '. "$1"; gromzo_protection_lines', 'x', LIB], { input: typeof status === 'string' ? status : JSON.stringify(status), encoding: 'utf-8' })
  return out.split('\n').filter(Boolean)
}
const agents = (o: Record<string, string[]>) => ({ running: [], held: [], protected: [], refused: [], ...o })

describe('doctor: the Gromzo protection lines', () => {
  it('the fail-closed ratchet is a warning, first', () => {
    const l = lines({ ok: true, agents: agents({ running: ['zara'], protected: [] }), ratchet_unreadable: true })
    expect(l[0]).toMatch(/^warn\|Gromzo: the protection state is unreadable, every agent counts as protected/)
    expect(l.join('\n')).not.toMatch(/running without a token/)
  })
  it('a refused agent is a warning naming it; a running unprotected one is info; protected ones are ok', () => {
    expect(lines({ ok: true, agents: agents({ running: ['abel', 'zara'], protected: ['zara'], refused: ['abel'] }) }))
      .toEqual(['warn|Gromzo: refused in the last 10 min, the plugin sends no token: abel (update the plugin or restart the session)'])
    expect(lines({ ok: true, agents: agents({ running: ['samu', 'zara'], protected: ['zara'] }) }))
      .toEqual(['info|Gromzo: running without a token yet: samu (protected after its next session restart)', 'ok|Gromzo: protected agents: zara'])
  })
  it('an mxd before the tokens, or a reply that is not JSON, is info only, never a failure', () => {
    expect(lines({ ok: true, running: true, linked: true })).toEqual(['info|mxd reports no token protection (an mxd before MXDAGENTSOCKID1106)'])
    expect(lines('not json')).toEqual(['info|mxd status is not readable JSON'])
  })
  it('doctor reports the section and never fails the run on it', () => {
    const doc = readFileSync(join(ROOT, 'scripts', 'doctor.sh'), 'utf-8')
    const sec = doc.slice(doc.indexOf('# --- Gromzo token protection'), doc.indexOf('# --- Spotlight'))
    expect(sec).toContain('gromzo_protection_lines')
    expect(sec).not.toMatch(/\bfail\b/)
  })
})

describe('the panel: badges and the fail-closed banner', () => {
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
  it('the rows show refused and unprotected; the list shows the unreadable ratchet', () => {
    expect(app).toContain("if (row.protection === 'refused' || row.protection === 'unprotected') {")
    expect(app).toContain("prot.textContent = t('gromzo.agents.prot.' + row.protection)")
    expect(app).toContain("ratchetEl.textContent = body.ratchetUnreadable === true ? t('gromzo.agents.prot.ratchet_unreadable') : ''")
    // Shown exactly when mxd says so, hidden otherwise.
    expect(app).toContain('ratchetEl.hidden = body.ratchetUnreadable !== true')
    expect(readFileSync(join(ROOT, 'web', 'index.html'), 'utf-8')).toContain('<p class="mobile-login-warn gromzo-agent-state is-error" id="gromzoAgentsRatchet" role="alert" hidden></p>\n          <ul class="gromzo-agent-list" id="gromzoAgentList">')
  })
  it('every protection key exists in HU and EN, with no dash characters', () => {
    for (const lang of ['hu', 'en']) {
      const src = readFileSync(join(ROOT, 'web', 'lang', `${lang}.js`), 'utf-8')
      for (const k of ['refused', 'unprotected', 'ratchet_unreadable']) {
        const line = src.split('\n').find((l) => l.includes(`'gromzo.agents.prot.${k}':`))
        expect(line, `${lang} ${k}`).toBeDefined()
        expect(line).not.toMatch(/[–—]/)
      }
    }
  })
})
