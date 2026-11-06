// MXDAGENTSOCKID1106: the Gromzo token protection where the owner sees it (Samu 71344 (1), 71418): the doctor lines
// (scripts/lib/gromzo-protection-check.sh, fed the dash status JSON) and the panel (web/app.js, the HU/EN strings).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
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
  it('the dash.sock path honours MXD_DASH_SOCK in the install env file, as the dashboard does (Dani 71532 (2))', async () => {
    const d = mkdtempSync(join(tmpdir(), 'gz-doc-'))
    const sock = join(d, 'custom-dash.sock')
    const srv = createServer()
    await new Promise<void>((res) => srv.listen(sock, res))
    try {
      const ctl = join(d, 'mxdctl'); writeFileSync(ctl, '#!/bin/sh\n'); chmodSync(ctl, 0o755)
      const envFile = join(d, 'install.env'); writeFileSync(envFile, `OTHER=1\nMXD_DASH_SOCK="${sock}"\n`)
      const pick = (f: string) => execFileSync('/bin/bash', ['-c', '. "$1"; gromzo_mxdctl_and_sock "$2"', 'x', LIB, f], { encoding: 'utf-8', env: { ...process.env, GROMZO_MXDCTL: ctl } })
      expect(pick(envFile)).toBe(`${ctl}|${sock}`)
      // No env file: the platform default, never the custom path. Whether the default socket exists depends on the
      // host (a live mxd, or none on CI), so only that holds; the call itself must succeed either way (rc 0).
      expect(pick(join(d, 'missing.env'))).not.toContain(sock)
      // A dash.sock that is not there: an empty answer with rc 0, never a failure (the CI case, made explicit here).
      const noSock = join(d, 'gone.env'); writeFileSync(noSock, `MXD_DASH_SOCK="${join(d, 'no-such.sock')}"\n`)
      expect(pick(noSock)).toBe('')
      expect(readFileSync(join(ROOT, 'scripts', 'doctor.sh'), 'utf-8')).toContain('gromzo_mxdctl_and_sock "$INSTALL_DIR/.env"')
    } finally {
      await new Promise<void>((res) => srv.close(() => res()))
      rmSync(d, { recursive: true, force: true })
    }
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
    expect(app).toContain("    ratchetEl.textContent = key ? t(key) : ''\n    ratchetEl.hidden = !key")
    // Shown exactly when mxd says so; cleared at the start of every load, so a failed reload never leaves the last
    // answer's banner standing (Dani 71532 (1)); a failed load says the state is not available (Samu 71546).
    const load = app.slice(app.indexOf('  async function loadAgents() {'))
    const body = load.slice(0, load.indexOf('\n  }\n'))
    expect(body.indexOf('showProtBanner(null)')).toBeGreaterThan(-1)
    expect(body.indexOf('showProtBanner(null)')).toBeLessThan(body.indexOf("await fetch('/api/gromzo/agents'"))
    expect(body).toContain("showProtBanner(body.ratchetUnreadable === true ? 'gromzo.agents.prot.ratchet_unreadable' : null)")
    expect(body.match(/showProtBanner\('gromzo\.agents\.prot\.unavailable'\)/g)?.length, 'both failure branches').toBe(2)
    const notOk = body.slice(body.indexOf('if (!r.ok) {'), body.indexOf('window.gromzoOwnerLogin(false)'))
    expect(notOk).toContain("showProtBanner('gromzo.agents.prot.unavailable')")
    expect(body.slice(body.indexOf('} catch {'))).toContain("showProtBanner('gromzo.agents.prot.unavailable')")
    expect(readFileSync(join(ROOT, 'web', 'index.html'), 'utf-8')).toContain('<p class="mobile-login-warn gromzo-agent-state is-error" id="gromzoAgentsRatchet" role="alert" hidden></p>\n          <ul class="gromzo-agent-list" id="gromzoAgentList">')
  })
  it('every protection key exists in HU and EN, with no dash characters', () => {
    for (const lang of ['hu', 'en']) {
      const src = readFileSync(join(ROOT, 'web', 'lang', `${lang}.js`), 'utf-8')
      for (const k of ['refused', 'unprotected', 'ratchet_unreadable', 'unavailable']) {
        const line = src.split('\n').find((l) => l.includes(`'gromzo.agents.prot.${k}':`))
        expect(line, `${lang} ${k}`).toBeDefined()
        expect(line).not.toMatch(/[–—]/)
      }
    }
  })
})
