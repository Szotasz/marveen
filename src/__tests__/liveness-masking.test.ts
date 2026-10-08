// Integration test for `decideHasPluginAlive` -- the pure decider extracted
// from `hasChannelPluginAlive`. The masking-prevention guarantee at the
// matcher layer is already proven by provider-poller-match.test.ts; this file
// verifies the decider wires the matcher into the tree-walk + bot.pid +
// cross-tree fallbacks correctly, and replays the 2026-06-09 multi-plugin
// masking scenario end-to-end.

import { describe, it, expect } from 'vitest'
import { decideHasPluginAlive } from '../channel-coordinator/liveness.js'

// Synthetic `ps -axo pid,ppid,command` snapshots. First line is the header
// `ps` always emits; the decider skips it via .slice(1) just like the live
// path does, so the header is required for fidelity.
const PS_HEADER = '  PID  PPID COMMAND'

function ps(rows: Array<{ pid: number; ppid: number; command: string }>): string {
  const body = rows.map(r => `${String(r.pid).padStart(5)} ${String(r.ppid).padStart(5)} ${r.command}`).join('\n')
  return PS_HEADER + '\n' + body
}

const CLAUDE_PID = 1000
const TELEGRAM_BUN_PID = 2000
const SYNOLOGY_BUN_PID = 3000

const TELEGRAM_CMD =
  'bun run --cwd /home/user/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 --shell=bun --silent start'
const SYNOLOGY_CMD =
  'bun run --cwd /home/user/.claude/plugins/efi-src/synology-chat --shell=bun --silent start'

const ALL_PIDS_ALIVE = () => true
const NO_PIDS_ALIVE = () => false

