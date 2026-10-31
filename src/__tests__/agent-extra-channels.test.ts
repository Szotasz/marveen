// AGENTEXTRACH1006: a sub-agent co-listens on a second provider (e.g. Telegram
// primary + Slack extra), the way the main agent does with CHANNEL_PLUGINS_EXTRA.
//
// Three layers are pinned here, because each one alone has silenced a second bot
// before:
//  1. the pure decision (which extras take part, what they add to the launch);
//  2. the isolated config dir, executed against a sandbox: the scope step forces
//     every non-primary channel plugin to false, and the 2026-08-16 Discord
//     co-listen outage was exactly that rewrite killing the second bot on every
//     restart;
//  3. the launcher's binding: --channels, the state-dir export, enabledPlugins,
//     the isolation provisioner and the resume decision all receive the extras.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let SANDBOX = ''
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(SANDBOX, 'agents', name) }
})

const { parseExtraChannels, buildExtraChannelLaunch, enableExtraPlugins, wantsGromzo, mxdAgentSockUsable, GROMZO_PLUGIN_ID } = await import('../web/agent-extra-channels.js')
const { ensureIsolatedChannelConfigDir, scopeChannelPlugins, CHANNEL_PLUGIN_IDS } = await import('../web/agent-process.js')
const { decideContinueFlag } = await import('../web/channel-continue-policy.js')
const { pluginInTree, combineLiveness } = await import('../web/extra-channel-liveness.js')

const TG = CHANNEL_PLUGIN_IDS.telegram
const SL = CHANNEL_PLUGIN_IDS.slack
const DI = CHANNEL_PLUGIN_IDS.discord
const AGENT = '/install/agents/demo'

describe('parseExtraChannels', () => {
  it('keeps known providers in order, without duplicates', () => {
    expect(parseExtraChannels(['slack', 'discord', 'slack'], 'telegram')).toEqual(['slack', 'discord'])
  })
  it('drops the primary provider: the same plugin twice on --channels is not a co-listen', () => {
    expect(parseExtraChannels(['telegram', 'slack'], 'telegram')).toEqual(['slack'])
  })
  it('drops unknown values and non-strings rather than passing them to the launch', () => {
    expect(parseExtraChannels(['slack', 'irc', 42, null, ' discord '], 'telegram')).toEqual(['slack', 'discord'])
  })
  it('anything that is not an array means no extras (absent field = launch unchanged)', () => {
    for (const raw of [undefined, null, 'slack', { slack: true }]) expect(parseExtraChannels(raw, 'telegram')).toEqual([])
  })
})

describe('buildExtraChannelLaunch', () => {
  const tokenFor = (...withToken: string[]) => (p: string) => withToken.includes(p)

  it('a tokened slack extra adds its plugin to --channels and exports its OWN state dir', () => {
    const l = buildExtraChannelLaunch(['slack'], 'telegram', AGENT, tokenFor('slack'))
    expect(l.providers).toEqual(['slack'])
    expect(l.pluginIds).toEqual([SL])
    expect(l.channelArgs).toBe(` plugin:${SL}`)
    expect(l.envExports).toBe(
      `export SLACK_STATE_DIR="${AGENT}/.claude/channels/slack" && export SLACK_AUDIT_LOG="${AGENT}/.claude/channels/slack/audit.jsonl" && `,
    )
    // The primary's state dir is never named by the extras.
    expect(l.envExports).not.toContain('TELEGRAM_STATE_DIR')
  })

  it('an extra WITHOUT a token in its own state dir is skipped, contributing nothing', () => {
    const l = buildExtraChannelLaunch(['slack', 'discord'], 'telegram', AGENT, tokenFor('discord'))
    expect(l.providers).toEqual(['discord'])
    expect(l.skipped).toEqual(['slack'])
    expect(l.channelArgs).toBe(` plugin:${DI}`)
    expect(l.envExports).not.toContain('SLACK_STATE_DIR')
  })

  it('an extra equal to the primary is ignored', () => {
    const l = buildExtraChannelLaunch(['telegram'], 'telegram', AGENT, () => true)
    expect(l).toEqual({ gromzo: 'off', providers: [], skipped: [], pluginIds: [], channelArgs: '', envExports: '' })
  })

  it('no extras -> every launch piece is empty (the launch is byte-identical to before)', () => {
    expect(buildExtraChannelLaunch([], 'telegram', AGENT, () => true))
      .toEqual({ gromzo: 'off', providers: [], skipped: [], pluginIds: [], channelArgs: '', envExports: '' })
  })
})

