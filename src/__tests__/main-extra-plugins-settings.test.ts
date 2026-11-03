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

  it('all three channel-monitor respawn sites pass the file next to the extras', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'channel-monitor.ts'), 'utf-8')
    const extras = src.split('extraPluginIds: readExtraChannelPluginIds(),').length - 1
    const flags = src.split('extraSettingsPath: writeMainExtraPluginsSettings(PROJECT_ROOT, readExtraChannelPluginIds()),').length - 1
    expect(extras).toBe(3)
    expect(flags).toBe(extras)
  })

  it('channels.sh: both launch lines carry the flag, computed by the shared helper', () => {
    const sh = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')
    expect(sh).toContain('. "$INSTALL_DIR/scripts/main-extra-plugins-settings.sh"')
    expect(sh).toContain('EXTRA_SETTINGS_FLAG="$(main_extra_settings_flag "$INSTALL_DIR" $CHANNEL_PLUGINS_EXTRA)"')
    expect(sh.split('--dangerously-skip-permissions${EXTRA_SETTINGS_FLAG} ').length - 1).toBe(2)
  })

  it('channel-watchdog.sh: the respawn line carries the flag too', () => {
    const sh = readFileSync(join(ROOT, 'scripts', 'channel-watchdog.sh'), 'utf-8')
    expect(sh).toContain('EXTRA_SETTINGS_FLAG="$(main_extra_settings_flag "$INSTALL_DIR" $CHANNEL_PLUGINS_EXTRA)"')
    expect(sh).toContain('--dangerously-skip-permissions${EXTRA_SETTINGS_FLAG} ')
  })
})
