// #2078: two installs on one host, same uid, each with its own tmux server.
// Our `tmux list-panes -a` lists only our panes, so the other install's live
// session looked detached and reapDetachedChannelClaudes killed it. A claude
// under a tmux server other than ours is now spared; an orphan under our server,
// or under pid 1 once its server died (it outlives kill-server as it outlives
// respawn-pane -k), is still reaped.
//
// No process is started and no tmux is asked: `procs`, `panePids` and
// `tmuxServerPid` stand for the host, and the kill seam records the signals
// against a fake process table (a pid in it answers, a SIGTERM or SIGKILL ends
// it, any other pid is ESRCH).
import { describe, it, expect } from 'vitest'
import { findOrphanChannelClaudes, reapDetachedChannelClaudes, type ProcRow } from '../web/channel-poller-reap.js'

const needle = 'plugin:telegram@foreign-tmux-2078'
const claude = (extra = '') => `/usr/local/bin/claude ${extra}--channels ${needle}`

const OURS = 4_100_000, OUR_PANE = 4_100_010, OUR_LIVE = OUR_PANE, OUR_ORPHAN = 4_100_020
const OTHER = 4_200_000, OTHER_SH = 4_200_010, OTHER_LIVE = 4_200_011, OTHER_SH2 = 4_200_020, OTHER_SUB = 4_200_022, OTHER_SUB_SH = 4_200_021
const SURVIVOR = 4_300_001

const rows: ProcRow[] = [
  // our server; its argv embeds a claude command, argv[0] is tmux
  { pid: OURS, ppid: 1, command: `/usr/bin/tmux new-session -d -s ours ${claude()}` },
  // our live session (pane leader) and an orphan left by a --continue respawn
  { pid: OUR_LIVE, ppid: OURS, command: claude() },
  { pid: OUR_ORPHAN, ppid: OURS, command: claude('--continue ') },
  // the other install: a live session two hops below its server (pane shell),
  // and a sub-agent three hops below (pane shell, sh -c, claude)
  { pid: OTHER, ppid: 1, command: '/usr/bin/tmux -L other new-session -d -s other' },
  { pid: OTHER_SH, ppid: OTHER, command: '/bin/bash' },
  { pid: OTHER_LIVE, ppid: OTHER_SH, command: claude() },
  { pid: OTHER_SH2, ppid: OTHER, command: '/bin/bash' },
  { pid: OTHER_SUB_SH, ppid: OTHER_SH2, command: `sh -c ${claude('--continue ')}` },
  { pid: OTHER_SUB, ppid: OTHER_SUB_SH, command: claude('--continue ') },
  // a claude that outlived its tmux server: reparented to pid 1, no pane anywhere
  { pid: SURVIVOR, ppid: 1, command: claude('--continue ') },
]
const ourPanes = new Set([OUR_PANE])
const sorted = (a: number[]) => [...a].sort((x, y) => x - y)

describe('#2078 findOrphanChannelClaudes with our tmux server pid', () => {
  it('spares the claudes under another tmux server, at any depth; finds our orphan and the survivor', () => {
    expect(sorted(findOrphanChannelClaudes(rows, ourPanes, needle, OURS))).toEqual([OUR_ORPHAN, SURVIVOR])
  })

  it('omitted, the scan is host-wide as before (the other install counts as detached)', () => {
    expect(sorted(findOrphanChannelClaudes(rows, ourPanes, needle))).toEqual(sorted([OUR_ORPHAN, OTHER_LIVE, OTHER_SUB, SURVIVOR]))
  })

  it('null (our server unresolved): every tmux server counts as foreign, only the survivor is found', () => {
    expect(findOrphanChannelClaudes(rows, ourPanes, needle, null)).toEqual([SURVIVOR])
  })

  it('a parent cycle in the snapshot ends the walk', () => {
    const loop: ProcRow[] = [
      { pid: 4_400_001, ppid: 4_400_002, command: claude() },
      { pid: 4_400_002, ppid: 4_400_001, command: '/bin/bash' },
    ]
    expect(findOrphanChannelClaudes(loop, ourPanes, needle, OURS)).toEqual([4_400_001])
  })
})

describe('#2078 reapDetachedChannelClaudes passes our server to the scan', () => {
  function fakeKill(pids: number[]) {
    const live = new Set(pids)
    const signalled: number[] = []
    const kill = (pid: number, signal: NodeJS.Signals | 0) => {
      if (!live.has(pid)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      if (signal !== 0) { if (!signalled.includes(pid)) signalled.push(pid); live.delete(pid) }
    }
    return { signalled, kill }
  }
  const seams = (server: number | null, kill: (pid: number, signal: NodeJS.Signals | 0) => void) => ({
    channelNeedle: needle, procs: () => rows, panePids: () => ourPanes, tmuxServerPid: () => server,
    ownUid: 1000, ownerOf: () => 1000, kill,
  })

  it('the other install\'s sessions are never signalled; our orphan and the survivor are', () => {
    const k = fakeKill(rows.map((r) => r.pid))
    const reaped = reapDetachedChannelClaudes(seams(OURS, k.kill))
    expect(sorted(reaped)).toEqual([OUR_ORPHAN, SURVIVOR])
    expect(sorted(k.signalled)).toEqual([OUR_ORPHAN, SURVIVOR])
  })

  it('the server comes from the seam: named as the other one, that install becomes ours', () => {
    const k = fakeKill(rows.map((r) => r.pid))
    const reaped = reapDetachedChannelClaudes(seams(OTHER, k.kill))
    expect(sorted(reaped)).toEqual(sorted([OTHER_LIVE, OTHER_SUB, SURVIVOR]))
  })

  it('a null server (failed tmux query) signals nothing under any tmux server, only the survivor', () => {
    const k = fakeKill(rows.map((r) => r.pid))
    const reaped = reapDetachedChannelClaudes(seams(null, k.kill))
    expect(reaped).toEqual([SURVIVOR])
    expect(k.signalled).toEqual([SURVIVOR])
  })
})