describe('GROMZOAGENTS1028: the Gromzo channel rides the extra-channel launch', () => {
  const none = () => false
  it('on: the plugin id, its --channels arg, and MXD_AGENT/MXD_SCOPE, never a provider', () => {
    const l = buildExtraChannelLaunch([], 'slack', AGENT, none, { slug: 'samu', sockUsable: true, senderRoleGate: true })
    expect(l.gromzo).toBe('on')
    expect(l.providers).toEqual([])
    expect(l.pluginIds).toEqual([GROMZO_PLUGIN_ID])
    expect(l.channelArgs).toBe(` plugin:${GROMZO_PLUGIN_ID}`)
    expect(l.envExports).toBe('export MXD_AGENT="samu" && export MXD_SCOPE="both" && ')
    expect(GROMZO_PLUGIN_ID).toBe('gromzo-channel@gromzo-local')
  })
  it('the team (both) only with a sender-role gate; without one, owner DM only (fail-closed, #2375 review)', () => {
    const gated = buildExtraChannelLaunch([], 'slack', AGENT, none, { slug: 'samu', sockUsable: true, senderRoleGate: true })
    expect(gated.gromzoScope).toBe('both')
    const open = buildExtraChannelLaunch([], 'slack', AGENT, none, { slug: 'samu', sockUsable: true, senderRoleGate: false })
    expect(open.gromzo).toBe('on')
    expect(open.gromzoScope).toBe('owner')
    expect(open.envExports).toBe('export MXD_AGENT="samu" && export MXD_SCOPE="owner" && ')
  })
  it('next to a tokened slack extra: both, slack first', () => {
    const l = buildExtraChannelLaunch(['slack'], 'telegram', AGENT, () => true, { slug: 'zara', sockUsable: true, senderRoleGate: true })
    expect(l.providers).toEqual(['slack'])
    expect(l.pluginIds).toEqual([SL, GROMZO_PLUGIN_ID])
    expect(l.envExports).toContain('export SLACK_STATE_DIR=')
    expect(l.envExports.endsWith('export MXD_AGENT="zara" && export MXD_SCOPE="both" && ')).toBe(true)
  })
  it('no usable agent.sock: skipped, contributing nothing (fail-safe, like a tokenless extra)', () => {
    const l = buildExtraChannelLaunch([], 'slack', AGENT, none, { slug: 'samu', sockUsable: false, senderRoleGate: true })
    expect(l).toMatchObject({ gromzo: 'skipped-no-socket', pluginIds: [], channelArgs: '', envExports: '' })
  })
  it('a name mxd would refuse never reaches the shell export', () => {
    for (const slug of ['Samu', 'sa mu', 'x"; rm -rf ~; "', '', 'a'.repeat(33), 'samu$(id)']) {
      const l = buildExtraChannelLaunch([], 'slack', AGENT, none, { slug, sockUsable: true, senderRoleGate: true })
      expect(l).toMatchObject({ gromzo: 'skipped-bad-name', pluginIds: [], envExports: '' })
    }
  })
  it('not asked for: off, and the launch is byte-identical to before', () => {
    const l = buildExtraChannelLaunch([], 'slack', AGENT, none)
    expect(l).toEqual({ gromzo: 'off', providers: [], skipped: [], pluginIds: [], channelArgs: '', envExports: '' })
  })
  it('only a real true opts in', () => {
    expect(wantsGromzo(true)).toBe(true)
    for (const v of ['true', 1, 'yes', {}, null, undefined, false]) expect(wantsGromzo(v)).toBe(false)
  })
  it('the socket check: a path this user can read and write passes, a missing one does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mxdsock-'))
    try {
      const f = join(dir, 'agent.sock')
      writeFileSync(f, '')
      expect(mxdAgentSockUsable(f)).toBe(true)
      expect(mxdAgentSockUsable(join(dir, 'nope.sock'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('enableExtraPlugins', () => {
  it('turns the extra back on after the primary-only scope forced it off', () => {
    const scoped = scopeChannelPlugins('telegram', { other: true })
    expect(scoped[SL]).toBe(false)
    const out = enableExtraPlugins(scoped, [SL])
    expect(out[TG]).toBe(true)
    expect(out[SL]).toBe(true)
    expect(out[DI]).toBe(false)
    expect(out.other).toBe(true)
  })
})

describe('resume with extras: kept only when every plugin comes back', () => {
  // The decision itself is unchanged by extras (Marveen 34770: an extra must
  // not cost the agent its context on every restart). What protects the resume
  // is the post-launch verification, which now covers the extras too.
  const base = {
    hasPriorSession: true, fresh: false, hasChannel: true, isMainAgent: false, provider: 'telegram',
    usesLaunchSecret: false, fleetTokenLaunch: true, useMcpJsonForChannel: false, installedCli: '9.9.9',
  }
  it('a measured telegram launch resumes', () => {
    expect(decideContinueFlag(base).useContinue).toBe(true)
  })
  it('telegram primary + slack extra resumes (Marveen 34770); the post-launch verify guards the extra', () => {
    expect(decideContinueFlag({ ...base, extraProviders: ['slack'] }).useContinue).toBe(true)
  })
  it('NO primary channel + slack extra: the gates are evaluated on the extra -> fresh, like a slack primary', () => {
    const d = decideContinueFlag({ ...base, hasChannel: false, extraProviders: ['slack'] })
    expect(d.useContinue).toBe(false)
    expect(d.reason).toContain("'slack'")
    expect(decideContinueFlag({ ...base, provider: 'slack' }).useContinue).toBe(false)
  })
  it('NO primary channel + telegram extra: the measured gates still apply (CLI floor, fleet token)', () => {
    expect(decideContinueFlag({ ...base, hasChannel: false, extraProviders: ['telegram'] }).useContinue).toBe(true)
    expect(decideContinueFlag({ ...base, hasChannel: false, extraProviders: ['telegram'], fleetTokenLaunch: false }).useContinue).toBe(false)
    expect(decideContinueFlag({ ...base, hasChannel: false, extraProviders: ['telegram'], installedCli: '0.0.1' }).useContinue).toBe(false)
  })
  it('a truly channel-less agent (no primary, no extras) still keeps its context', () => {
    expect(decideContinueFlag({ ...base, hasChannel: false }).useContinue).toBe(true)
  })

  const PS = [
    '  PID  PPID COMMAND',
    '  100     1 /opt/homebrew/bin/claude --channels plugin:telegram@x plugin:slack-channel@y',
    '  101   100 bun run --cwd /h/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 start',
    '  102   100 node /h/.claude/plugins/cache/marveen-marketplace/slack-channel/0.1.0/node_modules/.bin/tsx /h/.claude/plugins/cache/marveen-marketplace/slack-channel/0.1.0/server.ts',
    '  200     1 /opt/homebrew/bin/claude --channels plugin:telegram@x plugin:slack-channel@y',
    '  201   200 bun run --cwd /h/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 start',
  ].join('\n')

  it('pluginInTree finds the slack poller under ITS claude', () => {
    expect(pluginInTree(PS, 100, 'slack')).toBe(true)
  })
  it('pluginInTree does NOT count another session\'s slack poller (the main agent co-listens on Slack too)', () => {
    expect(pluginInTree(PS, 200, 'slack')).toBe(false)
    expect(pluginInTree(PS, 200, 'telegram')).toBe(true)
  })
  it('combineLiveness: all alive -> alive; any down -> down; else unknown', () => {
    expect(combineLiveness(['alive', 'alive'])).toBe('alive')
    expect(combineLiveness(['alive', 'down'])).toBe('down')
    expect(combineLiveness(['unknown', 'alive'])).toBe('unknown')
  })
})

describe('isolated config dir keeps the extra plugin enabled (executed)', () => {
  beforeEach(() => {
    SANDBOX = mkdtempSync(join(tmpdir(), 'extrach-'))
    const claude = join(SANDBOX, 'home', '.claude')
    mkdirSync(join(claude, 'plugins', 'cache'), { recursive: true })
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { [TG]: true } }))
    writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {} }))
    mkdirSync(join(SANDBOX, 'agents', 'demo'), { recursive: true })
  })
  afterEach(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

  it('telegram primary + slack extra: BOTH true, discord false', () => {
    const cfg = ensureIsolatedChannelConfigDir('demo', 'telegram', [SL])!
    const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
    expect(s.enabledPlugins[TG]).toBe(true)
    expect(s.enabledPlugins[SL]).toBe(true)
    expect(s.enabledPlugins[DI]).toBe(false)
  })

  it('GROMZOAGENTS1028: slack primary + gromzo: the gromzo plugin stays enabled next to slack', () => {
    const cfg = ensureIsolatedChannelConfigDir('demo', 'slack', [GROMZO_PLUGIN_ID])!
    const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
    expect(s.enabledPlugins[SL]).toBe(true)
    expect(s.enabledPlugins[GROMZO_PLUGIN_ID]).toBe(true)
  })

  it('without extras the slack plugin stays OFF (negative control: the scope step still works)', () => {
    const cfg = ensureIsolatedChannelConfigDir('demo', 'telegram')!
    const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
    expect(s.enabledPlugins[SL]).toBe(false)
  })
})

