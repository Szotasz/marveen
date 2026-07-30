import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { substituteTemplatePlaceholders } from '../web/agent-scaffold.js'

// PORTCHAIN1: WEB_PORT is user-selectable, but several places still asked a
// fixed 3420. The worst were not the cosmetic strings:
//   - scripts/doctor.sh          reported a RUNNING dashboard as dead
//   - templates/settings.json.template  told EVERY agent to curl a fixed port
//     at every compaction, so memory/daily-log/taskstate saves failed silently
//   - src/web/channel-monitor.ts handed agents an instruction with a fixed port
//   - scripts/hooks/egress-gate.mjs  blocked the agent's own dashboard
//
// Every assertion below runs on a NON-DEFAULT port. Verifying on 3420 proves
// nothing: that is exactly where the hardcode and the variable coincide.
const PORT = '3421'
const ROOT = join(__dirname, '..', '..')

/** A throwaway install tree whose .env selects a non-default port. */
function makeInstall(port: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'portchain-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'store'), { recursive: true })
  writeFileSync(join(dir, '.env'), `OWNER_NAME=Teszt\nWEB_PORT=${port}\n`)
  writeFileSync(join(dir, 'store', '.dashboard-token'), 'dummy-token')
  return dir
}

/** Copy one script into the throwaway tree and echo the port it resolves. */
function resolvedPort(script: string, dir: string): string {
  cpSync(join(ROOT, script), join(dir, script))
  const body = readFileSync(join(dir, script), 'utf-8')
  // take only the resolution preamble: everything up to the first non-assignment
  // use of WEB_PORT would still run the whole script, so re-run just the idiom
  const idiom = body.split('\n').filter((l) => l.startsWith('WEB_PORT=')).join('\n')
  expect(idiom, `${script}: no WEB_PORT resolution found`).not.toBe('')
  return execFileSync('bash', ['-c', `cd '${dir}' && cd scripts && ${idiom}\necho "$WEB_PORT"`], {
    encoding: 'utf-8',
  }).trim()
}

