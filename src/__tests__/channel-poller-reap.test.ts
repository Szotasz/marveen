import { describe, expect, it } from 'vitest'
import { parsePollerPidsFromPs, findOrphanChannelClaudes, type ProcRow } from '../web/channel-poller-reap.js'

// Sample rows captured from a real `ps eww -e` on macOS during the
// 2026-06-01 channel-disconnect incident. The bun poller, the slack
// node server, and a shell - the env-var match must select ONLY the
// bun poller and only when the state dir matches.
const PS_SAMPLE = [
  '  90798 s000  S+     0:00.01 bun run --cwd /Users/x/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 --silent start HOME=/Users/x PATH=/opt/homebrew/bin TELEGRAM_STATE_DIR=/Users/x/ClaudeClaw/agents/samu/.claude/channels/telegram CLAUDE_CODE_SESSION_ID=abc',
  '  90799 s000  S+     0:00.15 node /Users/x/.claude/plugins/cache/marveen-marketplace/slack-channel/0.1.0/server.ts HOME=/Users/x SLACK_STATE_DIR=/Users/x/ClaudeClaw/agents/samu/.claude/channels/slack',
  '  90800 s000  S+     0:00.05 bun run --cwd /Users/x/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 --silent start HOME=/Users/x TELEGRAM_STATE_DIR=/Users/x/ClaudeClaw/agents/boni/.claude/channels/telegram',
  '   1234 s000  Ss     0:00.00 /bin/zsh HOME=/Users/x SHELL=/bin/zsh',
].join('\n')

describe('parsePollerPidsFromPs', () => {
  it('returns the bun poller pid matching the TELEGRAM_STATE_DIR for samu', () => {
    const pids = parsePollerPidsFromPs(
      PS_SAMPLE,
      'TELEGRAM_STATE_DIR',
      '/Users/x/ClaudeClaw/agents/samu/.claude/channels/telegram',
    )
    expect(pids).toEqual([90798])
  })

  it('returns the slack poller pid for the SLACK_STATE_DIR variant', () => {
    const pids = parsePollerPidsFromPs(
      PS_SAMPLE,
      'SLACK_STATE_DIR',
      '/Users/x/ClaudeClaw/agents/samu/.claude/channels/slack',
    )
    expect(pids).toEqual([90799])
  })

  it('does NOT match a different agent that uses the same env var', () => {
    // The samu reap must not kill boni's poller, even though both have the
    // TELEGRAM_STATE_DIR env var set; only the full path matches.
    const pids = parsePollerPidsFromPs(
      PS_SAMPLE,
      'TELEGRAM_STATE_DIR',
      '/Users/x/ClaudeClaw/agents/samu/.claude/channels/telegram',
    )
    expect(pids).not.toContain(90800)
  })

  it('returns empty array when no row matches', () => {
    const pids = parsePollerPidsFromPs(
      PS_SAMPLE,
      'TELEGRAM_STATE_DIR',
      '/Users/x/ClaudeClaw/agents/nobody/.claude/channels/telegram',
    )
    expect(pids).toEqual([])
  })

  it('returns multiple pids when several rows match (a real orphan scenario)', () => {
    // Two bun pollers against the same channel dir - the bug that triggered
    // this work item. Both must be reaped.
    const orphans = [
      '  29932 ttys001  S+   77:09.33 bun run --cwd /Users/x/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 start HOME=/Users/x TELEGRAM_STATE_DIR=/Users/x/ClaudeClaw/.claude/channels/telegram',
      '  91234 ttys002  S+    0:00.01 bun run --cwd /Users/x/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 start HOME=/Users/x TELEGRAM_STATE_DIR=/Users/x/ClaudeClaw/.claude/channels/telegram',
    ].join('\n')
    const pids = parsePollerPidsFromPs(
      orphans,
      'TELEGRAM_STATE_DIR',
      '/Users/x/ClaudeClaw/.claude/channels/telegram',
    )
    expect(pids).toEqual([29932, 91234])
  })

  it('ignores rows where the path appears only in argv (not as an env-var value)', () => {
    // Defensive: a row that *mentions* the state dir in its --cwd argv must
    // not be confused with one that actually has the env var. argv values
    // are not preceded by the literal `TELEGRAM_STATE_DIR=` prefix.
    const argvMention = '  55555 s000  S+   0:00.00 grep TELEGRAM_STATE_DIR /Users/x/ClaudeClaw/.claude/channels/telegram'
    const pids = parsePollerPidsFromPs(
      argvMention,
      'TELEGRAM_STATE_DIR',
      '/Users/x/ClaudeClaw/.claude/channels/telegram',
    )
    // The needle `TELEGRAM_STATE_DIR=/Users/x/ClaudeClaw/.claude/channels/telegram`
    // is NOT present in this row (the argv has space, not `=`), so no match.
    expect(pids).toEqual([])
  })

  it('drops pid 0 and pid 1 even if such a row could be crafted', () => {
    const malformed = '   1 ttys000  S+  0:00.00 fake-init TELEGRAM_STATE_DIR=/x'
    const pids = parsePollerPidsFromPs(malformed, 'TELEGRAM_STATE_DIR', '/x')
    expect(pids).toEqual([])
  })
})

