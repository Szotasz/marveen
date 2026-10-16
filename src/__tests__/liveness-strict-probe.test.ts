import { describe, expect, it, vi } from 'vitest'

// BOOTSTAGGER1007 (b), #1762 review: probeChannelPluginLiveness must hand its
// strictTree option to the decider. The decider is tested on its own
// (liveness-masking.test.ts); this pins the pass-through, on a fake `ps`.
// The other session's slack poller carries THIS process's pid: the default
// probe's machine-wide fallback checks that the pid is alive (kill(pid, 0)).
const OTHER_SLACK_PID = process.pid
const PS = [
  '  PID  PPID COMMAND',
  '  100     1 claude --channels plugin:telegram@claude-plugins-official plugin:slack-channel@marveen-marketplace',
  '  101   100 bun run --cwd /home/u/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 --shell=bun --silent start',
  '  200     1 claude --channels plugin:slack-channel@marveen-marketplace',
  `${String(OTHER_SLACK_PID).padStart(5)}   200 bun run --cwd /home/u/.claude/plugins/cache/marveen-marketplace/slack-channel/0.1.0 --silent start`,
].join('\n')

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    execFileSync: (cmd: string, args: string[], opts: unknown) =>
      cmd === '/bin/ps' ? PS : (real.execFileSync as unknown as (c: string, a: string[], o: unknown) => string)(cmd, args, opts),
  }
})

const { probeChannelPluginLiveness } = await import('../channel-coordinator/liveness.js')

describe('probeChannelPluginLiveness passes strictTree through', () => {
  it('the main claude has no slack child, another claude does: strict -> down', () => {
    expect(probeChannelPluginLiveness(100, 'slack', undefined, { strictTree: true })).toBe('down')
  })
  it('...and the default probe keeps its machine-wide answer (unchanged)', () => {
    expect(probeChannelPluginLiveness(100, 'slack')).toBe('alive')
  })
  it('the primary under the same claude is alive either way', () => {
    expect(probeChannelPluginLiveness(100, 'telegram', undefined, { strictTree: true })).toBe('alive')
  })
})