describe('launcher binding (agent-process.ts startAgentProcess)', () => {
  const SRC = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')
  const FN = SRC.slice(SRC.indexOf('export async function startAgentProcess('))

  it('reads the extras once, from agent-config, against the resolved primary', () => {
    expect(FN).toContain('const extraLaunch = buildExtraChannelLaunch(readAgentExtraChannels(name), agentProvider, dir, undefined,\n    readAgentGromzo(name)\n      ? { slug: name, sockUsable: mxdAgentSockUsable(), senderRoleGate: readAgentSenderRoleGateClosesTools(name) }\n      : undefined)')
  })
  it('#2375: the team scope is bound to the agent\'s own sender-role gate, and an owner-only launch is logged', () => {
    // GROMZOGATECONF1030: the team scope needs a gate that closes tools, not just one that exists.
    expect(FN).toContain('senderRoleGate: readAgentSenderRoleGateClosesTools(name)')
    expect(FN).toContain("if (extraLaunch.gromzo === 'on' && extraLaunch.gromzoScope === 'owner') {")
  })
  it('GROMZOAGENTS1028: a gromzo-only launch still counts as having a channel, and a skipped one is logged', () => {
    expect(FN).toContain("const hasExtraChannels = extraLaunch.providers.length > 0 || extraLaunch.gromzo === 'on'")
    expect(FN).toContain("if (extraLaunch.gromzo === 'skipped-no-socket' || extraLaunch.gromzo === 'skipped-bad-name') {")
  })
  it('the --channels list carries the primary AND the extras', () => {
    expect(FN).toContain('const channelList = (primaryChannel + extraLaunch.channelArgs).trim()')
    expect(FN).toContain('const channelFlag = channelList ? `--channels ${channelList}` : \'\'')
  })
  it('the extras\' state-dir exports reach the launch env', () => {
    expect(FN).toContain('+ extraLaunch.envExports')
    expect(FN).toMatch(/\$\{channelSetup\}/)
  })
  it('the agent settings.json keeps the extras enabled after the scope step', () => {
    const scopeAt = FN.indexOf('s.enabledPlugins = scopeChannelPlugins(')
    const extraAt = FN.indexOf('s.enabledPlugins = enableExtraPlugins(s.enabledPlugins as Record<string, boolean>, extraLaunch.pluginIds)')
    expect(scopeAt).toBeGreaterThan(-1)
    // AFTER the scope step, or the scope would switch the extras off again.
    expect(extraAt).toBeGreaterThan(scopeAt)
    expect(FN.slice(extraAt, extraAt + 400)).toContain('writeFileSync(settingsPath')
  })
  it('every isolation provisioner call passes the extras', () => {
    const calls = FN.match(/ensureIsolatedChannelConfigDir\([^)]*\)/g) ?? []
    expect(calls.length).toBe(3)
    for (const c of calls) expect(c).toContain('extraLaunch.pluginIds')
  })
  it('a resumed launch with extras is verified, primary AND extras, with the fresh fallback', () => {
    const at = FN.indexOf('if (continueFlag && hasAnyChannel && name !== MAIN_AGENT_ID) {')
    expect(at).toBeGreaterThan(-1)
    const block = FN.slice(at, at + 1800)
    expect(block).toContain('probeExtraPluginsInTree(pid, extraLaunch.providers)')
    expect(block).toContain("hasChannel ? probeChannelPluginLiveness(pid, agentProvider, name) : 'alive'")
    expect(block).toContain('startAgentProcess(name, { fresh: true })')
  })
  it('the extras\' orphan pollers are reaped on STOP too (a stopped agent must not keep a socket)', () => {
    const stopAt = SRC.indexOf("'post-stop channel-poller reap failed'")
    const block = SRC.slice(stopAt - 600, stopAt)
    expect(block).toMatch(/for \(const p of readAgentExtraChannels\(name\)\) \{\n\s+if \(p !== agentProvider\) reapChannelOrphans\(p, dir, \{ tmuxPath: tmuxBin\(\) \}\)/)
  })
  it('the #1711 state fence leaves the extras\' real state dirs alone', () => {
    expect(FN).toContain('const stateFence = buildChannelStateFence([...(hasChannel ? [agentProvider] : []), ...extraLaunch.providers], dir)')
  })
  it('the resume decision is told about the extras (gates when there is no primary channel)', () => {
    expect(FN).toContain('extraProviders: extraLaunch.providers')
  })
  it('the extras\' orphan pollers are reaped before launch', () => {
    expect(FN).toContain('for (const p of extraLaunch.providers) reapChannelOrphans(p, dir, { tmuxPath: tmuxBin() })')
  })
})

