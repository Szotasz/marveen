// MXDAGENTSOCKID1106 (b), Samu 71288: the gromzo-channel plugin outlives its claude (it ignores a closed stdin,
// measured 2026-11-06), and no other reaper sees it. reapGromzoOrphans kills exactly the plugins no live pane of
// our tmux server holds, and nothing else: not the live plugin of a running agent, not a process that merely
// inherited MXD_AGENT, not another install's plugin. The host is never scanned here: every test hands its own
// snapshot, and the one real process is a dummy node this test starts.
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseGromzoPluginRows, findGromzoOrphans, reapGromzoOrphans, type ProcRow,
} from '../web/channel-poller-reap.js'

const ROOT = join(__dirname, '..', '..')
const GZ_ROOT = '/Users/x/marveen-local-plugins/gromzo/gromzo-channel'
const SERVER = 4_100_001, PANE_MAIN = 4_100_010, CLAUDE_MAIN = PANE_MAIN, PANE_SUB = 4_100_020, SHELL_SUB = 4_100_021, CLAUDE_SUB = 4_100_022
const LIVE_MAIN = 4_100_030, LIVE_SUB = 4_100_031, ORPHAN_PID1 = 4_100_040, DETACHED_CLAUDE = 4_100_050, ORPHAN_UNDER_DETACHED = 4_100_051
const INHERITED_NODE = 4_100_060, FOREIGN_SERVER = 4_100_070, FOREIGN_PANE = 4_100_071, FOREIGN_PLUGIN = 4_100_072, OTHER_PLUGIN = 4_100_080

const row = (pid: number, cmd: string, env: string) => `${pid} ?  S  0:00 ${cmd} ${env}`
const psEww = () => [
  row(LIVE_MAIN, `node ${GZ_ROOT}/dist/server.js`, `MXD_AGENT=marveen MXD_SCOPE=both CLAUDE_PLUGIN_ROOT=${GZ_ROOT} HOME=/h`),
  row(LIVE_SUB, `node ${GZ_ROOT}/dist/server.js`, `HOME=/h CLAUDE_PLUGIN_ROOT=${GZ_ROOT} MXD_AGENT=samu`),
  row(ORPHAN_PID1, `node ${GZ_ROOT}/dist/server.js`, `CLAUDE_PLUGIN_ROOT=${GZ_ROOT} MXD_AGENT=marveen`),
  row(ORPHAN_UNDER_DETACHED, `node ${GZ_ROOT}/dist/server.js`, `CLAUDE_PLUGIN_ROOT=${GZ_ROOT} MXD_AGENT=iris`),
  // inherited MXD_AGENT, another plugin's root: never a candidate
  row(INHERITED_NODE, 'node /c/slack-channel/server.js', 'MXD_AGENT=marveen CLAUDE_PLUGIN_ROOT=/c/plugins/cache/m/slack-channel/0.1.0'),
  row(FOREIGN_PLUGIN, `node ${GZ_ROOT}/dist/server.js`, `CLAUDE_PLUGIN_ROOT=${GZ_ROOT} MXD_AGENT=marveen`),
  // a sibling plugin dir whose name only starts with gromzo-channel
  row(OTHER_PLUGIN, 'node /x/gromzo-channel-dev/server.js', 'CLAUDE_PLUGIN_ROOT=/x/gromzo-channel-dev MXD_AGENT=zara'),
].join('\n')
const procs = (): ProcRow[] => [
  { pid: SERVER, ppid: 1, command: 'tmux new-session -d' },
  { pid: CLAUDE_MAIN, ppid: SERVER, command: '/opt/homebrew/bin/claude --channels plugin:gromzo-channel@gromzo-local' },
  { pid: LIVE_MAIN, ppid: CLAUDE_MAIN, command: `node ${GZ_ROOT}/dist/server.js` },
  { pid: PANE_SUB, ppid: SERVER, command: '/bin/zsh' },
  { pid: SHELL_SUB, ppid: PANE_SUB, command: '/bin/bash -c claude' },
  { pid: CLAUDE_SUB, ppid: SHELL_SUB, command: 'claude --channels plugin:gromzo-channel@gromzo-local' },
  { pid: LIVE_SUB, ppid: CLAUDE_SUB, command: `node ${GZ_ROOT}/dist/server.js` },
  { pid: ORPHAN_PID1, ppid: 1, command: `node ${GZ_ROOT}/dist/server.js` },
  { pid: DETACHED_CLAUDE, ppid: SERVER, command: 'claude --channels plugin:gromzo-channel@gromzo-local' },
  { pid: ORPHAN_UNDER_DETACHED, ppid: DETACHED_CLAUDE, command: `node ${GZ_ROOT}/dist/server.js` },
  { pid: INHERITED_NODE, ppid: 1, command: 'node /c/slack-channel/server.js' },
  { pid: FOREIGN_SERVER, ppid: 1, command: 'tmux -L other new-session -d' },
  { pid: FOREIGN_PANE, ppid: FOREIGN_SERVER, command: 'claude --channels plugin:gromzo-channel@gromzo-local' },
  { pid: FOREIGN_PLUGIN, ppid: FOREIGN_PANE, command: `node ${GZ_ROOT}/dist/server.js` },
  { pid: OTHER_PLUGIN, ppid: 1, command: 'node /x/gromzo-channel-dev/server.js' },
]
const live = () => new Set([PANE_MAIN, PANE_SUB])

