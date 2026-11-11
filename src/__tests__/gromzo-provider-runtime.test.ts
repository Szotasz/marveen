// GROMZONOPROVIDER1108: the main agent on CHANNEL_PROVIDER=gromzo. The REAL channels.sh blocks are sliced and run:
// the start block (the Gromzo plugin is the primary when the main agent is enrolled, else a gromzo-pending session
// with no Gromzo channel) and the watchdog's pending branch (no never-started budget is spent while pending; a 60 s
// poll restarts the session once it is ready). Plus the TS respawn builder and the other launchers' text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'
import { getProvider, providerCapabilities, getProviderType, getChannelToken, readChannelToken } from '../channel-provider.js'
import { matchesProviderPollerCmd } from '../channel-coordinator/provider-poller-match.js'

const ROOT = join(__dirname, '..', '..')
const CHANNELS = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a + from.length)
  if (a < 0 || b < 0) throw new Error(`slice not found: ${from}`)
  return src.slice(a, b)
}
const bash = (script: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } })

describe('channels.sh: the gromzo primary or a gromzo-pending session (start block)', () => {
  const START = between(CHANNELS, 'GROMZO_PENDING=0\n', '# SLACKDMVESZT1006:')
  const run = (ready: boolean, extra: string) => bash([
    `main_gromzo_primary_ready() { ${ready ? 'return 0' : 'return 1'}; }`,
    'main_gromzo_env() { printf \'export MXD_AGENT="marveen" && \'; }',
    'CHANNEL_PROVIDER=gromzo MAIN_AGENT_ID=marveen PLUGIN_ID="gromzo-channel@gromzo-local" GROMZO_ENV=""',
    `CHANNEL_PLUGINS_EXTRA="${extra}"`,
    START,
    'printf "PENDING=%s\\nARG=%s\\nENV=%s\\n" "$GROMZO_PENDING" "$CHANNELS_ARG" "$GROMZO_ENV"',
  ].join('\n'))

  it('enrolled: the Gromzo plugin is the primary, with its exports, and is not also an extra', () => {
    const r = run(true, 'gromzo-channel@gromzo-local slack-channel@marveen-marketplace')
    expect(r.stdout).toContain('PENDING=0\n')
    expect(r.stdout).toContain('ARG=--channels plugin:gromzo-channel@gromzo-local plugin:slack-channel@marveen-marketplace\n')
    expect(r.stdout).toContain('ENV=export MXD_AGENT="marveen" && \n')
  })
  it('not enrolled: gromzo pending, NO --channels at all (and says so once)', () => {
    const r = run(false, 'gromzo-channel@gromzo-local')
    expect(r.stdout).toContain('PENDING=1\nARG=\nENV=\n')
    expect(r.stderr).toContain('gromzo pending')
  })
  it('not enrolled with a co-listen extra: only the extra', () => {
    const r = run(false, 'slack-channel@marveen-marketplace')
    expect(r.stdout).toContain('ARG=--channels plugin:slack-channel@marveen-marketplace\n')
  })
  it('both launch lines use CHANNELS_ARG, never a bare `--channels plugin:${PLUGIN_ID}`', () => {
    expect(CHANNELS.match(/\$\{MODEL_FLAG\}\$\{CHANNELS_ARG\}"/g)?.length).toBe(2)
    expect(CHANNELS).not.toContain('${MODEL_FLAG}--channels plugin:')
  })
  it('resolve_plugin_ids knows gromzo; no state dir export for it; no post-init Bun unlock', () => {
    expect(CHANNELS).toMatch(/gromzo\)\s+PLUGIN_ID="gromzo-channel@gromzo-local";\s+PLUGIN_PANE_ID="plugin:gromzo-channel:gromzo"/)
    expect(CHANNELS).toContain('[ "$CHANNEL_PROVIDER" = "gromzo" ] && STATE_DIR_ENV=""')
    expect(CHANNELS).toMatch(/\(\n  # GROMZONOPROVIDER1108[^\n]*\n  \[ "\$CHANNEL_PROVIDER" = "gromzo" \] && exit 0\n  # CHANNELUNCONF1110[^\n]*\n  \[ "\$CHANNEL_UNCONFIGURED" = "1" \] && exit 0\n  sleep 15/)
  })
})

describe('channels.sh watchdog: gromzo pending spends no never-started budget, and restarts once ready', () => {
  const PENDING = between(CHANNELS, '  if [ "$CHANNEL_PROVIDER" = "gromzo" ] && [ "$GROMZO_PENDING" = "1" ]; then\n', '  _plugin_alive=false\n')
  // The block sits in the real loop BEFORE the never-started deadline check; the harness keeps that order.
  const loop = (readyAt: number) => bash([
    `main_gromzo_primary_ready() { [ "$NOW" -ge ${readyAt} ]; }`,
    'respawn_log() { echo "LOG $*"; }',
    'CHANNEL_PROVIDER=gromzo GROMZO_PENDING=1 GROMZO_LAST_POLL=0 MAIN_AGENT_ID=marveen SESSION=marveen-channels',
    'PLUGIN_NEVER_STARTED_DEADLINE=600 EXIT_REASON=session-gone POLLS=0',
    'for NOW in $(seq 5 5 5000); do',
    PENDING,
    '  if [ "$NOW" -ge "$PLUGIN_NEVER_STARTED_DEADLINE" ]; then EXIT_REASON=plugin-never-started; break; fi',
    'done',
    'echo "EXIT=$EXIT_REASON NOW=$NOW RESTART=${RESTART_REQUESTED:-0}"',
  ].join('\n'))

  it('pending for 4000 s (past the 2400 s cap): never "plugin-never-started"; ready -> one restart', () => {
    const r = loop(4000)
    expect(r.stdout).toContain('EXIT=gromzo-ready NOW=40')
    expect(r.stdout).toContain('RESTART=1')
    expect(r.stdout).toContain('LOG gromzo-ready:')
    // the 60 s poll: ready at 4000 is seen at the first poll at or after it (4020 = 67 * 60)
    expect(r.stdout).toMatch(/NOW=40[0-5]\d /)
  })
  it('never ready: the loop runs out without any exit (no budget, no restart)', () => {
    const r = loop(999999)
    expect(r.stdout).toContain('EXIT=session-gone NOW=5000 RESTART=0')
  })
  it('the live Gromzo plugin is a Node child under the pane matching /gromzo-channel/; Bun is never asked for it', () => {
    expect(CHANNELS).toContain("/usr/bin/pgrep -P \"$_watchdog_claude_pid\" -f '/gromzo-channel/'")
    expect(CHANNELS).toMatch(/if \[ "\$CHANNEL_PROVIDER" = "gromzo" \]; then\n[\s\S]{0,400}elif \[ "\$_plugin_alive" != "true" \] && \[ "\$_bot_hijacked" != "true" \]; then\n\s+if \[ -n "\$_watchdog_claude_pid" \] && \/usr\/bin\/pgrep -P "\$_watchdog_claude_pid" bun/)
  })
})

describe('the other launchers of the main session take gromzo the same way', () => {
  const smg = readFileSync(join(ROOT, 'scripts', 'stuck-modal-guard.sh'), 'utf8')
  const cw = readFileSync(join(ROOT, 'scripts', 'channel-watchdog.sh'), 'utf8')
  it('stuck-modal-guard: the respawn plugin follows the install provider (it was telegram for every install)', () => {
    expect(smg).not.toContain('RESPAWN_PLUGIN="${STUCK_MODAL_PLUGIN:-plugin:telegram@claude-plugins-official}"')
    expect(smg).toMatch(/gromzo\)\s+_smg_default="plugin:gromzo-channel@gromzo-local"/)
    expect(smg).toContain('main_gromzo_primary_ready "$_gz_main"')
    expect(smg).toContain('${MODEL_FLAG}${CHAN_ARG}"')
  })
  it('channel-watchdog: gromzo primary, pending without it', () => {
    expect(cw).toMatch(/gromzo\)\s+PRIMARY_PLUGIN_ID="gromzo-channel@gromzo-local"/)
    expect(cw).toContain('${MODEL_FLAG}${CHANNELS_ARG}"')
  })
})

describe('the TS respawn builder (channel-monitor)', () => {
  const base = {
    claudePath: '/c/claude',
    channelStateEnv: { name: 'GROMZO_STATE_DIR', dir: '/x' },
    config: {} as never,
    model: '',
    continueSession: false,
    mainAgentId: 'marveen',
    gromzoTokenFile: '/run/marveen-mxd/tokens/marveen.token',
  }
  it('gromzo ready: --channels plugin:gromzo-channel@gromzo-local, MXD_AGENT exported, not doubled from the extras', () => {
    const cmd = buildMainSessionRespawnCmd({ ...base, pluginId: 'gromzo-channel@gromzo-local', extraPluginIds: ['gromzo-channel@gromzo-local'], gromzoPrimaryReady: true })
    expect(cmd).toContain('--channels plugin:gromzo-channel@gromzo-local')
    expect(cmd.match(/plugin:gromzo-channel@gromzo-local/g)?.length).toBe(1)
    expect(cmd).toContain('export MXD_AGENT="marveen" MXD_SCOPE="both"')
  })
  it('gromzo pending: no --channels, no MXD exports', () => {
    const cmd = buildMainSessionRespawnCmd({ ...base, pluginId: 'gromzo-channel@gromzo-local', extraPluginIds: ['gromzo-channel@gromzo-local'], gromzoPrimaryReady: false })
    expect(cmd).not.toContain('--channels')
    expect(cmd).not.toContain('MXD_AGENT')
  })
  it('a telegram install is unchanged: --channels plugin:telegram@... plus its extras', () => {
    const cmd = buildMainSessionRespawnCmd({ ...base, pluginId: 'telegram@claude-plugins-official', extraPluginIds: ['slack-channel@marveen-marketplace'] })
    expect(cmd).toContain('--channels plugin:telegram@claude-plugins-official plugin:slack-channel@marveen-marketplace')
  })
})

describe('the provider registry', () => {
  it('gromzo is a known provider (not the GH #846 telegram fallback), with no token, no Bun, no sub-agent default', () => {
    expect(getProviderType('gromzo')).toBe('gromzo')
    expect(getProvider('gromzo').pluginId).toBe('gromzo-channel@gromzo-local')
    expect(getChannelToken('gromzo', { TELEGRAM_BOT_TOKEN: 'x' })).toBe('')
    expect(readChannelToken('gromzo', '/nonexistent/.env')).toBeNull()
    expect(providerCapabilities('gromzo')).toEqual({ needsBun: false, subAgentDefault: 'none', directSend: false })
    expect(providerCapabilities('telegram').needsBun).toBe(true)
    expect(providerCapabilities('slack').needsBun).toBe(false)
  })
  it('its poller matcher sees the Gromzo plugin and nothing else', () => {
    expect(matchesProviderPollerCmd('node /h/.claude/plugins/cache/gromzo-local/gromzo-channel/0.1.0/dist/server.js', 'gromzo')).toBe(true)
    expect(matchesProviderPollerCmd('bun /h/.claude/plugins/cache/x/telegram/0.0.6/server.ts', 'gromzo')).toBe(false)
  })
  it('a direct send throws (the owner is reached through the main agent), never a silent success', async () => {
    await expect(getProvider('gromzo').sendMessage('', '', 'x')).rejects.toThrow(/no direct dashboard send/)
  })
})

describe('mainGromzoPrimaryReady (the TS twin of main_gromzo_primary_ready)', () => {
  it('socket usable AND the main agent\'s token file present, readable, not empty; anything less is pending', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { mainGromzoPrimaryReady } = await import('../web/main-gromzo-launch.js')
    const dir = mkdtempSync(join(tmpdir(), 'gz-ready-'))
    const sock = join(dir, 'agent.sock')
    // GROMZOPLUGREG1109: an explicit, registered plugins file (never the host's own ~/.claude); its absence: gromzo-plugin-registered.test.ts
    const pf = join(dir, 'installed_plugins.json')
    writeFileSync(pf, JSON.stringify({ version: 2, plugins: { 'gromzo-channel@gromzo-local': [{}] } }))
    const ready = (slug: string, s: string) => mainGromzoPrimaryReady(slug, s, pf)
    expect(ready('marveen', sock)).toBe(false) // no socket
    writeFileSync(sock, '')
    expect(ready('marveen', sock)).toBe(false) // socket, no tokens dir
    mkdirSync(join(dir, 'tokens'))
    expect(ready('marveen', sock)).toBe(false) // no token file (not enrolled / held)
    writeFileSync(join(dir, 'tokens', 'marveen.token'), '')
    expect(ready('marveen', sock)).toBe(false) // empty token
    writeFileSync(join(dir, 'tokens', 'marveen.token'), 'tok')
    expect(ready('marveen', sock)).toBe(true)
    expect(ready('Bad Slug!', sock)).toBe(false) // fails mxd's slug rule
  })
  it('the dashboard sweep leaves a gromzo-pending main session alone (no down spell, no restart); only a live one flushes the kept alerts', () => {
    const cm = readFileSync(join(ROOT, 'src', 'web', 'channel-monitor.ts'), 'utf8')
    expect(cm).toMatch(/if \(t\.isMarveen && t\.provider === 'gromzo' && !mainGromzoPrimaryReady\(readMainAgentIdRaw\(\)\)\) \{\n[^\n]*\n\s+setGromzoMainLive\(false\)\n\s+continue\n\s+\}\n\s+\/\/ CHANNELUNCONF1110/)
    // CHANNELUNCONF1110: the unconfigured skip sits between it and the probe (ordering: channel-unconfigured.test.ts).
  })
})

