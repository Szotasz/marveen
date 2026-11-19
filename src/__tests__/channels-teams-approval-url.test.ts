// TEAMSAPPROVECARD1118 (step D): channels.sh gives the main agent's Teams plugin the dashboard's loopback route for
// approval-card clicks (MARVEEN_APPROVAL_URL), in the same launch prefix that carries TEAMS_STATE_DIR. The block runs here
// in bash against a throwaway install .env; the launch command is then evaluated to show what the session would get.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = join(__dirname, '..', '..')
const CHANNELS = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a + from.length)
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} / ${to}`)
  return src.slice(a, b)
}
const BLOCK = between(CHANNELS, "# TEAMSAPPROVECARD1118: the main agent's Teams plugin", '# TEAMSAPPROVECARD1118 end')
const SQ = CHANNELS.split('\n').find((l) => l.startsWith('sh_single_quote() {'))!

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function run(provider: string, envFile: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'chan-approval-'))
  dirs.push(dir)
  if (envFile !== null) writeFileSync(join(dir, '.env'), envFile)
  const script = [
    SQ,
    `INSTALL_DIR=${JSON.stringify(dir)}`,
    `CHANNEL_PROVIDER=${provider}`,
    `STATE_DIR_ENV="export TEAMS_STATE_DIR='/x/teams' && "`,
    BLOCK,
    // what the spawned session would see: the launch prefix, evaluated, then the variable
    'eval "${STATE_DIR_ENV} printf \'URL=%s\\n\' \\"\\${MARVEEN_APPROVAL_URL:-}\\""',
  ].join('\n')
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })
  return { out: r.stdout, err: r.stderr, status: r.status }
}
const url = (port: number, host = '127.0.0.1') => `URL=http://${host}:${port}/api/approvals/teams-card-action`

describe('channels.sh: MARVEEN_APPROVAL_URL for the main agent Teams plugin', () => {
  it('Teams, no WEB_PORT in the install .env: the default dashboard port on loopback', () => {
    expect(run('teams', 'MAIN_AGENT_ID=marveen\n').out).toContain(url(3420))
    expect(run('teams', null).out).toContain(url(3420))
  })
  it('Teams with WEB_PORT (plain, quoted, CRLF): that port; a non-number falls back to the default', () => {
    expect(run('teams', 'WEB_PORT=4100\n').out).toContain(url(4100))
    expect(run('teams', 'WEB_PORT="4100"\r\n').out).toContain(url(4100))
    expect(run('teams', "WEB_PORT='4101'\n").out).toContain(url(4101))
    expect(run('teams', 'WEB_PORT=41$(id)00\n').out).toContain(url(3420))
  })
  it('a loopback or wildcard WEB_HOST keeps it; one non-loopback address drops it and says why', () => {
    expect(run('teams', 'WEB_HOST=0.0.0.0\nWEB_PORT=4100\n').out).toContain(url(4100))
    expect(run('teams', 'WEB_HOST=127.0.0.1\n').out).toContain(url(3420))
    const remote = run('teams', 'WEB_HOST=100.64.1.2\n')
    expect(remote.out).toContain('URL=\n')
    expect(remote.out).toContain('WEB_HOST=100.64.1.2 is not loopback')
  })
  // Measured with node 22 on macOS: ::1 answers only on [::1]; :: and an empty WEB_HOST also answer on 127.0.0.1;
  // localhost binds the resolver's first address (::1 there), so the URL keeps the name for the plugin to resolve.
  it('an IPv6 loopback WEB_HOST gets the [::1] URL; :: and empty stay on 127.0.0.1; localhost stays a name', () => {
    expect(run('teams', 'WEB_HOST=::1\nWEB_PORT=4100\n').out).toContain(url(4100, '[::1]'))
    expect(run('teams', 'WEB_HOST="[::1]"\n').out).toContain(url(3420, '[::1]'))
    expect(run('teams', 'WEB_HOST=::\n').out).toContain(url(3420))
    expect(run('teams', 'WEB_HOST=\n').out).toContain(url(3420))
    expect(run('teams', 'WEB_HOST=localhost\n').out).toContain(url(3420, 'localhost'))
    for (const h of ['::2', '[::1]x', 'localhost.example', '::ffff:10.0.0.1']) {
      const r = run('teams', `WEB_HOST=${h}\n`)
      expect(r.out).toContain('URL=\n')
      expect(r.out).toContain(`WEB_HOST=${h} is not loopback`)
    }
  })
  it('the state dir export is kept, and other providers get no approval URL', () => {
    const r = run('teams', '')
    expect(r.status).toBe(0)
    for (const p of ['telegram', 'slack', 'discord', 'gromzo']) expect(run(p, '').out).toBe('URL=\n')
  })
  it('the block sits before both main launch commands, which carry the prefix', () => {
    const at = CHANNELS.indexOf("# TEAMSAPPROVECARD1118: the main agent's Teams plugin")
    const launches = [...CHANNELS.matchAll(/"\$\{AUTH_PANE_ENV\}\$\{STATE_DIR_ENV\}/g)].map((m) => m.index!)
    expect(launches.length).toBe(2)
    for (const l of launches) expect(l).toBeGreaterThan(at)
  })
})
