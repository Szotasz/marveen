// GROMZOPLUGREG1109 (Samu 73877): the main agent takes its Gromzo channel only when the gromzo-channel plugin is also
// REGISTERED for Claude Code (installed_plugins.json). Measured on the QA VPS 11-09: an enrolled main agent with an
// unregistered plugin got --channels plugin:gromzo-channel@gromzo-local, no plugin server ran, and the dashboard's down
// cascade restarted the session. Here: the shell and the TS twin give the same reason on the same inputs, channels.sh
// names the reason while pending, the dashboard shows it, and the migration does not move such an install.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mainGromzoPendingReason, mainGromzoPrimaryReady, mainGromzoPluginRegistered } from '../web/main-gromzo-launch.js'

const ROOT = join(__dirname, '..', '..')
const LAUNCH_SH = join(ROOT, 'scripts', 'main-gromzo-launch.sh')
const REGISTERED = JSON.stringify({ version: 2, plugins: { 'gromzo-channel@gromzo-local': [{ scope: 'project', version: '0.1.0' }] } })
const OTHER_ONLY = JSON.stringify({ version: 2, plugins: { 'slack-channel@marveen-marketplace': [{ scope: 'user' }] } })

/** One fixture: an mxd run dir (agent.sock, tokens/) and a plugins file, each part optional. */
function fixture(o: { sock?: boolean; tokensDir?: boolean; token?: string | null; plugins?: string | null }) {
  const dir = mkdtempSync(join(tmpdir(), 'gz-plugreg-'))
  const sock = join(dir, 'agent.sock')
  if (o.sock) writeFileSync(sock, '')
  if (o.tokensDir) mkdirSync(join(dir, 'tokens'))
  if (o.tokensDir && o.token !== undefined && o.token !== null) writeFileSync(join(dir, 'tokens', 'marveen.token'), o.token)
  const plugins = join(dir, 'installed_plugins.json')
  if (o.plugins !== undefined && o.plugins !== null) writeFileSync(plugins, o.plugins)
  return { sock, plugins }
}

function shellReason(slug: string, f: { sock: string; plugins: string }): string {
  const r = spawnSync('bash', ['-c', `. '${LAUNCH_SH}'; main_gromzo_pending_reason '${slug}'; echo; main_gromzo_primary_ready '${slug}' && echo READY || echo PENDING`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent-home', MAIN_GROMZO_SOCK_PATH: f.sock, MAIN_GROMZO_PLUGINS_FILE: f.plugins },
  })
  return r.stdout.trim().replace(/\n/, ' | ')
}

const CASES: Array<[string, string, Parameters<typeof fixture>[0], string | null]> = [
  ['a slug mxd refuses', 'Bad Slug!', { sock: true, tokensDir: true, token: 'tok', plugins: REGISTERED }, 'bad_slug'],
  ['no agent socket', 'marveen', { plugins: REGISTERED }, 'mxd_socket'],
  ['socket, no tokens dir', 'marveen', { sock: true, plugins: REGISTERED }, 'not_enrolled'],
  ['no token file (not approved / held)', 'marveen', { sock: true, tokensDir: true, plugins: REGISTERED }, 'not_enrolled'],
  ['an empty token', 'marveen', { sock: true, tokensDir: true, token: '', plugins: REGISTERED }, 'not_enrolled'],
  ['enrolled, NO plugins file (the VPS case)', 'marveen', { sock: true, tokensDir: true, token: 'tok' }, 'plugin_not_registered'],
  ['enrolled, plugins file without the gromzo key', 'marveen', { sock: true, tokensDir: true, token: 'tok', plugins: OTHER_ONLY }, 'plugin_not_registered'],
  ['enrolled, an empty plugins file', 'marveen', { sock: true, tokensDir: true, token: 'tok', plugins: '' }, 'plugin_not_registered'],
  ['enrolled AND registered', 'marveen', { sock: true, tokensDir: true, token: 'tok', plugins: REGISTERED }, null],
  // Dani 73921: two conditions failing at once pin the ORDER (a twin that checked the plugin before the enrolment, or
  // the enrolment before the socket, gave the same READY/PENDING and passed every row above).
  ['NOT enrolled AND no plugin: not_enrolled first', 'marveen', { sock: true, tokensDir: true }, 'not_enrolled'],
  ['no socket AND not enrolled AND no plugin: mxd_socket first', 'marveen', {}, 'mxd_socket'],
  ['a bad slug AND no socket: bad_slug first', 'Bad Slug!', {}, 'bad_slug'],
]