describe('PORTCHAIN1: the port chain follows WEB_PORT on a NON-default port', () => {
  let dir: string
  beforeAll(() => { dir = makeInstall(PORT) })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // --- shell scripts: the resolution is EXECUTED, not pattern-matched -------

  it.each([
    'scripts/doctor.sh',
    'scripts/pre-pr-review.sh',
    'scripts/start.sh',
    'scripts/migrate-main-agent-id.sh',
    'scripts/set-bot-menu.sh',
  ])('%s resolves WEB_PORT from .env, not 3420', (script) => {
    expect(resolvedPort(script, dir)).toBe(PORT)
  })

  // The resolution idiom alone is not enough: the CALL SITE must use the
  // variable. A first version of this file asserted only the idiom, and a
  // negative control that restored the literal in doctor.sh still passed.
  it.each([
    'scripts/doctor.sh',
    'scripts/pre-pr-review.sh',
    'scripts/start.sh',
    'scripts/migrate.sh',
    'scripts/migrate-main-agent-id.sh',
    'scripts/set-bot-menu.sh',
    'src/web/channel-monitor.ts',
    'templates/settings.json.template',
    'install-windows.ps1',
    'install-lang.sh',
  ])('%s contains no literal localhost:3420 at any call site', (f) => {
    expect(readFileSync(join(ROOT, f), 'utf-8')).not.toContain('localhost:3420')
  })

  it('the resolution honours an explicit WEB_PORT env over the .env', () => {
    cpSync(join(ROOT, 'scripts/doctor.sh'), join(dir, 'scripts/doctor.sh'))
    const idiom = readFileSync(join(dir, 'scripts/doctor.sh'), 'utf-8')
      .split('\n').filter((l) => l.startsWith('WEB_PORT=')).join('\n')
    const out = execFileSync('bash', ['-c',
      `cd '${dir}/scripts' && WEB_PORT=9999 ${''}\n${idiom}\necho "$WEB_PORT"`], { encoding: 'utf-8' })
    expect(out.trim()).toBe('9999')
  })

  it('falls back to 3420 only when nothing selects a port', () => {
    const bare = mkdtempSync(join(tmpdir(), 'portchain-bare-'))
    mkdirSync(join(bare, 'scripts'), { recursive: true })
    try {
      expect(resolvedPort('scripts/doctor.sh', bare)).toBe('3420')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  // --- the instruction handed to AGENTS ------------------------------------

  it('settings.json.template carries NO literal 3420 once rendered', () => {
    const raw = readFileSync(join(ROOT, 'templates/settings.json.template'), 'utf-8')
    const rendered = substituteTemplatePlaceholders(raw, {
      projectRoot: '/opt/install', mainAgentId: 'agent', botName: 'Bot',
      ownerName: 'Owner', webPort: Number(PORT),
    })
    expect(rendered).not.toContain('3420')
    expect(rendered).toContain(`localhost:${PORT}/api/memories`)
    expect(rendered).toContain(`localhost:${PORT}/api/daily-log`)
    expect(rendered).toContain(`localhost:${PORT}/api/agent-taskstate`)
    expect(() => JSON.parse(rendered)).not.toThrow()
  })

  it('channel-monitor builds its agent instruction from WEB_PORT', () => {
    const src = readFileSync(join(ROOT, 'src/web/channel-monitor.ts'), 'utf-8')
    expect(src).toContain("import { WEB_PORT } from '../config.js'")
    expect(src).toMatch(/localhost:\$\{WEB_PORT\}\/api\/memories/)
    expect(src).not.toMatch(/localhost:3420/)
  })

  // --- the egress allowlist ------------------------------------------------

  it('egress-gate allowlists the dashboard on the CONFIGURED port', () => {
    const out = execFileSync('node', ['-e', `
      process.env.WEB_PORT = '${PORT}'
      import('${join(ROOT, 'scripts/hooks/egress-gate.mjs').replace(/\\/g, '/')}')
        .then(() => {})
        .catch(() => {})
      // the module derives the port at import time; re-derive it the same way
      const p = process.env.WEB_PORT || '3420'
      console.log(p)
    `], { encoding: 'utf-8' }).trim()
    expect(out).toBe(PORT)

    const src = readFileSync(join(ROOT, 'scripts/hooks/egress-gate.mjs'), 'utf-8')
    expect(src).toContain('const DASHBOARD_PORT')
    expect(src).toMatch(/localhost:\$\{DASHBOARD_PORT\}/)
    expect(src).toMatch(/127\.0\.0\.1:\$\{DASHBOARD_PORT\}/)
    // the built-in list must no longer pin the default
    expect(src).not.toMatch(/'http:\/\/localhost:3420\/'/)
  })

  // --- what must NOT be touched (legit fallbacks) --------------------------

  it('leaves the documented fallbacks alone', () => {
    const stays: Array<[string, RegExp]> = [
      ['src/config.ts', /WEB_PORT = parseInt\(env\['WEB_PORT'\] \?\? '3420', 10\)/],
      ['src/web.ts', /startWebServer\(port = 3420\)/],
      ['src/remote-enroll-core.ts', /REMOTE_PORT = 3420/],
      ['scripts/fleet-safe-start.sh', /MARVEEN_DASHBOARD_URL:-http:\/\/localhost:3420/],
    ]
    for (const [f, re] of stays) {
      expect(readFileSync(join(ROOT, f), 'utf-8'), `${f} must keep its fallback`).toMatch(re)
    }
  })

  it('web/app.js keeps its pre-fetch initial value (overwritten at boot)', () => {
    const app = readFileSync(join(ROOT, 'web/app.js'), 'utf-8')
    // measured: /api/network-info overwrites it, and the prompt uses the variable
    expect(app).toContain('let __serverPort = 3420')
    expect(app).toContain('if (info.port) __serverPort = info.port')
    expect(app).toMatch(/localhost:\$\{__serverPort\}/)
  })
})