function fakeKill(pids: number[]) {
  const alive = new Set(pids)
  const signalled: number[] = []
  const kill = (pid: number, signal: NodeJS.Signals | 0) => {
    if (!alive.has(pid)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    if (signal !== 0) { signalled.push(pid); alive.delete(pid) }
  }
  return { signalled, kill }
}

describe('parseGromzoPluginRows', () => {
  it('needs the gromzo-channel plugin root AND MXD_AGENT, in any env order', () => {
    expect(parseGromzoPluginRows(psEww())).toEqual([
      { pid: LIVE_MAIN, agent: 'marveen' },
      { pid: LIVE_SUB, agent: 'samu' },
      { pid: ORPHAN_PID1, agent: 'marveen' },
      { pid: ORPHAN_UNDER_DETACHED, agent: 'iris' },
      { pid: FOREIGN_PLUGIN, agent: 'marveen' },
    ])
  })

  it('a root without MXD_AGENT, or a bad slug, is not a row', () => {
    expect(parseGromzoPluginRows(row(5, 'node s.js', `CLAUDE_PLUGIN_ROOT=${GZ_ROOT}`))).toEqual([])
    expect(parseGromzoPluginRows(row(5, 'node s.js', `CLAUDE_PLUGIN_ROOT=${GZ_ROOT} MXD_AGENT=Bad`))).toEqual([])
  })
})

describe('findGromzoOrphans', () => {
  it('only the plugins no live pane of ours holds: under pid 1, or under a detached claude', () => {
    const got = findGromzoOrphans(parseGromzoPluginRows(psEww()), procs(), live(), SERVER).map((o) => o.pid)
    expect(got).toEqual([ORPHAN_PID1, ORPHAN_UNDER_DETACHED])
  })

  it('spares another install\'s plugin (under its own tmux server)', () => {
    const got = findGromzoOrphans(parseGromzoPluginRows(psEww()), procs(), live(), SERVER).map((o) => o.pid)
    expect(got).not.toContain(FOREIGN_PLUGIN)
  })

  it('our server unknown (null): every tmux ancestor counts as foreign, so only what no server holds goes', () => {
    const got = findGromzoOrphans(parseGromzoPluginRows(psEww()), procs(), live(), null).map((o) => o.pid)
    expect(got).toEqual([ORPHAN_PID1])
  })

  it('no live pane resolved: nothing (fail-safe)', () => {
    expect(findGromzoOrphans(parseGromzoPluginRows(psEww()), procs(), new Set(), SERVER)).toEqual([])
  })

  it('a pid reused since the scan (its command no longer the gromzo plugin) is never signalled', () => {
    const reused = procs().map((p) => (p.pid === ORPHAN_PID1 ? { ...p, command: '/usr/bin/vim notes.txt' } : p))
    const got = findGromzoOrphans(parseGromzoPluginRows(psEww()), reused, live(), SERVER).map((o) => o.pid)
    expect(got).toEqual([ORPHAN_UNDER_DETACHED])
  })

  it('a pid gone since the scan, or a claude, is never signalled', () => {
    const rows = [{ pid: 4_200_000, agent: 'x' }, { pid: DETACHED_CLAUDE, agent: 'x' }]
    expect(findGromzoOrphans(rows, procs(), live(), SERVER)).toEqual([])
  })
})

describe('reapGromzoOrphans (handed snapshot, fake kill)', () => {
  const all = [LIVE_MAIN, LIVE_SUB, ORPHAN_PID1, ORPHAN_UNDER_DETACHED, INHERITED_NODE, FOREIGN_PLUGIN, OTHER_PLUGIN, CLAUDE_MAIN, CLAUDE_SUB, DETACHED_CLAUDE]

  it('signals exactly the two orphans', () => {
    const k = fakeKill(all)
    const got = reapGromzoOrphans({ psEww, procs, panePids: live, tmuxServerPid: () => SERVER, ownUid: 1000, ownerOf: () => 1000, kill: k.kill })
    expect(got.sort()).toEqual([ORPHAN_PID1, ORPHAN_UNDER_DETACHED].sort())
    expect(k.signalled.sort()).toEqual([ORPHAN_PID1, ORPHAN_UNDER_DETACHED].sort())
  })

  it('another user\'s orphan is not signalled', () => {
    const k = fakeKill(all)
    const got = reapGromzoOrphans({ psEww, procs, panePids: live, tmuxServerPid: () => SERVER, ownUid: 1000, ownerOf: (pid) => (pid === ORPHAN_PID1 ? 0 : 1000), kill: k.kill })
    expect(got).toEqual([ORPHAN_UNDER_DETACHED])
  })

  it('no live pane: no scan read, nothing signalled', () => {
    const k = fakeKill(all)
    let scanned = false
    expect(reapGromzoOrphans({ psEww: () => { scanned = true; return psEww() }, procs, panePids: () => new Set(), tmuxServerPid: () => SERVER, ownUid: 1000, ownerOf: () => 1000, kill: k.kill })).toEqual([])
    expect(scanned).toBe(false)
    expect(k.signalled).toEqual([])
  })
})

describe('a real process in the shape the host shows (macOS/Linux ps)', () => {
  let child: ChildProcess | null = null
  afterEach(() => { try { child?.kill('SIGKILL') } catch { /* gone */ } child = null })

  it('the env-scan row of a live gromzo-shaped node parses, and the reaper ends it when no pane holds it', async () => {
    // argv carries the plugin path, as the real plugin's does (node <root>/dist/server.js).
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', `${GZ_ROOT}/dist/server.js`], {
      env: { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: GZ_ROOT, MXD_AGENT: 'probe-gz', MXD_SCOPE: 'both' },
      stdio: 'ignore',
    })
    const pid = child.pid!
    await new Promise((r) => setTimeout(r, 300))
    // Only this child's row: the host's own processes are never in reach of the reaper here.
    const own = () => execFileSync('/bin/ps', ['eww', '-o', 'pid,command', '-p', String(pid)], { encoding: 'utf-8' })
    expect(parseGromzoPluginRows(own())).toEqual([{ pid, agent: 'probe-gz' }])
    const killed = reapGromzoOrphans({
      psEww: own,
      // The real ps row of the child (its command line), as snapshotProcs reads it; the parent made pid 1.
      procs: () => [{ pid, ppid: 1, command: execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' }).trim() }],
      panePids: () => new Set([4_300_000]), tmuxServerPid: () => 4_300_001, ownUid: process.getuid!(), ownerOf: () => process.getuid!(),
    })
    expect(killed).toEqual([pid])
    await new Promise((r) => setTimeout(r, 300))
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })
})

describe('the wiring', () => {
  it('every main respawn-pane schedules the sweep; the periodic, pre-launch and post-stop reaps run it', () => {
    const cm = readFileSync(join(ROOT, 'src', 'web', 'channel-monitor.ts'), 'utf-8')
    const respawns = cm.split("['respawn-pane', '-k', '-t', exactTmuxTarget(MAIN_CHANNELS_SESSION), claudeCmd]").length - 1
    expect(respawns).toBeGreaterThan(0)
    expect(cm.split("scheduleGromzoOrphanReap('main-respawn', tmuxBin())").length - 1).toBe(respawns)
    expect(cm).toContain("periodic reap removed orphaned gromzo-channel plugin(s)")
    const ap = readFileSync(join(ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')
    expect(ap).toContain("'pre-launch gromzo-orphan reap failed (continuing)'")
    expect(ap).toContain("'post-stop gromzo-orphan reap failed'")
    // The calls themselves, not only their log lines (Dani #2558 review): periodic 1, pre-launch + post-stop 2.
    const calls = (src: string) => src.split('\n').filter((l) => !l.trim().startsWith('//') && l.includes('reapGromzoOrphans({ tmuxPath: tmuxBin() })')).length
    expect(calls(cm)).toBe(1)
    expect(calls(ap)).toBe(2)
  })
})