describe('channel setup route binding (routes/agents.ts)', () => {
  const SRC = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf-8')

  it('extra:true appends to extraChannels and does NOT rewrite the primary channel', () => {
    const branch = SRC.match(/if \(asExtra\) \{\n\s+writeAgentExtraChannels\(name, \[\.\.\.readAgentExtraChannels\(name\), provider\]\)\n\s+\} else \{\n\s+writeAgentChannelProvider\(name, provider\)\n\s+setAgentEnabledPlugins\(name, provider\)\n\s+\}/)
    expect(branch).not.toBeNull()
  })
  it('extra:true is refused for the main agent and for the primary provider itself', () => {
    expect(SRC).toContain("if (isMain) { json(res, { error: 'The main agent co-listens through CHANNEL_PLUGINS_EXTRA in .env, not through extraChannels' }, 400); return true }")
    expect(SRC).toContain('if (resolveAgentProvider(name) === provider) {')
  })
  it('DELETE of a co-listen provider removes only that extra, never the primary', () => {
    const at = SRC.indexOf('const extras = readAgentExtraChannels(name)')
    expect(at).toBeGreaterThan(-1)
    const block = SRC.slice(at, at + 400)
    // The CONDITION, not only the strings: an `if (false)` keeps every string
    // in place and runs the primary reset (Dani's mutant on b8e44691).
    expect(block).toMatch(/const extras = readAgentExtraChannels\(name\)\n\s+if \(extras\.includes\(provider as ChannelProviderType\)\) \{\n\s+writeAgentExtraChannels\(name, extras\.filter\(p => p !== provider\)\)\n\s+json\(res, \{ ok: true, extra: true \}\)\n\s+return true\n\s+\}/)
    expect(block).toContain('writeAgentExtraChannels(name, extras.filter(p => p !== provider))')
    const earlyReturn = block.indexOf('return true')
    const primaryReset = block.indexOf('writeAgentChannelProvider(name, \'\')')
    expect(earlyReturn).toBeGreaterThan(-1)
    expect(primaryReset).toBeGreaterThan(-1)
    expect(earlyReturn).toBeLessThan(primaryReset)
  })
})
