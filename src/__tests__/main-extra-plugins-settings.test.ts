// SLACKDMVESZT1006: the main agent's co-listen plugins are enabled through a
// launch-time --settings file, never through a settings layer the sub-agents
// also read. The tracked project .claude/settings.json keeps slack-channel
// false on purpose (#112), and on 2026-10-06 a `true` in the install-root
// settings.local.json made two sub-agents open extra Slack sockets: 9 of 32
// owner DMs were lost. Measured for this PR, in a sandbox project:
//   claude plugin list --json                      -> project false: enabled false
//   claude --settings <file> plugin list --json    -> enabled true
// so the flag outranks the project scope, and only the session launched with
// it reads it.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mainExtraPluginsSettings, mainExtraPluginsSettingsPath, writeMainExtraPluginsSettings,
  mainAgentConfigPath, readMainSenderRoleGatePolicy, UNREADABLE_POLICY,
} from '../web/main-extra-plugins-settings.js'
import { pythonHookCommand } from '../web/agent-scaffold.js'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'
import { mainConfigDecisionForTest } from '../web/main-config-decision.js'

const ROOT = join(__dirname, '..', '..')
const SLACK = 'slack-channel@marveen-marketplace'
const shellFlag = (installDir: string, ...ids: string[]) =>
  execFileSync('bash', ['-c', `. "${ROOT}/scripts/main-extra-plugins-settings.sh"; main_extra_settings_flag "$@"`, 'x', installDir, ...ids]).toString()