describe('sub-agents never carry the main agent\'s Gromzo channel (Dani 73584 (1))', () => {
  it('decided on the RESOLVED provider: no own value, an own gromzo or an unaccepted own value on a gromzo install -> no channel', async () => {
    const { subAgentMayUseProvider, pickAgentProvider } = await import('../web/agent-process.js')
    const may = (own: string | null, install: Parameters<typeof pickAgentProvider>[1]) => subAgentMayUseProvider(pickAgentProvider(own, install))
    expect(may(null, 'gromzo')).toBe(false)
    expect(may('gromzo', 'gromzo')).toBe(false)
    expect(may('xyz', 'gromzo')).toBe(false)
    expect(may('whatsapp', 'gromzo')).toBe(false)
    expect(pickAgentProvider('gromzo', 'telegram')).toBe('telegram')
    // an accepted own provider, or another install, as before
    expect(may('telegram', 'gromzo')).toBe(true)
    expect(may('slack', 'gromzo')).toBe(true)
    expect(may(null, 'telegram')).toBe(true)
    expect(may(null, 'slack')).toBe(true)
    expect(subAgentMayUseProvider('gromzo')).toBe(false)
  })
  it('agentHasChannel asks it first (so the launch gate, scoping and the monitor all read "no channel")', () => {
    const ap = readFileSync(join(ROOT, 'src', 'web', 'agent-process.ts'), 'utf8')
    expect(ap).toMatch(/export function agentHasChannel\(name: string\): boolean \{\n  const agentProvider = resolveAgentProvider\(name\)\n  if \(!subAgentMayUseProvider\(agentProvider\)\) return false\n/)
  })
  it('startAgentProcess has its own guard before hasChannel: a disallowed provider reads no token at all', () => {
    const ap = readFileSync(join(ROOT, 'src', 'web', 'agent-process.ts'), 'utf8')
    const start = ap.slice(ap.indexOf('export async function startAgentProcess('))
    expect(start).toMatch(/const providerAllowed = subAgentMayUseProvider\(agentProvider\)\n  const token = providerAllowed \? readChannelToken\(agentProvider, join\(agentChannelDir, '\.env'\)\) : null\n[^\n]*\n  let hasChannel = !!token\n/)
    // the legacy Telegram fallback is reachable only through an allowed provider (telegram is never 'none')
    expect(start.indexOf('const providerAllowed')).toBeLessThan(start.indexOf('let hasChannel'))
    expect(ap).toMatch(/export function resolveAgentProvider\(name: string\): ChannelProviderType \{\n  return pickAgentProvider\(readAgentChannelProvider\(name\), CHANNEL_PROVIDER\)\n\}/)
  })
})
