// CHANNELUNCONF1110 (GROMZONOPROVIDER1108 / Samu 75055, 75584): a token provider (telegram, discord, slack, teams)
// with no token runs the main session WITHOUT its primary channel instead of restarting it forever. The REAL scripts
// are sliced and run against fixture install dirs: the shared rule (shell and TS twins on the same fixtures),
// channels.sh's start block, its watchdog branch and its exit tail, channel-watchdog.sh, stuck-modal-guard.sh's
// respawn and verify-channels-health.sh. Plus the TS respawn builder, the monitor's skip, the marker reader and the
// dashboard banner wiring.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'
import {
  mainChannelUnconfigured,
  mainSessionRunsUnconfigured,
  readMainChannelUnconfiguredMarker,
  MAIN_CHANNEL_TOKEN_KEYS,
} from '../web/main-channel-configured.js'

const ROOT = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const HELPER = join(ROOT, 'scripts', 'main-channel-configured.sh')
const CHANNELS = read('scripts/channels.sh')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a + from.length)
  if (a < 0 || b < 0) throw new Error(`slice not found: ${from}`)
  return src.slice(a, b)
}
const bash = (script: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } })

let tmp = ''
let install = ''
let home = ''
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'chanunconf-'))
  install = join(tmp, 'install')
  home = join(tmp, 'home')
  mkdirSync(join(install, 'scripts'), { recursive: true })
  mkdirSync(join(install, 'store'), { recursive: true })
  mkdirSync(home, { recursive: true })
  copyFileSync(HELPER, join(install, 'scripts', 'main-channel-configured.sh'))
})
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

const writeEnv = (base: string, provider: string, body: string) => {
  const dir = join(base, '.claude', 'channels', provider)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.env'), body)
}
const shellRule = (provider: string): boolean => {
  const r = bash(`. '${HELPER}'; main_channel_unconfigured '${provider}' '${install}' '${home}' && echo UNCONF || echo CONF`)
  expect(r.status).toBe(0)
  return r.stdout.trim() === 'UNCONF'
}
const tsRule = (provider: string): boolean => mainChannelUnconfigured(provider, { installRoot: install, home })

