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
} from '../web/main-extra-plugins-settings.js'
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
