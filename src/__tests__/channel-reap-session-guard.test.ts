import { describe, expect, it } from 'vitest'
import { selectReapablePollers, type ProcRow } from '../web/channel-poller-reap.js'

// WHY THIS EXISTS (2026-09-21, card ee485f5e).
//
// Between 03:00 and 06:31 the Telegram bridge restarted ~40 times, every
// instance dying ~60 seconds after start. Cause: reapChannelOrphans selects its
// victims with a `ps eww -e` scan for TELEGRAM_STATE_DIR=<chanDir>. Since #915
// channels.sh EXPORTS that variable, and env vars are inherited -- so the needle
// matched the session's own `claude` (which on the main session IS the tmux pane
// leader) and even the watchdog's own `sleep 5`. Killing the pane leader
// destroyed the session; the respawn 19 ms later failed with "can't find pane";
// the runner retried on the next tick; repeat.
//
// These rows are the REAL process tree, measured on this host at 2026-09-21
// 06:55 (`/bin/ps eww -e | grep -F TELEGRAM_STATE_DIR=<chanDir>` returned
// exactly these five pids, and `tmux list-panes` reported 641057 as the pane).
const LIVE: ProcRow[] = [
  { pid: 1, ppid: 0, command: '/sbin/init' },
  { pid: 855, ppid: 1, command: 'tmux -CC new-session -d -s lean-chief-channels' },
  { pid: 94830, ppid: 395, command: '/usr/bin/node /home/istvan/marveen/dist/index.js' },
  { pid: 640921, ppid: 94830, command: '/bin/bash /home/istvan/marveen/scripts/channels.sh' },
  { pid: 641057, ppid: 855, command: '/home/istvan/.local/bin/claude --dangerously-skip-permissions --model claude-opus-5[1m] --channels plugin:telegram@claude-plugins-official' },
  { pid: 641186, ppid: 641057, command: 'bun run --cwd /home/istvan/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7 --shell=bun --silent start' },
  { pid: 641196, ppid: 641186, command: '/home/istvan/.bun/bin/bun server.ts' },
  { pid: 668857, ppid: 640921, command: 'sleep 5' },
]
const PANES = new Set([641057])
// The candidate list reapChannelOrphans built on 2026-09-21 06:27, in its own
// order (bot.pid first, then the env scan), deduplicated.
const CANDIDATES = [641196, 641057, 641186, 668857]

describe('selectReapablePollers -- the 2026-09-21 bridge-restart loop', () => {
  it('reaps both bun pollers and NOTHING else', () => {
    const { reap } = selectReapablePollers(CANDIDATES, LIVE, PANES, 641196)
    expect(reap.sort()).toEqual([641186, 641196])
  })

  it('spares the session claude -- killing it is what took the bridge down', () => {
    const { reap, spared } = selectReapablePollers(CANDIDATES, LIVE, PANES, 641196)
    expect(reap).not.toContain(641057)
    expect(spared).toContainEqual({ pid: 641057, reason: 'pane' })
  })

  it("spares the watchdog's own sleep, which only inherited the env var", () => {
    const { reap, spared } = selectReapablePollers(CANDIDATES, LIVE, PANES, 641196)
    expect(reap).not.toContain(668857)
    expect(spared).toContainEqual({ pid: 668857, reason: 'not-a-runtime' })
  })

  it('spares the tmux server if the scan ever reaches it (pane ancestor)', () => {
    const { reap, spared } = selectReapablePollers([855, 641196], LIVE, PANES, 641196)
    expect(reap).toEqual([641196])
    expect(spared).toContainEqual({ pid: 855, reason: 'pane-ancestor' })
  })

  it('still spares a claude when tmux gives no panes at all (defence in depth)', () => {
    // livePanePids() returns an empty set when the tmux query fails. The pane
    // guard is then blind, so the claude guard has to carry it alone.
    const { reap, spared } = selectReapablePollers(CANDIDATES, LIVE, new Set<number>(), 641196)
    expect(reap.sort()).toEqual([641186, 641196])
    expect(spared).toContainEqual({ pid: 641057, reason: 'claude' })
  })
})

describe('selectReapablePollers -- shapes it must NOT break', () => {
  // A sub-agent: tmux runs `sh -c "... claude ..."`, so the pane is the sh and
  // claude is its child. The poller must still be reaped.
  const SUB: ProcRow[] = [
    { pid: 700, ppid: 855, command: 'sh -c exec claude --channels plugin:telegram@x' },
    { pid: 701, ppid: 700, command: '/home/istvan/.local/bin/claude --channels plugin:telegram@x' },
    { pid: 702, ppid: 701, command: 'bun run --cwd /plugins/telegram/0.0.7 start' },
  ]

  it('reaps a sub-agent poller and spares the sub-agent claude', () => {
    const { reap, spared } = selectReapablePollers([702, 701], SUB, new Set([700]), 702)
    expect(reap).toEqual([702])
    expect(spared).toContainEqual({ pid: 701, reason: 'claude' })
  })

  it('reaps a node-based poller too, not only bun', () => {
    const procs: ProcRow[] = [{ pid: 90, ppid: 1, command: 'node /plugins/slack-channel/0.1.0/server.ts' }]
    expect(selectReapablePollers([90], procs, new Set(), null).reap).toEqual([90])
  })

  it('reaps bot.pid even when it is NOT a known runtime -- the plugin wrote it', () => {
    // The runtime whitelist is a filter on the ENV SCAN only. A poller shipped
    // as a compiled binary is still reachable through bot.pid; the named gap is
    // a non-JS orphan whose pid is no longer in bot.pid.
    const procs: ProcRow[] = [{ pid: 91, ppid: 1, command: '/opt/telegram-poller --serve' }]
    expect(selectReapablePollers([91], procs, new Set(), 91).reap).toEqual([91])
    expect(selectReapablePollers([91], procs, new Set(), null).reap).toEqual([])
  })

  it('reports a candidate that has already exited as gone, not as reapable', () => {
    const { reap, spared } = selectReapablePollers([99999], LIVE, PANES, null)
    expect(reap).toEqual([])
    expect(spared).toEqual([{ pid: 99999, reason: 'gone' }])
  })

  it('keeps two genuine orphan pollers on one channel dir (the original bug)', () => {
    const procs: ProcRow[] = [
      { pid: 29932, ppid: 1, command: 'bun run --cwd /plugins/telegram/0.0.6 start' },
      { pid: 91234, ppid: 1, command: 'bun run --cwd /plugins/telegram/0.0.6 start' },
    ]
    expect(selectReapablePollers([29932, 91234], procs, new Set([855]), null).reap)
      .toEqual([29932, 91234])
  })
})