describe('the settings file', () => {
  it('enables exactly the given plugins', () => {
    expect(mainExtraPluginsSettings([SLACK, ''])).toEqual({ enabledPlugins: { [SLACK]: true } })
  })

  it('TS writes it and returns its path; no extras -> no file, no flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mainxs-'))
    try {
      expect(writeMainExtraPluginsSettings(dir, [])).toBeNull()
      const p = writeMainExtraPluginsSettings(dir, [SLACK])
      expect(p).toBe(mainExtraPluginsSettingsPath(dir))
      expect(JSON.parse(readFileSync(p!, 'utf-8'))).toEqual({ enabledPlugins: { [SLACK]: true } })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('the shell helper writes the SAME file with the SAME content, and prints the flag (executed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mainxs sh-'))
    try {
      const out = shellFlag(dir, SLACK)
      expect(out).toBe(` --settings "${mainExtraPluginsSettingsPath(dir)}"`)
      expect(JSON.parse(readFileSync(mainExtraPluginsSettingsPath(dir), 'utf-8'))).toEqual(mainExtraPluginsSettings([SLACK]))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('the shell helper prints NOTHING without extras (the launch line stays byte-identical)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mainxs-'))
    try { expect(shellFlag(dir)).toBe('') } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('the printed flag survives a shell re-parse with a space in the install path (executed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'main xs-'))
    try {
      const echo = join(dir, 'args.sh')
      mkdirSync(dir, { recursive: true })
      writeFileSync(echo, '#!/bin/bash\nfor a in "$@"; do printf "[%s]" "$a"; done\n', { mode: 0o755 })
      const flag = shellFlag(dir, SLACK)
      const out = execFileSync('/bin/sh', ['-c', `"${echo}"${flag} --channels x`]).toString()
      expect(out).toBe(`[--settings][${mainExtraPluginsSettingsPath(dir)}][--channels][x]`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the main agent\'s sender-role gate rides the same file (MIOAPPTEAMSRV1025)', () => {
  const GATE = {
    allowTools: ['mcp__plugin_gromzo-channel_gromzo__reply'],
    roles: [{ channel: 'gromzo', sender: 'owner', role: 'owner' }, { channel: 'slack', sender: 'U0OWNER', role: 'owner' }],
    senderKeys: { gromzo: 'sender_role', slack: 'user_id' },
  }
  const withConfig = (cfg: unknown, raw?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'mainxs gate-'))
    mkdirSync(join(dir, 'store'), { recursive: true })
    writeFileSync(mainAgentConfigPath(dir), raw ?? JSON.stringify(cfg))
    return dir
  }

  it('TS and shell write the SAME file with the gate, without extras too (executed)', () => {
    for (const ids of [[], [SLACK]]) {
      const dir = withConfig({ senderRoleGate: GATE })
      try {
        const p = writeMainExtraPluginsSettings(dir, ids)
        expect(p).toBe(mainExtraPluginsSettingsPath(dir))
        const ts = readFileSync(p!, 'utf-8')
        const policy = readMainSenderRoleGatePolicy(dir)!
        expect(JSON.parse(Buffer.from(policy, 'base64url').toString('utf-8'))).toEqual(GATE)
        expect(JSON.parse(ts).hooks.PreToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', timeout: 10,
          command: pythonHookCommand('$CLAUDE_PROJECT_DIR/scripts/hooks/sender-role-gate.py', ['--policy', policy]) }] }])
        rmSync(p!)
        expect(shellFlag(dir, ...ids)).toBe(` --settings "${mainExtraPluginsSettingsPath(dir)}"`)
        expect(readFileSync(p!, 'utf-8')).toBe(ts)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }
  })

  it('the wired command, run as Claude Code runs it, denies a colleague\'s Read and lets the reply through (executed)', () => {
    const dir = withConfig({ senderRoleGate: GATE })
    try {
      const { hooks } = JSON.parse(readFileSync(writeMainExtraPluginsSettings(dir, [])!, 'utf-8'))
      const command: string = hooks.PreToolUse[0].hooks[0].command
      const transcript = join(dir, 't.jsonl')
      const turn = (env: string) => JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: `${env}\nhi` },
        origin: { kind: 'channel', server: 'plugin:gromzo-channel:gromzo' }, turnPosition: { promptIndex: 3, turnIndex: 3 } }) + '\n'
      const run = (tool: string) => execFileSync('bash', ['-c', command], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
        input: JSON.stringify({ tool_name: tool, transcript_path: transcript, hook_event_name: 'PreToolUse' }),
      }).toString()
      writeFileSync(transcript, turn('<channel source="plugin:gromzo-channel:gromzo" sender_role="colleague" verified="true" room_kind="channel" reply_to="0123456789abcdef">'))
      expect(run('Read')).toContain('"permissionDecision": "deny"')
      expect(run('mcp__plugin_gromzo-channel_gromzo__reply')).toBe('')
      writeFileSync(transcript, turn('<channel source="plugin:gromzo-channel:gromzo" sender_role="owner" verified="true">'))
      expect(run('Read')).toBe('')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a non-ASCII value encodes the same on both sides', () => {
    const dir = withConfig({ senderRoleGate: { ...GATE, roles: [{ channel: 'gromzo', sender: 'tulajdonos-é', role: 'owner' }] } })
    try {
      const ts = readFileSync(writeMainExtraPluginsSettings(dir, [])!, 'utf-8')
      shellFlag(dir)
      expect(readFileSync(mainExtraPluginsSettingsPath(dir), 'utf-8')).toBe(ts)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('off shapes: no gate (and no flag without extras) on both sides', () => {
    for (const cfg of [{}, { senderRoleGate: { riskyTools: [] } }, { senderRoleGate: {} }]) {
      const dir = withConfig(cfg)
      try {
        expect(writeMainExtraPluginsSettings(dir, [])).toBeNull()
        expect(shellFlag(dir)).toBe('')
        expect(JSON.parse(readFileSync(writeMainExtraPluginsSettings(dir, [SLACK])!, 'utf-8'))).toEqual({ enabledPlugins: { [SLACK]: true } })
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }
  })

  it('no file: no gate, no flag (both sides)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mainxs nofile-'))
    try {
      expect(readMainSenderRoleGatePolicy(dir)).toBeNull()
      expect(writeMainExtraPluginsSettings(dir, [])).toBeNull()
      expect(shellFlag(dir)).toBe('')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a config that exists but is not a readable JSON object wires the gate fail-closed on both sides (Dani 50508 (1))', () => {
    const broken: Array<string | Buffer> = [
      '{"senderRoleGate": {"allowTools": ["mcp__plugin_gromzo-channel_gromzo__reply"],', '', '[]', '"x"', 'null',
      '\ufeff{"senderRoleGate": {"allowTools": []}}', Buffer.from([0x7b, 0xff, 0xfe, 0x7d]),
      // Valid JSON once a lenient decoder replaces the bad byte: still unreadable, as for python.
      Buffer.concat([Buffer.from('{"senderRoleGate": {"allowTools": ["a'), Buffer.from([0xff]), Buffer.from('"]}}')]),
    ]
    for (const raw of broken) {
      const dir = mkdtempSync(join(tmpdir(), 'mainxs broken-'))
      mkdirSync(join(dir, 'store'), { recursive: true })
      writeFileSync(mainAgentConfigPath(dir), raw)
      try {
        expect(readMainSenderRoleGatePolicy(dir)).toBe(UNREADABLE_POLICY)
        const ts = readFileSync(writeMainExtraPluginsSettings(dir, [SLACK])!, 'utf-8')
        expect(JSON.parse(ts).hooks.PreToolUse[0].hooks[0].command).toContain(`--policy ${UNREADABLE_POLICY}`)
        rmSync(mainExtraPluginsSettingsPath(dir))
        expect(shellFlag(dir, SLACK)).toBe(` --settings "${mainExtraPluginsSettingsPath(dir)}"`)
        expect(readFileSync(mainExtraPluginsSettingsPath(dir), 'utf-8')).toBe(ts)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }
    // The hook reads that policy as malformed: a colleague's turn gets nothing, the owner's reply goes through.
    const dir = withConfig(null, '{"senderRoleGate": {')
    try {
      const { hooks } = JSON.parse(readFileSync(writeMainExtraPluginsSettings(dir, [])!, 'utf-8'))
      const transcript = join(dir, 't.jsonl')
      const env = (role: string) => JSON.stringify({ type: 'user', isMeta: true,
        message: { role: 'user', content: `<channel source="plugin:gromzo-channel:gromzo" sender_role="${role}" verified="true">\nhi` },
        origin: { kind: 'channel', server: 'plugin:gromzo-channel:gromzo' }, turnPosition: { promptIndex: 3, turnIndex: 3 } }) + '\n'
      writeFileSync(transcript, env('colleague'))
      const out = execFileSync('bash', ['-c', hooks.PreToolUse[0].hooks[0].command], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
        input: JSON.stringify({ tool_name: 'mcp__plugin_gromzo-channel_gromzo__reply', transcript_path: transcript, hook_event_name: 'PreToolUse' }),
      }).toString()
      expect(out).toContain('"permissionDecision": "deny"')
      expect(out).toContain('malformed')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a malformed but present gate is wired (the hook fails closed), the same on both sides', () => {
    const dir = withConfig({ senderRoleGate: { riskyTools: 'Bash' } })
    try {
      const ts = readFileSync(writeMainExtraPluginsSettings(dir, [])!, 'utf-8')
      expect(JSON.parse(ts).hooks).toBeDefined()
      shellFlag(dir)
      expect(readFileSync(mainExtraPluginsSettingsPath(dir), 'utf-8')).toBe(ts)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('every main-session launcher carries the flag', () => {
  const base = {
    claudePath: '/usr/local/bin/claude', pluginId: 'telegram@claude-plugins-official', model: 'claude-opus-5',
    continueSession: false, config: mainConfigDecisionForTest(),
    channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/opt/m/.claude/channels/telegram' },
  }

  it('recovery respawn: --settings with the file, single-quoted', () => {
    const cmd = buildMainSessionRespawnCmd({ ...base, extraPluginIds: [SLACK], extraSettingsPath: "/opt/m/store/.main-extra-plugins.settings.json" })
    expect(cmd).toContain("--settings '/opt/m/store/.main-extra-plugins.settings.json'")
    expect(cmd).toContain(`plugin:${SLACK}`)
  })

  it('recovery respawn without extras: no --settings at all', () => {
    expect(buildMainSessionRespawnCmd(base)).not.toContain('--settings')
  })

  it('all three channel-monitor respawn sites pass the file next to the extras, with the PRIMARY first (INSTALLDIRTYTREE1103)', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'channel-monitor.ts'), 'utf-8')
    const extras = src.split('extraPluginIds: readExtraChannelPluginIds(),').length - 1
    // CHANNELUNCONF1110: the list comes from mainLaunchPluginIds, still the primary first (dropped only when its token is
    // missing, as channels.sh drops it).
    const flags = src.split('extraSettingsPath: writeMainExtraPluginsSettings(PROJECT_ROOT, mainLaunchPluginIds(provider)),').length - 1
    expect(extras).toBe(3)
    expect(flags).toBe(extras)
    expect(src).toContain('return [...(mainPrimaryConfigured(provider.type) ? [provider.pluginId] : []), ...readExtraChannelPluginIds()]')
  })

  it('channels.sh: both launch lines carry the flag, computed by the shared helper', () => {
    const sh = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')
    expect(sh).toContain('. "$INSTALL_DIR/scripts/main-extra-plugins-settings.sh"')
    expect(sh).toContain('EXTRA_SETTINGS_FLAG="$(main_extra_settings_flag "$INSTALL_DIR" "$PLUGIN_ID" $CHANNEL_PLUGINS_EXTRA)"')
    expect(sh.split('--dangerously-skip-permissions${EXTRA_SETTINGS_FLAG} ').length - 1).toBe(2)
  })

  it('channel-watchdog.sh: the respawn line carries the flag too', () => {
    const sh = readFileSync(join(ROOT, 'scripts', 'channel-watchdog.sh'), 'utf-8')
    expect(sh).toContain('EXTRA_SETTINGS_FLAG="$(main_extra_settings_flag "$INSTALL_DIR" "$PRIMARY_PLUGIN_ID" $CHANNEL_PLUGINS_EXTRA)"')
    expect(sh).toContain('--dangerously-skip-permissions${EXTRA_SETTINGS_FLAG} ')
    expect(sh).toContain('--channels plugin:${PRIMARY_PLUGIN_ID}${EXTRA_CHANNELS}"')
  })

  it('stuck-modal-guard.sh: the respawn line carries the flag with the respawned primary', () => {
    const sh = readFileSync(join(ROOT, 'scripts', 'stuck-modal-guard.sh'), 'utf-8')
    // GROMZOMAINAGENT1106: with the co-listen extras too, as channels.sh and the watchdog pass them.
    // CHANNELUNCONF1110: the respawned primary, emptied only when its token is missing (as the --channels list).
    expect(sh).toContain('local _primary_id="${RESPAWN_PLUGIN#plugin:}"')
    expect(sh).toContain('SETTINGS_FLAG="$(main_extra_settings_flag "$INSTALL_DIR" "$_primary_id" $_extra)"')
    // GROMZONOPROVIDER1108: the channels argument is built once (a gromzo-pending respawn has no primary); for every
    // other provider it is still the respawned primary plus the extras.
    expect(sh).toContain('--dangerously-skip-permissions${SETTINGS_FLAG} ${MODEL_FLAG}${CHAN_ARG}"')
    expect(sh).toContain('CHAN_ARG="--channels $PLUGIN_Q${EXTRA_Q}"')
  })
})

// INSTALLDIRTYTREE1103: the primary channel plugin used to be enabled by WRITING the
// tracked .claude/settings.json (the installers' `claude plugin enable --scope project`
// and channels.sh's self-healing guard). Both rewrote the whole compact file
// (~500 lines on marveen2, 11-03), so every fresh install was dirty and every update
// went down the stash path. The primary now rides the same --settings file.
describe('the primary channel plugin rides the flag file, never the tracked settings (INSTALLDIRTYTREE1103)', () => {
  // resolve_plugin_ids() from channels.sh and the watchdog's case block, executed as-is.
  const channelsSh = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')
  const watchdogSh = readFileSync(join(ROOT, 'scripts', 'channel-watchdog.sh'), 'utf-8')
  const resolveFn = channelsSh.match(/^resolve_plugin_ids\(\) \{\n[\s\S]*?\n\}\n/m)![0]
  const watchdogCase = watchdogSh.match(/^case "\$CHANNEL_PROVIDER" in\n  slack\)    PRIMARY_PLUGIN_ID=[\s\S]*?\nesac\n/m)![0]
  const PROVIDERS = ['slack', 'telegram', 'discord', 'whatsapp', 'teams']
  const channelsId = (prov: string) =>
    execFileSync('bash', ['-c', `${resolveFn}\nresolve_plugin_ids "$1"; printf %s "$PLUGIN_ID"`, 'x', prov]).toString()

  it('the watchdog maps every provider to the SAME primary id as channels.sh (executed)', () => {
    for (const prov of PROVIDERS) {
      const wd = execFileSync('bash', ['-c', `CHANNEL_PROVIDER="$1"\n${watchdogCase}printf %s "$PRIMARY_PLUGIN_ID"`, 'x', prov]).toString()
      expect(wd).toBe(channelsId(prov))
    }
  })

  for (const prov of ['slack', 'telegram']) {
    it(`${prov}-primary: the file channels.sh launches with enables the primary (executed, shell and TS identical)`, () => {
      const dir = mkdtempSync(join(tmpdir(), `mainxs ${prov}-`))
      try {
        const id = channelsId(prov)
        expect(shellFlag(dir, id)).toBe(` --settings "${mainExtraPluginsSettingsPath(dir)}"`)
        const sh = readFileSync(mainExtraPluginsSettingsPath(dir), 'utf-8')
        expect(JSON.parse(sh)).toEqual({ enabledPlugins: { [id]: true } })
        expect(readFileSync(writeMainExtraPluginsSettings(dir, [id])!, 'utf-8')).toBe(sh)
        // With a co-listen extra the primary stays first and both are enabled.
        const other = prov === 'slack' ? 'telegram@claude-plugins-official' : SLACK
        shellFlag(dir, id, other)
        expect(JSON.parse(readFileSync(mainExtraPluginsSettingsPath(dir), 'utf-8'))).toEqual({ enabledPlugins: { [id]: true, [other]: true } })
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })
  }

  it('the flag file lives in a gitignored path: writing it leaves a clean tree (executed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mainxs git-'))
    try {
      writeFileSync(join(dir, '.gitignore'), readFileSync(join(ROOT, '.gitignore')))
      const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a]).toString()
      git('init', '-q')
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.gitignore')
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')
      shellFlag(dir, SLACK)
      writeMainExtraPluginsSettings(dir, [SLACK])
      expect(git('status', '--porcelain', '--untracked-files=all')).toBe('')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('no installer or launcher writes the tracked project settings any more', () => {
    for (const f of ['install-macos.sh', 'install-linux.sh']) {
      const src = readFileSync(join(ROOT, f), 'utf-8')
      expect(src, f).not.toMatch(/^[^#\n]*claude plugin enable/m)
    }
    expect(channelsSh).not.toContain('_ensure_plugin_enabled')
    for (const f of ['channels.sh', 'channel-watchdog.sh', 'stuck-modal-guard.sh']) {
      const src = readFileSync(join(ROOT, 'scripts', f), 'utf-8')
      expect(src, f).not.toMatch(/^[^#\n]*(json\.dump|>|tee)[^#\n]*\.claude\/settings\.json/m)
    }
  })

  it('sub-agent launchers never get the main flag file (#112: one socket per Slack app)', () => {
    const agentProcess = readFileSync(join(ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')
    const watchdog = readFileSync(join(ROOT, 'scripts', 'watchdog.sh'), 'utf-8')
    for (const [name, src] of [['agent-process.ts', agentProcess], ['watchdog.sh', watchdog]] as const) {
      expect(src, name).not.toContain('main-extra-plugins')
      expect(src, name).not.toContain('main_extra_settings_flag')
      expect(src, name).not.toContain('writeMainExtraPluginsSettings')
    }
  })
})