describe('decideHasPluginAlive -- 2026-06-09 multi-plugin masking regression', () => {
  it('telegram down + synology up under claude pid -> NOT alive (the masking bug pre-fix)', () => {
    // Only the synology poller is a child of claude. The decider must NOT
    // report "telegram alive" merely because some bun process happens to be
    // a child of the claude. Pre-fix this reported true via the generic
    // `bun + server.ts` clause if the cmdline ever contained server.ts; we
    // also regression-lock against any future broadening of the matcher
    // that could match the synology cmdline.
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude --channels plugin:telegram@claude-plugins-official' },
      { pid: SYNOLOGY_BUN_PID, ppid: CLAUDE_PID, command: SYNOLOGY_CMD },
    ])
    const alive = decideHasPluginAlive({
      psOutput: out,
      claudePid: CLAUDE_PID,
      providerType: 'telegram',
      botPid: null,
      isPidAlive: ALL_PIDS_ALIVE,
    })
    expect(alive).toBe(false)
  })

  it('telegram up + synology up under claude pid -> alive', () => {
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude --channels plugin:telegram@claude-plugins-official' },
      { pid: TELEGRAM_BUN_PID, ppid: CLAUDE_PID, command: TELEGRAM_CMD },
      { pid: SYNOLOGY_BUN_PID, ppid: CLAUDE_PID, command: SYNOLOGY_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(true)
  })

  it('telegram pid gone + synology still up -> NOT alive (the original 2026-06-09 scenario)', () => {
    // Telegram bun row dropped from ps (process died); synology bun row still
    // present. This is what happens when the real telegram poller crashes
    // mid-flight while the SynoChat worker keeps running. Without the fix
    // the channel-monitor stays at "alive" -- the user-visible deafness Szabi
    // reported. With the fix, the matcher refuses to credit synology to
    // telegram, the monitor sees "down", and the recovery cascade can act.
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude --channels plugin:telegram@claude-plugins-official' },
      { pid: SYNOLOGY_BUN_PID, ppid: CLAUDE_PID, command: SYNOLOGY_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(false)
  })

  it('telegram bun is a grandchild (not direct child) of claude -> alive (tree-walk descends)', () => {
    // claude spawns a `bun` wrapper which spawns the real poller. The
    // tree-walk must descend through the wrapper to find the poller.
    const WRAPPER = 1500
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude --channels plugin:telegram@claude-plugins-official' },
      { pid: WRAPPER, ppid: CLAUDE_PID, command: 'bun' },
      { pid: TELEGRAM_BUN_PID, ppid: WRAPPER, command: TELEGRAM_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(true)
  })

  it('claude pid absent from ps -> NOT alive', () => {
    const out = ps([
      { pid: SYNOLOGY_BUN_PID, ppid: 1, command: SYNOLOGY_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(false)
  })
})

describe('decideHasPluginAlive -- bot.pid fallback (reparented orphan)', () => {
  it('telegram orphan reparented away from claude tree but bot.pid points to it -> alive', () => {
    const ORPHAN = 4000
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude --channels plugin:telegram@claude-plugins-official' },
      // reparented (ppid != claude); will not be found via tree-walk
      { pid: ORPHAN, ppid: 1, command: TELEGRAM_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: ORPHAN, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(true)
  })

  it('bot.pid points to a dead pid -> ignore, do NOT report alive', () => {
    const DEAD = 4001
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      // The pid is in ps with telegram cmdline but isPidAlive says it's gone.
      { pid: DEAD, ppid: 1, command: TELEGRAM_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: DEAD, isPidAlive: NO_PIDS_ALIVE,
    })).toBe(false)
  })

  it('bot.pid points to a pid whose cmdline is the WRONG provider -> NOT alive', () => {
    // The bot.pid file contains a stale pid that has been recycled by an
    // unrelated process (or the SynoChat worker by coincidence). Without the
    // matcher gate this would falsely report telegram alive.
    const RECYCLED = 4002
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: RECYCLED, ppid: 1, command: SYNOLOGY_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: RECYCLED, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(false)
  })
})

describe('decideHasPluginAlive -- slack/discord cross-tree scan', () => {
  it('slack poller alive but NOT a descendant of claude -> alive via cross-tree scan', () => {
    const SLACK_NODE = 5000
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude --channels plugin:slack-channel@marveen-marketplace' },
      // Slack node process owned by something else (e.g. an MCP server boot)
      // but matching the slack-channel plugin path.
      { pid: SLACK_NODE, ppid: 1, command: 'node /home/user/.claude/plugins/marketplaces/marveen-marketplace/slack-channel/0.1.0/server.js' },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'slack',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(true)
  })

  it('discord poller alive but NOT a descendant -> alive via cross-tree scan', () => {
    const DISCORD = 6000
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude --channels plugin:discord@claude-plugins-official' },
      { pid: DISCORD, ppid: 1, command: 'bun run --cwd /home/user/.claude/plugins/cache/claude-plugins-official/discord/0.0.4 --silent start' },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'discord',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(true)
  })

  it('cross-tree scan respects the matcher: synology process does NOT count as slack', () => {
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude --channels plugin:slack-channel@marveen-marketplace' },
      { pid: SYNOLOGY_BUN_PID, ppid: 1, command: SYNOLOGY_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'slack',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(false)
  })
})

// BOOTSTAGGER1007 (b), #1762 review: the main session's co-listen Slack shares
// its provider with every Slack sub-agent on the host. The default probe's
// slack/discord fallback scans the WHOLE machine, so a dead main-session Slack
// read as alive whenever any sub-agent's Slack lived -- the 2026-10-07 case
// exactly. strictTree counts only a plugin inside the given claude's tree.
describe('decideHasPluginAlive -- strictTree (a provider shared with other sessions)', () => {
  const MAIN_CLAUDE = 100
  const OTHER_CLAUDE = 200
  const SLACK_CMD = 'bun run --cwd /home/user/.claude/plugins/cache/marveen-marketplace/slack-channel/0.1.0 --silent start'
  const mainTelegramOtherSlack = ps([
    { pid: MAIN_CLAUDE, ppid: 1, command: 'claude --channels plugin:telegram@claude-plugins-official plugin:slack-channel@marveen-marketplace' },
    { pid: 101, ppid: MAIN_CLAUDE, command: TELEGRAM_CMD },
    { pid: OTHER_CLAUDE, ppid: 1, command: 'claude --channels plugin:slack-channel@marveen-marketplace' },
    { pid: 201, ppid: OTHER_CLAUDE, command: SLACK_CMD },
  ])

  it('main claude with only a telegram child, ANOTHER claude with a slack child -> the main session\'s slack is DOWN under strictTree', () => {
    expect(decideHasPluginAlive({
      psOutput: mainTelegramOtherSlack, claudePid: MAIN_CLAUDE, providerType: 'slack',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE, strictTree: true,
    })).toBe(false)
  })

  it('...while the default probe (unchanged) still answers true from the machine-wide fallback', () => {
    expect(decideHasPluginAlive({
      psOutput: mainTelegramOtherSlack, claudePid: MAIN_CLAUDE, providerType: 'slack',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(true)
  })

  it('a bot.pid pointing at the other session\'s slack poller does not count under strictTree either', () => {
    expect(decideHasPluginAlive({
      psOutput: mainTelegramOtherSlack, claudePid: MAIN_CLAUDE, providerType: 'slack',
      botPid: 201, isPidAlive: ALL_PIDS_ALIVE, strictTree: true,
    })).toBe(false)
  })

  it('the main session\'s own slack child IS alive under strictTree', () => {
    const out = ps([
      { pid: MAIN_CLAUDE, ppid: 1, command: 'claude --channels plugin:telegram@claude-plugins-official plugin:slack-channel@marveen-marketplace' },
      { pid: 101, ppid: MAIN_CLAUDE, command: TELEGRAM_CMD },
      { pid: 102, ppid: MAIN_CLAUDE, command: SLACK_CMD },
      { pid: OTHER_CLAUDE, ppid: 1, command: 'claude' },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: MAIN_CLAUDE, providerType: 'slack',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE, strictTree: true,
    })).toBe(true)
  })
})
