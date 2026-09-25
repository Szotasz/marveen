import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMainSessionRespawnCmd, mainChannelStateEnv } from '../web/channel-monitor.js'
import { mainConfigDecisionForTest } from '../web/main-config-decision.js'

// #1554 follow-up. The builder tests in channel-deafness-recovery.test.ts pass
// channelStateEnv by hand, so two wiring mutants stayed green on the full suite:
// a call site handing the builder a fixed, wrong directory, and a
// mainChannelStateEnv() that ignores its provider and always answers Telegram.
// Both reproduce the 2026-09-23/24 outages: a respawned main session whose
// plugin looks for its token in the wrong place and comes up channel-deaf.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MONITOR_SRC = readFileSync(join(REPO_ROOT, 'src', 'web', 'channel-monitor.ts'), 'utf-8')

describe('buildMainSessionRespawnCmd call-site parity', () => {
  it('every call site passes the state env resolved from the provider in use', () => {
    // CALL sites only (`= buildMainSessionRespawnCmd({`); a bare substring
    // count would also match the definition and the prose mentions.
    const sites = MONITOR_SRC.split('= buildMainSessionRespawnCmd({').length - 1
    const wired = MONITOR_SRC.split('channelStateEnv: mainChannelStateEnv(provider.type)').length - 1
    expect(sites).toBeGreaterThanOrEqual(3)
    expect(wired).toBe(sites)
  })
})

describe('buildMainSessionRespawnCmd with a non-Telegram provider', () => {
  it('exports the Discord state dir and never a Telegram one', () => {
    const cmd = buildMainSessionRespawnCmd({
      claudePath: '/usr/local/bin/claude',
      pluginId: 'discord@claude-plugins-official',
      model: '',
      config: mainConfigDecisionForTest(),
      continueSession: false,
      channelStateEnv: { name: 'DISCORD_STATE_DIR', dir: '/opt/marveen/.claude/channels/discord' },
    })
    expect(cmd).toContain("export DISCORD_STATE_DIR='/opt/marveen/.claude/channels/discord'")
    expect(cmd).not.toContain('TELEGRAM_STATE_DIR')
    expect(cmd.indexOf('DISCORD_STATE_DIR')).toBeLessThan(cmd.indexOf('/usr/local/bin/claude'))
  })
})

describe('mainChannelStateEnv', () => {
  const saved = { discord: process.env.DISCORD_STATE_DIR, telegram: process.env.TELEGRAM_STATE_DIR }
  afterEach(() => {
    for (const [k, v] of [['DISCORD_STATE_DIR', saved.discord], ['TELEGRAM_STATE_DIR', saved.telegram]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('names the env var and the directory of the provider it is given, not Telegram', () => {
    delete process.env.DISCORD_STATE_DIR
    delete process.env.TELEGRAM_STATE_DIR
    const env = mainChannelStateEnv('discord')
    expect(env.name).toBe('DISCORD_STATE_DIR')
    expect(env.dir).toMatch(/[\\/]\.claude[\\/]channels[\\/]discord$/)
    expect(env.dir).not.toMatch(/telegram/)
  })

  it('honours the provider override, not the Telegram one', () => {
    process.env.DISCORD_STATE_DIR = '/srv/discord-state'
    process.env.TELEGRAM_STATE_DIR = '/srv/telegram-state'
    expect(mainChannelStateEnv('discord')).toEqual({ name: 'DISCORD_STATE_DIR', dir: '/srv/discord-state' })
    expect(mainChannelStateEnv('telegram')).toEqual({ name: 'TELEGRAM_STATE_DIR', dir: '/srv/telegram-state' })
  })
})
