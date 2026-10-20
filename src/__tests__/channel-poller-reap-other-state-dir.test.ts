// Guard 5 of selectReapablePollers ('other-state-dir'): a stale bot.pid whose
// pid the kernel has since given to ANOTHER agent's live poller of the same
// provider. The plugin-root marker matches (same plugin, same cache dir), so
// before this guard the reaper of one agent stopped the other agent's channel.
// The snapshot below is the shape of a live host: two agents on the same
// telegram plugin, each fenced to its own state dir, and agent-a's previous
// poller pair orphaned under init. The reaper runs with fixed seams: no real
// process, tmux server or signal is touched.
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  carriesOtherStateDir,
  parseStateDirPollerPids,
  reapChannelOrphans,
  selectReapablePollers,
  type ProcRow,
} from '../web/channel-poller-reap.js'
import { channelStateDir } from '../channel-provider.js'

const tmp = mkdtempSync(join(tmpdir(), 'reap-other-dir-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const AGENT_A = join(tmp, 'agents', 'agent-a')
const AGENT_B = join(tmp, 'agents', 'agent-b')
const D_A = channelStateDir('telegram', AGENT_A)
const D_B = channelStateDir('telegram', AGENT_B)
// an install under a path with a space (review of #2000): the env scan anchors
// `<envVar>=<chanDir>` up to whitespace or end of line, so it finds these rows
const AGENT_S = join(tmp, 'My Projects', 'agents', 'agent-s')
const D_S = channelStateDir('telegram', AGENT_S)
mkdirSync(D_A, { recursive: true })
mkdirSync(D_B, { recursive: true })
mkdirSync(D_S, { recursive: true })

const ROOT = 'CLAUDE_PLUGIN_ROOT=/home/u/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7'
const LAUNCHER = 'bun run --cwd /home/u/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7 --shell=bun --silent start'
const SERVER = '/home/u/.bun/bin/bun server.ts'

interface Row { pid: number; ppid: number; argv: string; env: string }
const ROWS: Row[] = [
  { pid: 1, ppid: 0, argv: '/sbin/init', env: '' },
  { pid: 500, ppid: 1, argv: 'tmux new-session -d -s agent-b', env: 'HOME=/home/u' },
  // agent-b: live session, fenced to its own state dir
  { pid: 2000, ppid: 500, argv: 'sh -c exec claude --channels plugin:telegram@claude-plugins-official', env: `TELEGRAM_STATE_DIR=${D_B}` },
  { pid: 2001, ppid: 2000, argv: '/home/u/.local/bin/claude --channels plugin:telegram@claude-plugins-official', env: `TELEGRAM_STATE_DIR=${D_B}` },
  { pid: 2002, ppid: 2001, argv: LAUNCHER, env: `TELEGRAM_STATE_DIR=${D_B} ${ROOT}` },
  { pid: 2003, ppid: 2002, argv: SERVER, env: `TELEGRAM_STATE_DIR=${D_B} ${ROOT}` },
  // agent-a: its session is gone, its previous poller pair is orphaned
  { pid: 3100, ppid: 1, argv: LAUNCHER, env: `TELEGRAM_STATE_DIR=${D_A} ${ROOT}` },
  { pid: 3101, ppid: 3100, argv: SERVER, env: `TELEGRAM_STATE_DIR=${D_A} ${ROOT}` },
  // a plugin poller on its built-in default dir (no state-dir value), orphaned
  { pid: 3200, ppid: 1, argv: SERVER, env: `HOME=/home/u ${ROOT}` },
  // agent-s (state dir with a space): its session is gone, its poller pair is orphaned
  { pid: 3300, ppid: 1, argv: LAUNCHER, env: `TELEGRAM_STATE_DIR=${D_S} ${ROOT}` },
  { pid: 3301, ppid: 3300, argv: SERVER, env: `TELEGRAM_STATE_DIR=${D_S} ${ROOT}` },
]
const PANES = new Set([2000])
const psEww = ROWS.map((r) => `${String(r.pid).padStart(6)} ?        S      0:00 ${r.argv} ${r.env}`).join('\n')
const procs: ProcRow[] = ROWS.map((r) => ({ pid: r.pid, ppid: r.ppid, command: r.argv }))

function reapAgentA(botPid: number) {
  return reapAgent(AGENT_A, D_A, botPid)
}

function reapAgent(agentDir: string, stateDir: string, botPid: number) {
  writeFileSync(join(stateDir, 'bot.pid'), String(botPid))
  const signalled = new Set<number>()
  const gone = new Set<number>()
  const r = reapChannelOrphans('telegram', agentDir, {
    psEww: () => psEww,
    procs: () => procs,
    panePids: () => PANES,
    tmuxServerPid: () => 500,
    ownUid: 1000,
    ownerOf: () => 1000,
    kill: (pid, sig) => {
      if (gone.has(pid)) { const e = new Error('ESRCH') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e }
      if (sig !== 0) { signalled.add(pid); gone.add(pid) }
    },
  })
  return { r, signalled: [...signalled].sort((a, b) => a - b) }
}

describe('carriesOtherStateDir', () => {
  it('is true only for a row whose state-dir value is another dir', () => {
    expect(carriesOtherStateDir(psEww, 2003, 'TELEGRAM_STATE_DIR', D_A)).toBe(true)
    expect(carriesOtherStateDir(psEww, 3101, 'TELEGRAM_STATE_DIR', D_A)).toBe(false) // this dir
    expect(carriesOtherStateDir(psEww, 3200, 'TELEGRAM_STATE_DIR', D_A)).toBe(false) // no value
    expect(carriesOtherStateDir(psEww, 9999, 'TELEGRAM_STATE_DIR', D_A)).toBe(false) // not in the snapshot
    // a longer path with this dir as its prefix is another dir
    const ps = `  77 ?  S  0:00 bun server.ts TELEGRAM_STATE_DIR=${D_A}-old ${ROOT}`
    expect(carriesOtherStateDir(ps, 77, 'TELEGRAM_STATE_DIR', D_A)).toBe(true)
    // another provider's variable does not count
    const slack = `  78 ?  S  0:00 bun server.ts SLACK_STATE_DIR=${D_B} ${ROOT}`
    expect(carriesOtherStateDir(slack, 78, 'TELEGRAM_STATE_DIR', D_A)).toBe(false)
  })

  it('a state dir with a space in its path is this dir, not another one', () => {
    expect(D_S).toContain(' ')
    expect(parseStateDirPollerPids(psEww, 'TELEGRAM_STATE_DIR', D_S, '/telegram')).toEqual([3300, 3301])
    expect(carriesOtherStateDir(psEww, 3301, 'TELEGRAM_STATE_DIR', D_S)).toBe(false)
    expect(carriesOtherStateDir(psEww, 3300, 'TELEGRAM_STATE_DIR', D_S)).toBe(false)
    // seen from the other side, both directions are still another dir
    expect(carriesOtherStateDir(psEww, 2003, 'TELEGRAM_STATE_DIR', D_S)).toBe(true)
    expect(carriesOtherStateDir(psEww, 3301, 'TELEGRAM_STATE_DIR', D_A)).toBe(true)
    // a longer path with the spaced dir as its prefix is another dir
    const ps = `  79 ?  S  0:00 bun server.ts TELEGRAM_STATE_DIR=${D_S}-old ${ROOT}`
    expect(carriesOtherStateDir(ps, 79, 'TELEGRAM_STATE_DIR', D_S)).toBe(true)
  })
})

describe("selectReapablePollers: guard 5, 'other-state-dir'", () => {
  it('spares a bot.pid holder that runs for another state dir', () => {
    const { reap, spared } = selectReapablePollers([2003, 3101, 3100], procs, PANES, 2003, new Set([2003]))
    expect(reap).toEqual([3101, 3100])
    expect(spared).toEqual([{ pid: 2003, reason: 'other-state-dir' }])
  })
})

describe('reapChannelOrphans: a recycled bot.pid never stops another agent', () => {
  it("agent-a's stale bot.pid names agent-b's live poller: agent-b lives, agent-a's orphans go", () => {
    const { r, signalled } = reapAgentA(2003)
    expect(signalled).not.toContain(2003)
    expect(r.reaped).not.toContain(2003)
    expect(signalled).toEqual([3100, 3101])
  })

  it("bot.pid naming agent-a's own orphan poller is still reaped", () => {
    const { signalled } = reapAgentA(3101)
    expect(signalled).toEqual([3100, 3101])
  })

  it('bot.pid naming a plugin poller with no state-dir value is still reaped (unchanged)', () => {
    const { signalled } = reapAgentA(3200)
    expect(signalled).toEqual([3100, 3101, 3200])
  })
})

describe('reapChannelOrphans: a state dir with a space in its path', () => {
  it('own orphans found by the env scan are reaped (bot.pid names nothing live)', () => {
    const { r, signalled } = reapAgent(AGENT_S, D_S, 999999)
    expect(r.source.fromEnvScan).toEqual([3300, 3301])
    expect(signalled).toEqual([3300, 3301])
  })

  it('a bot.pid holder that is its own orphan poller is reaped', () => {
    const { r, signalled } = reapAgent(AGENT_S, D_S, 3301)
    expect(r.source.fromBotPid).toBe(3301)
    expect(signalled).toEqual([3300, 3301])
  })

  it("a bot.pid holder that is another agent's live poller is spared, own orphans still go", () => {
    const { r, signalled } = reapAgent(AGENT_S, D_S, 2003)
    expect(r.source.fromBotPid).toBe(2003)
    expect(signalled).toEqual([3300, 3301])
  })
})