describe('the rule: shell and TS twins agree on the same fixture dirs', () => {
  type Case = { name: string; provider: string; scoped?: string; legacy?: string; unconfigured: boolean }
  const cases: Case[] = [
    { name: 'telegram, no .env at all (the Bridge default)', provider: 'telegram', unconfigured: true },
    { name: 'telegram, a token', provider: 'telegram', scoped: 'TELEGRAM_BOT_TOKEN=123:abc\n', unconfigured: false },
    { name: 'telegram, an empty value', provider: 'telegram', scoped: 'TELEGRAM_BOT_TOKEN=\n', unconfigured: true },
    { name: 'telegram, a blank value', provider: 'telegram', scoped: 'TELEGRAM_BOT_TOKEN=   \n', unconfigured: true },
    { name: 'telegram, a CR-only value', provider: 'telegram', scoped: 'TELEGRAM_BOT_TOKEN=\r\n', unconfigured: true },
    { name: 'telegram, commented out', provider: 'telegram', scoped: '# TELEGRAM_BOT_TOKEN=old\n', unconfigured: true },
    { name: 'telegram, only a prefixed key', provider: 'telegram', scoped: 'OLD_TELEGRAM_BOT_TOKEN=x\n', unconfigured: true },
    { name: 'telegram, indented token line', provider: 'telegram', scoped: '  TELEGRAM_BOT_TOKEN=1:a\n', unconfigured: false },
    // Dani #2691 K2: the FIRST candidate line decides, as readChannelToken's ^\s*KEY=(.+)$ takes it
    { name: 'telegram, a blank value above a real one: the first candidate decides', provider: 'telegram', scoped: 'TELEGRAM_BOT_TOKEN=   \nTELEGRAM_BOT_TOKEN=123:abc\n', unconfigured: true },
    { name: 'telegram, a real one above a blank one', provider: 'telegram', scoped: 'TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_BOT_TOKEN=   \n', unconfigured: false },
    { name: 'telegram, an empty KEY= above a real one: not a candidate', provider: 'telegram', scoped: 'TELEGRAM_BOT_TOKEN=\nTELEGRAM_BOT_TOKEN=123:abc\n', unconfigured: false },
    { name: 'telegram, a CR-only KEY= above a real one: not a candidate', provider: 'telegram', scoped: 'TELEGRAM_BOT_TOKEN=\r\nTELEGRAM_BOT_TOKEN=123:abc\n', unconfigured: false },
    { name: 'telegram, a CRLF token', provider: 'telegram', scoped: 'TELEGRAM_BOT_TOKEN=1:a\r\n', unconfigured: false },
    { name: 'telegram, legacy only, with a token', provider: 'telegram', legacy: 'TELEGRAM_BOT_TOKEN=1:a\n', unconfigured: false },
    { name: 'telegram, legacy token but a scoped .env without one', provider: 'telegram', scoped: 'X=1\n', legacy: 'TELEGRAM_BOT_TOKEN=1:a\n', unconfigured: true },
    { name: 'discord, a token', provider: 'discord', scoped: 'DISCORD_BOT_TOKEN=d\n', unconfigured: false },
    { name: 'discord, the wrong key', provider: 'discord', scoped: 'TELEGRAM_BOT_TOKEN=t\n', unconfigured: true },
    { name: 'slack, a bot token', provider: 'slack', scoped: 'SLACK_BOT_TOKEN=xoxb-1\nSLACK_APP_TOKEN=xapp-1\n', unconfigured: false },
    { name: 'slack, only the app token', provider: 'slack', scoped: 'SLACK_APP_TOKEN=xapp-1\n', unconfigured: true },
    { name: 'teams, the app id', provider: 'teams', scoped: 'TEAMS_BOT_APP_ID=1f0c2a9e\nTEAMS_BOT_TENANT_ID=t\n', unconfigured: false },
    { name: 'teams, nothing', provider: 'teams', unconfigured: true },
    { name: 'gromzo is never covered', provider: 'gromzo', unconfigured: false },
    { name: 'googlechat is never covered', provider: 'googlechat', unconfigured: false },
    { name: 'whatsapp is never covered', provider: 'whatsapp', unconfigured: false },
    { name: 'an empty provider is never covered', provider: '', unconfigured: false },
  ]
  for (const c of cases) {
    it(c.name, () => {
      if (c.scoped !== undefined) writeEnv(install, c.provider, c.scoped)
      if (c.legacy !== undefined) writeEnv(home, c.provider, c.legacy)
      expect(shellRule(c.provider)).toBe(c.unconfigured)
      expect(tsRule(c.provider)).toBe(c.unconfigured)
    })
  }
  it('the key table is the same in both twins', () => {
    for (const [p, key] of Object.entries(MAIN_CHANNEL_TOKEN_KEYS)) {
      const r = bash(`. '${HELPER}'; main_channel_token_key '${p}'`)
      expect(r.stdout).toBe(key)
    }
    expect(bash(`. '${HELPER}'; main_channel_token_key gromzo`).status).toBe(1)
  })
  it('the shell twin never prints the token', () => {
    writeEnv(install, 'telegram', 'TELEGRAM_BOT_TOKEN=SECRET-TOKEN-VALUE\n')
    const r = bash(`set -x; . '${HELPER}'; main_channel_unconfigured telegram '${install}' '${home}'; echo rc=$?`)
    expect(r.stdout + r.stderr).not.toContain('SECRET-TOKEN-VALUE')
    expect(r.stdout).toContain('rc=1')
  })
})