describe('the pending reason: the shell and the TS twin agree on every input (GROMZOPLUGREG1109)', () => {
  for (const [name, slug, o, want] of CASES) {
    it(name, () => {
      const f = fixture(o)
      expect(mainGromzoPendingReason(slug, f.sock, f.plugins)).toBe(want)
      expect(mainGromzoPrimaryReady(slug, f.sock, f.plugins)).toBe(want === null)
      expect(shellReason(slug, f)).toBe(want === null ? 'READY' : `${want} | PENDING`)
    })
  }
  it('mainGromzoPluginRegistered: the key, or no; an unreadable path is no', () => {
    const f = fixture({ plugins: REGISTERED })
    expect(mainGromzoPluginRegistered(f.plugins)).toBe(true)
    expect(mainGromzoPluginRegistered(join(f.plugins, 'missing'))).toBe(false)
  })
})

describe('channels.sh names the reason while pending (the start line, and a changed reason on the 60 s poll)', () => {
  const CHANNELS = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf8')
  const between = (src: string, from: string, to: string): string => {
    const a = src.indexOf(from)
    const b = src.indexOf(to, a + from.length)
    if (a < 0 || b < 0) throw new Error(`slice not found: ${from}`)
    return src.slice(a, b)
  }
  it('the REAL start block: an unregistered plugin -> pending (plugin_not_registered), no --channels at all', () => {
    const START = between(CHANNELS, 'GROMZO_PENDING=0\n', '# SLACKDMVESZT1006:')
    const r = spawnSync('bash', ['-c', [
      'main_gromzo_primary_ready() { return 1; }',
      'main_gromzo_pending_reason() { printf plugin_not_registered; }',
      'main_gromzo_env() { :; }',
      'CHANNEL_PROVIDER=gromzo MAIN_AGENT_ID=marveen PLUGIN_ID="gromzo-channel@gromzo-local" GROMZO_ENV="" CHANNEL_PLUGINS_EXTRA=""',
      START,
      'printf "PENDING=%s\\nARG=%s\\nREASON=%s\\n" "$GROMZO_PENDING" "$CHANNELS_ARG" "$GROMZO_LAST_REASON"',
    ].join('\n')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })
    expect(r.stdout).toContain('PENDING=1\nARG=\nREASON=plugin_not_registered\n')
    expect(r.stderr).toContain('channels.sh: gromzo pending (plugin_not_registered) -- ')
  })
  it('the poll says a CHANGED reason once, before it checks ready (never one line per poll)', () => {
    expect(CHANNELS).toMatch(/_gz_reason="\$\(main_gromzo_pending_reason "\$MAIN_AGENT_ID"\)"\n\s+if \[ -n "\$_gz_reason" \] && \[ "\$_gz_reason" != "\$\{GROMZO_LAST_REASON:-\}" \]; then\n\s+echo "channels.sh: gromzo pending \(\$_gz_reason\) -- still without the Gromzo channel" >&2\n\s+GROMZO_LAST_REASON="\$_gz_reason"/)
    const poll = CHANNELS.slice(CHANNELS.indexOf('_gz_reason="$(main_gromzo_pending_reason'))
    expect(poll.indexOf('GROMZO_LAST_REASON="$_gz_reason"')).toBeLessThan(poll.indexOf('channels.sh: gromzo ready -- restarting'))
  })
})

describe('the dashboard shows it: GET /api/gromzo/status mainPending on a gromzo install', () => {
  it('the status route sets mainPending from the TS twin, only on CHANNEL_PROVIDER=gromzo', () => {
    const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'gromzo.ts'), 'utf8')
    expect(route).toContain("if (CHANNEL_PROVIDER === 'gromzo') out.mainPending = mainGromzoPendingReason(MAIN_AGENT_ID)")
  })
})
