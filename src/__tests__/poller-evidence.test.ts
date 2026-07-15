// The watchdog's "channel plugin down" verdict destroyed its own evidence: the
// restart reaps the poller and respawns the session, so a post-mortem can never
// tell whether the plugin died or the liveness probe merely lost a live one.
// buildPollerEvidence is the snapshot taken at the moment the verdict forms.
import { describe, it, expect } from 'vitest'
import { buildPollerEvidence, type ProcRow } from '../web/channel-poller-reap.js'

const CLAUDE = 100

// claude(100) -> bun run wrapper(200) -> bun server.ts(300): the healthy shape.
const healthyTree: ProcRow[] = [
  { pid: CLAUDE, ppid: 1, command: 'claude --channels plugin:telegram' },
  { pid: 200, ppid: CLAUDE, command: 'bun run --cwd /plugins/telegram start' },
  { pid: 300, ppid: 200, command: 'bun server.ts' },
]

describe('buildPollerEvidence', () => {
  it('reads a live in-tree poller as the PROBE being wrong, not the plugin', () => {
    const e = buildPollerEvidence(healthyTree, 300, [200, 300], CLAUDE)
    expect(e.interpretation).toBe('in-tree')
    expect(e.botPidAlive).toBe(true)
    expect(e.rows.find((r) => r.pid === 300)?.inClaudeTree).toBe(true)
  })

  it('reads a live poller outside the tree as orphaned (reparented / previous claude)', () => {
    const procs: ProcRow[] = [
      { pid: CLAUDE, ppid: 1, command: 'claude --channels plugin:telegram' },
      // Reparented to init: its ancestor chain never reaches claude.
      { pid: 300, ppid: 1, command: 'bun server.ts' },
    ]
    const e = buildPollerEvidence(procs, null, [300], CLAUDE)
    expect(e.interpretation).toBe('orphaned')
    expect(e.rows).toEqual([{ pid: 300, ppid: 1, inClaudeTree: false }])
  })

  it('reads no live poller as the plugin genuinely having exited', () => {
    const procs: ProcRow[] = [{ pid: CLAUDE, ppid: 1, command: 'claude --channels plugin:telegram' }]
    // bot.pid still names a pid, but that pid is not in the ps snapshot.
    const e = buildPollerEvidence(procs, 300, [], CLAUDE)
    expect(e.interpretation).toBe('no-poller')
    expect(e.botPid).toBe(300)
    expect(e.botPidAlive).toBe(false)
    expect(e.rows).toEqual([])
  })

  it('counts a poller reached through the wrapper as in-tree (grandchild, not child)', () => {
    const e = buildPollerEvidence(healthyTree, null, [300], CLAUDE)
    expect(e.rows).toEqual([{ pid: 300, ppid: 200, inClaudeTree: true }])
    expect(e.interpretation).toBe('in-tree')
  })

  it('merges the bot.pid candidate with the env-scan candidates without duplicating', () => {
    const e = buildPollerEvidence(healthyTree, 300, [300], CLAUDE)
    expect(e.rows.map((r) => r.pid)).toEqual([300])
  })

  it('does not hang on a parent cycle in the ps snapshot', () => {
    const procs: ProcRow[] = [
      { pid: 300, ppid: 301, command: 'bun server.ts' },
      { pid: 301, ppid: 300, command: 'weird' },
    ]
    const e = buildPollerEvidence(procs, null, [300], CLAUDE)
    expect(e.interpretation).toBe('orphaned')
  })
})