describe('channels.sh start block: no token -> no primary channel, the marker, one line', () => {
  const START = between(CHANNELS, 'CHANNEL_UNCONFIGURED=0\n', '# SLACKDMVESZT1006:')
  const run = (provider: string, pluginId: string, extra = '') => bash([
    `INSTALL_DIR='${install}' HOME='${home}' CHANNEL_PROVIDER='${provider}' PLUGIN_ID='${pluginId}'`,
    `CHANNEL_PLUGINS_EXTRA='${extra}'`,
    START,
    'printf "UNCONF=%s\\nPLUGIN=%s\\nARG=%s\\n" "$CHANNEL_UNCONFIGURED" "$PLUGIN_ID" "$CHANNELS_ARG"',
  ].join('\n'))
  const marker = () => join(install, 'store', '.channel-unconfigured')

  it('telegram without a token: no --channels at all, the marker holds the provider, the reason said once', () => {
    const r = run('telegram', 'telegram@claude-plugins-official')
    expect(r.stdout).toBe('UNCONF=1\nPLUGIN=\nARG=\n')
    expect(readFileSync(marker(), 'utf8')).toBe('telegram\n')
    expect(r.stderr.match(/no telegram channel configured \(no TELEGRAM_BOT_TOKEN in its \.env\)/g)?.length).toBe(1)
  })
  it('without a token but with a co-listen extra: only the extra', () => {
    const r = run('slack', 'slack-channel@marveen-marketplace', 'discord@claude-plugins-official')
    expect(r.stdout).toContain('ARG=--channels plugin:discord@claude-plugins-official\n')
  })
  it('with a token: the launch as before (the primary first, then the extras), the marker removed', () => {
    writeFileSync(marker(), 'telegram\n')
    writeEnv(install, 'telegram', 'TELEGRAM_BOT_TOKEN=1:a\n')
    const r = run('telegram', 'telegram@claude-plugins-official', 'slack-channel@marveen-marketplace')
    expect(r.stdout).toBe('UNCONF=0\nPLUGIN=telegram@claude-plugins-official\nARG=--channels plugin:telegram@claude-plugins-official plugin:slack-channel@marveen-marketplace\n')
    expect(r.stderr).toBe('')
    expect(existsSync(marker())).toBe(false)
  })
  it('teams with its app id is configured (the Teams path of EE2392D3 keeps its channel)', () => {
    writeEnv(install, 'teams', 'TEAMS_BOT_APP_ID=1f0c\nTEAMS_BOT_APP_PASSWORD=x\nTEAMS_BOT_TENANT_ID=t\n')
    expect(run('teams', 'teams@marveen-marketplace').stdout).toContain('ARG=--channels plugin:teams@marveen-marketplace\n')
  })
  it('a provider the rule does not cover keeps its launch, without a token file', () => {
    expect(run('whatsapp', 'whatsapp@marveen-marketplace').stdout).toContain('ARG=--channels plugin:whatsapp@marveen-marketplace\n')
  })
  it('a half-updated tree (no helper) launches as before', () => {
    rmSync(join(install, 'scripts', 'main-channel-configured.sh'))
    expect(run('telegram', 'telegram@claude-plugins-official').stdout).toContain('ARG=--channels plugin:telegram@claude-plugins-official\n')
  })
  it('the block sits after the gromzo block and before the --channels build', () => {
    const a = CHANNELS.indexOf('GROMZO_PENDING=0\n')
    const b = CHANNELS.indexOf('CHANNEL_UNCONFIGURED=0\n')
    const c = CHANNELS.indexOf('if [ -n "$PLUGIN_ID" ]; then\n  CHANNELS_ARG=')
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })
  it('the post-init /mcp unlock leaves at once for an unconfigured session', () => {
    expect(CHANNELS).toMatch(/\[ "\$CHANNEL_PROVIDER" = "gromzo" \] && exit 0\n  # CHANNELUNCONF1110[^\n]*\n  \[ "\$CHANNEL_UNCONFIGURED" = "1" \] && exit 0\n  sleep 15/)
  })
})

describe('channels.sh watchdog: unconfigured spends no never-started budget, and restarts once when the token is set', () => {
  const BRANCH = between(CHANNELS, '  # CHANNELUNCONF1110: an unconfigured session has no primary plugin on purpose', '  _plugin_alive=false\n')
  // The branch sits in the real loop BEFORE the never-started deadline check; the harness keeps that order.
  const loop = (configuredAt: number) => bash([
    `main_channel_unconfigured() { [ "$NOW" -lt ${configuredAt} ]; }`,
    'respawn_log() { echo "LOG $*"; }',
    'CHANNEL_PROVIDER=telegram CHANNEL_UNCONFIGURED=1 CHANNEL_UNCONF_LAST_POLL=0 SESSION=marveen-channels',
    'PLUGIN_NEVER_STARTED_DEADLINE=600 EXIT_REASON=session-gone POLLS=0',
    'for NOW in $(seq 5 5 5000); do',
    BRANCH,
    '  if [ "$NOW" -ge "$PLUGIN_NEVER_STARTED_DEADLINE" ]; then EXIT_REASON=plugin-never-started; break; fi',
    'done',
    'echo "EXIT=$EXIT_REASON NOW=$NOW RESTART=${RESTART_REQUESTED:-0}"',
  ].join('\n'))

  it('no token for 4000 s (past the 2400 s cap): never "plugin-never-started"; the token -> one restart', () => {
    const r = loop(4000)
    expect(r.stdout).toMatch(/EXIT=channel-configured NOW=40\d\d RESTART=1/)
    expect(r.stdout.match(/LOG channel-configured:/g)?.length).toBe(1)
    expect(r.stderr).toContain('telegram channel configured -- restarting the session with it')
  })
  it('never configured: the loop runs out without a restart', () => {
    const r = loop(999999)
    expect(r.stdout).toContain('EXIT=session-gone NOW=5000 RESTART=0')
  })
  it('the token check runs every 60 s, not every 5 s tick', () => {
    const r = bash([
      'CALLS=0; main_channel_unconfigured() { CALLS=$((CALLS+1)); return 0; }',
      'respawn_log() { :; }',
      'CHANNEL_PROVIDER=telegram CHANNEL_UNCONFIGURED=1 CHANNEL_UNCONF_LAST_POLL=0',
      'for NOW in $(seq 5 5 600); do', BRANCH, 'done', 'echo "CALLS=$CALLS"',
    ].join('\n'))
    expect(r.stdout).toContain('CALLS=10')
  })
})

describe('channels.sh exit tail: "channel-configured" is a planned restart (exit 0, never a rapid failure)', () => {
  const TAIL = CHANNELS.slice(CHANNELS.indexOf('ELAPSED=$(( $(date +%s) - START_TS ))'))
  const run = (reason: string, restart: string) => bash([
    `INSTALL_DIR='${install}' START_TS=$(date +%s) EXIT_REASON='${reason}' RESTART_REQUESTED='${restart}' PANE_EXIT_STATUS=''`,
    'rapid_exit_log_line() { echo "rapid-exit after ${1}s reason=$2"; }',
    TAIL,
  ].join('\n'))
  const failures = () => join(install, 'store', 'channels-failures.log')

  it('channel-configured after 0 s: exit 0, no rapid-exit line', () => {
    const r = run('channel-configured', '1')
    expect(r.status).toBe(0)
    expect(existsSync(failures()) ? readFileSync(failures(), 'utf8') : '').not.toContain('rapid-exit')
  })
  it('control: plugin-never-started after 0 s is still a rapid failure, exit 1', () => {
    const r = run('plugin-never-started', '1')
    expect(r.status).toBe(1)
    expect(readFileSync(failures(), 'utf8')).toContain('rapid-exit after')
  })
})

describe('channel-watchdog.sh: no primary and no STALE respawn for an unconfigured channel', () => {
  const CW = read('scripts/channel-watchdog.sh')
  const BLOCK = between(CW, '# CHANNELUNCONF1110: a token provider with no token runs WITHOUT its primary channel', 'EXTRA_CHANNELS=""')
  const run = () => bash([
    'set -u',
    `INSTALL_DIR='${install}' HOME='${home}' CHANNEL_PROVIDER=telegram PRIMARY_PLUGIN_ID=telegram@claude-plugins-official`,
    BLOCK,
    'echo "UNCONF=$CHANNEL_UNCONFIGURED PRIMARY=$PRIMARY_PLUGIN_ID"',
  ].join('\n'))
  it('no token: no primary', () => {
    expect(run().stdout).toBe('UNCONF=1 PRIMARY=\n')
  })
  it('a token: the primary as before', () => {
    writeEnv(install, 'telegram', 'TELEGRAM_BOT_TOKEN=1:a\n')
    expect(run().stdout).toBe('UNCONF=0 PRIMARY=telegram@claude-plugins-official\n')
  })
  it('STALE is cleared for it after the keepalive age check and before the act/no-act gate; AUTHDEAD is untouched', () => {
    const stale = CW.indexOf('[ "$age" -ge "$STALE_SECONDS" ] && STALE=true')
    const clear = CW.indexOf('[ "$CHANNEL_UNCONFIGURED" = "1" ] && STALE=false')
    const gate = CW.indexOf('if [ "$STALE" != true ] && [ "$AUTHDEAD" != true ]; then')
    expect(stale).toBeGreaterThan(0)
    expect(clear).toBeGreaterThan(stale)
    expect(gate).toBeGreaterThan(clear)
    expect(CW).not.toMatch(/CHANNEL_UNCONFIGURED[^\n]*AUTHDEAD=false/)
  })
})

describe('stuck-modal-guard.sh respawn: no primary for an unconfigured channel, extras kept', () => {
  const SMG = read('scripts/stuck-modal-guard.sh')
  const BLOCK = between(SMG, '  local _primary_id="${RESPAWN_PLUGIN#plugin:}"\n', '  unset _extra_done\n')
  const run = (respawnPlugin: string, extra: string) => bash([
    'f() {',
    `  local INSTALL_DIR='${install}' EXTRA_Q="" CHAN_ARG="" _p _extra='${extra}'`,
    `  local RESPAWN_PLUGIN='${respawnPlugin}' PLUGIN_Q`,
    '  PLUGIN_Q="$(printf \'%q\' "$RESPAWN_PLUGIN")"',
    BLOCK,
    '  echo "ARG=$CHAN_ARG PRIMARY=$_primary_id"',
    '}',
    `HOME='${home}' SMG_PROVIDER=telegram SMG_DEFAULT_PLUGIN=plugin:telegram@claude-plugins-official f`,
  ].join('\n'))
  it('no token: no primary, no --channels', () => {
    expect(run('plugin:telegram@claude-plugins-official', '').stdout).toBe('ARG= PRIMARY=\n')
  })
  it('no token with an extra: only the extra', () => {
    expect(run('plugin:telegram@claude-plugins-official', 'discord@claude-plugins-official').stdout)
      .toBe('ARG=--channels plugin:discord@claude-plugins-official PRIMARY=\n')
  })
  it('a token: the respawn as before', () => {
    writeEnv(install, 'telegram', 'TELEGRAM_BOT_TOKEN=1:a\n')
    expect(run('plugin:telegram@claude-plugins-official', '').stdout)
      .toBe('ARG=--channels plugin:telegram@claude-plugins-official PRIMARY=telegram@claude-plugins-official\n')
  })
  it('an explicit STUCK_MODAL_PLUGIN override keeps its launch', () => {
    expect(run('plugin:slack-channel@marveen-marketplace', '').stdout)
      .toBe('ARG=--channels plugin:slack-channel@marveen-marketplace PRIMARY=slack-channel@marveen-marketplace\n')
  })
  it('the settings file enables the same primary the --channels list carries', () => {
    expect(SMG).toContain('SETTINGS_FLAG="$(main_extra_settings_flag "$INSTALL_DIR" "$_primary_id" $_extra)"')
  })
})

describe('verify-channels-health.sh: an unconfigured channel is said as such, healthy', () => {
  const VCH = read('scripts/verify-channels-health.sh')
  const BLOCK = between(VCH, '# CHANNELUNCONF1110: a token provider with no token runs WITHOUT its primary channel by design', 'unset _vch_provider')
  const run = (provider: string) => bash([
    'note() { echo "  $1"; }',
    `INSTALL_DIR='${install}' HOME='${home}' _vch_provider='${provider}'`,
    BLOCK,
    'echo FELL-THROUGH',
  ].join('\n'))
  it('no token: the NOT CONFIGURED note and HEALTHY, exit 0', () => {
    const r = run('telegram')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('(channel) NOT CONFIGURED: no telegram token (TELEGRAM_BOT_TOKEN)')
    expect(r.stdout).toContain('verify-channels-health: HEALTHY (no channel configured)')
    expect(r.stdout).not.toContain('FELL-THROUGH')
  })
  it('a token: the usual checks run', () => {
    writeEnv(install, 'telegram', 'TELEGRAM_BOT_TOKEN=1:a\n')
    expect(run('telegram').stdout).toBe('FELL-THROUGH\n')
  })
})

describe('the TS respawn builder and the monitor', () => {
  const base = {
    claudePath: '/c/claude',
    channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/x' },
    config: {} as never,
    model: '',
    continueSession: false,
    mainAgentId: 'marveen',
    pluginId: 'telegram@claude-plugins-official',
  }
  it('unconfigured: no --channels at all', () => {
    expect(buildMainSessionRespawnCmd({ ...base, channelConfigured: false })).not.toContain('--channels')
  })
  it('unconfigured with an extra: only the extra', () => {
    const cmd = buildMainSessionRespawnCmd({ ...base, channelConfigured: false, extraPluginIds: ['discord@claude-plugins-official'] })
    expect(cmd).toContain('--channels plugin:discord@claude-plugins-official')
    expect(cmd).not.toContain('plugin:telegram@')
  })
  it('configured or absent: the respawn as before', () => {
    const before = buildMainSessionRespawnCmd({ ...base, extraPluginIds: ['slack-channel@marveen-marketplace'] })
    expect(before).toContain('--channels plugin:telegram@claude-plugins-official plugin:slack-channel@marveen-marketplace')
    expect(buildMainSessionRespawnCmd({ ...base, channelConfigured: true, extraPluginIds: ['slack-channel@marveen-marketplace'] })).toBe(before)
  })
  it('every production respawn passes the rule, and its settings file drops the primary with it', () => {
    const cm = read('src/web/channel-monitor.ts')
    expect(cm.match(/channelConfigured: mainPrimaryConfigured\(provider\.type\),/g)?.length).toBe(3)
    expect(cm.match(/writeMainExtraPluginsSettings\(PROJECT_ROOT, mainLaunchPluginIds\(provider\)\)/g)?.length).toBe(3)
    expect(cm).not.toContain('writeMainExtraPluginsSettings(PROJECT_ROOT, [provider.pluginId,')
  })
  it('the monitor skips the main liveness action on the marker, before the probe and the down ladder', () => {
    const cm = read('src/web/channel-monitor.ts')
    const skip = cm.indexOf('if (t.isMarveen && mainSessionRunsUnconfigured(t.provider)) {')
    const probe = cm.indexOf('const liveness = await probeChannelPluginLivenessAsync(')
    const ladder = cm.indexOf('if (shouldEscalateMarveenDown()) await handleMarveenDown()')
    expect(skip).toBeGreaterThan(0)
    expect(probe).toBeGreaterThan(skip)
    expect(ladder).toBeGreaterThan(probe)
  })
})

describe('the monitor asks the marker AND the rule (Dani #2691 K1)', () => {
  const marker = () => join(install, 'store', '.channel-unconfigured')
  const runs = () => mainSessionRunsUnconfigured('telegram', { markerPath: marker(), installRoot: install, home })
  it('the marker and no token: unconfigured (no liveness action)', () => {
    writeFileSync(marker(), 'telegram\n')
    expect(runs()).toBe(true)
  })
  it('a false or stale marker while the token is there: NOT unconfigured, the liveness action runs', () => {
    writeFileSync(marker(), 'telegram\n')
    writeEnv(install, 'telegram', 'TELEGRAM_BOT_TOKEN=1:a\n')
    expect(runs()).toBe(false)
  })
  it('no marker (an older channels.sh launched it): NOT unconfigured, as before', () => {
    expect(runs()).toBe(false)
  })
  it('a marker for another provider: NOT unconfigured', () => {
    writeFileSync(marker(), 'slack\n')
    expect(runs()).toBe(false)
  })
})

describe('the marker reader', () => {
  const marker = () => join(install, 'store', '.channel-unconfigured')
  it('the provider channels.sh wrote', () => {
    writeFileSync(marker(), 'telegram\n')
    expect(readMainChannelUnconfiguredMarker(marker())).toBe('telegram')
  })
  it('absent, empty or a provider the rule does not cover: null', () => {
    expect(readMainChannelUnconfiguredMarker(marker())).toBeNull()
    writeFileSync(marker(), '')
    expect(readMainChannelUnconfiguredMarker(marker())).toBeNull()
    writeFileSync(marker(), 'gromzo\n')
    expect(readMainChannelUnconfiguredMarker(marker())).toBeNull()
  })
})

describe('the dashboard says it', () => {
  const hu = read('web/lang/hu.js')
  const en = read('web/lang/en.js')
  const app = read('web/app.js')
  const html = read('web/index.html')
  it('HU and EN strings exist, the HU with its accents, neither with a dash', () => {
    for (const key of ['main_channel.unconfigured.banner', 'main_channel.unconfigured.action', 'agents.channel.not_configured']) {
      expect(hu).toContain(`'${key}':`)
      expect(en).toContain(`'${key}':`)
    }
    const huBanner = hu.match(/'main_channel\.unconfigured\.banner': '([^']*)'/)?.[1] ?? ''
    expect(huBanner).toContain('Nincs beállított csatorna')
    expect(huBanner).toContain('{provider}')
    expect(huBanner + (en.match(/'main_channel\.unconfigured\.banner': '([^']*)'/)?.[1] ?? '')).not.toMatch(/[\u2013\u2014]/)
  })
  it('/api/marveen carries the field; the banner is drawn from it and points to the main agent Channel tab', () => {
    expect(read('src/web/routes/marveen.ts')).toContain('mainChannelUnconfigured: mainChannelUnconfigured(CHANNEL_PROVIDER) ? CHANNEL_PROVIDER : null,')
    expect(html).toContain('id="mainChannelUnconfBanner"')
    expect(app).toContain("await openAgentDetail(mainAgentId())\n    switchAgentTab('channel')")
    expect(app.match(/updateMainChannelUnconfBanner\((data|window\._marveen)\)/g)?.length).toBe(2)
  })
  it('the banner render, run: shown with the provider label for an unconfigured main channel, hidden otherwise', () => {
    const src = app.slice(app.indexOf('const MAIN_CHANNEL_PROVIDER_LABELS = '), app.indexOf('async function refreshMainChannelUnconfBanner'))
    const els: Record<string, { hidden: boolean; textContent: string }> = {
      mainChannelUnconfBanner: { hidden: true, textContent: '' },
      mainChannelUnconfBannerText: { hidden: false, textContent: '' },
    }
    const document = { getElementById: (id: string) => els[id] ?? null }
    const t = (key: string, vars: Record<string, string>) => `${key}|${vars.provider}`
    const update = new Function('document', 't', `${src}\nreturn updateMainChannelUnconfBanner`)(document, t) as (m: unknown) => void
    update({ mainChannelUnconfigured: 'teams' })
    expect(els.mainChannelUnconfBanner.hidden).toBe(false)
    expect(els.mainChannelUnconfBannerText.textContent).toBe('main_channel.unconfigured.banner|Microsoft Teams')
    update({ mainChannelUnconfigured: null })
    expect(els.mainChannelUnconfBanner.hidden).toBe(true)
    update({ mainChannelUnconfigured: 'telegram' })
    expect(els.mainChannelUnconfBanner.hidden).toBe(false)
    update(null)
    expect(els.mainChannelUnconfBanner.hidden).toBe(true)
  })
  it('the banner button, run: fetches /api/marveen BEFORE opening the main detail (an empty window._marveen opened nothing)', async () => {
    const src = app.slice(app.indexOf('function wireMainChannelUnconfBanner() {'), app.indexOf('// === Update-conflict guard (UPDATECONFLICT1105) ==='))
    const calls: string[] = []
    let handler: (() => Promise<void>) | null = null
    const win: { _marveen?: unknown } = {}
    const document = { getElementById: () => ({ addEventListener: (_e: string, h: () => Promise<void>) => { handler = h } }) }
    const deps = {
      refreshMainChannelUnconfBanner: async () => { calls.push(`refresh(empty=${win._marveen === undefined})`); win._marveen = { name: 'Marveen' } },
      openAgentDetail: async (n: string) => { calls.push(`open(${n}, loaded=${win._marveen !== undefined})`) },
      switchAgentTab: (t: string) => { calls.push(`tab(${t})`) },
      mainAgentId: () => 'marveen',
    }
    const wire = new Function('document', 'window', ...Object.keys(deps), `${src}\nreturn wireMainChannelUnconfBanner`)(document, win, ...Object.values(deps)) as () => void
    wire()
    await handler!()
    expect(calls).toEqual(['refresh(empty=true)', 'open(marveen, loaded=true)', 'tab(channel)'])
  })
  it('the main agent detail no longer says "connected" without a token', () => {
    expect(app).toContain("m.mainChannelUnconfigured\n    ? `<span class=\"tg-status\"><span class=\"tg-dot\"></span>${t('agents.channel.not_configured')}</span>`")
  })
})