// Rows modeled on the live 2026-06-03 incident snapshot. The tmux SERVER pid
// is 35874; the live marveen-channels pane leader is the claude at 76621
// (claudePid == panePid for the main session). 57158 + the 70xxx claudes are
// detached --continue leftovers reparented to the tmux server (ppid 35874).
// A live sub-agent is modeled as a pane shell (77189) with a claude child.
const CLAUDE = '/opt/homebrew/bin/claude'
const PROCS: ProcRow[] = [
  // tmux server: argv EMBEDS the claude --channels string -> must NOT match.
  { pid: 35874, ppid: 1, command: '/opt/homebrew/bin/tmux new-session -d -s marveen-channels -c /Users/x/ClaudeClaw /opt/homebrew/bin/claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official' },
  // live main session: claude is the pane leader (pid == panePid 76621).
  { pid: 76621, ppid: 35874, command: `${CLAUDE} --dangerously-skip-permissions --model claude-opus-4-8[1m] --channels plugin:telegram@claude-plugins-official` },
  // live sub-agent: pane leader is the shell (77189), claude is its child.
  { pid: 78001, ppid: 77189, command: `${CLAUDE} --continue --dangerously-skip-permissions --model claude-opus-4-8[1m] --channels plugin:telegram@claude-plugins-official` },
  // detached orphans: reparented to the tmux server, no live pane in ancestry.
  { pid: 57158, ppid: 35874, command: `${CLAUDE} --dangerously-skip-permissions --model claude-opus-4-8[1m] --channels plugin:telegram@claude-plugins-official` },
  { pid: 70459, ppid: 35874, command: `${CLAUDE} --continue --dangerously-skip-permissions --model deepseek-v4-pro --channels plugin:telegram@claude-plugins-official` },
  // unrelated processes that must be ignored.
  { pid: 90000, ppid: 1, command: '/opt/homebrew/bin/node /Users/x/ClaudeClaw/dist/web.js' },
  { pid: 90001, ppid: 1, command: `${CLAUDE} --dangerously-skip-permissions --model claude-opus-4-8[1m]` }, // claude, but no --channels
]
const LIVE_PANES = new Set<number>([76621, 77189, 44349])

describe('findOrphanChannelClaudes', () => {
  it('reaps detached channel claudes, spares live panes and the tmux server', () => {
    const orphans = findOrphanChannelClaudes(PROCS, LIVE_PANES)
    expect(orphans.sort((a, b) => a - b)).toEqual([57158, 70459])
  })

  it('spares the live main-session claude (pid == pane pid)', () => {
    expect(findOrphanChannelClaudes(PROCS, LIVE_PANES)).not.toContain(76621)
  })

  it('spares a live sub-agent claude whose parent is the live pane shell', () => {
    expect(findOrphanChannelClaudes(PROCS, LIVE_PANES)).not.toContain(78001)
  })

  it('never matches the tmux server even though its argv embeds the claude command', () => {
    expect(findOrphanChannelClaudes(PROCS, LIVE_PANES)).not.toContain(35874)
  })

  it('ignores claude processes without --channels', () => {
    expect(findOrphanChannelClaudes(PROCS, LIVE_PANES)).not.toContain(90001)
  })

  it('honors a channelNeedle filter (only telegram orphans, not slack)', () => {
    const withSlack: ProcRow[] = [
      ...PROCS,
      { pid: 71000, ppid: 35874, command: `${CLAUDE} --continue --channels plugin:slack-channel@marveen-marketplace` },
    ]
    const tg = findOrphanChannelClaudes(withSlack, LIVE_PANES, 'plugin:telegram@claude-plugins-official')
    expect(tg).not.toContain(71000)
    expect(tg.sort((a, b) => a - b)).toEqual([57158, 70459])
  })

  it('returns empty when there are no detached channel claudes', () => {
    const allLive: ProcRow[] = [
      { pid: 76621, ppid: 35874, command: `${CLAUDE} --channels plugin:telegram@claude-plugins-official` },
    ]
    expect(findOrphanChannelClaudes(allLive, new Set([76621]))).toEqual([])
  })
})
