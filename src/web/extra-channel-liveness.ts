/**
 * Resume verification for co-listen channels (AGENTEXTRACH1006).
 *
 * A resumed (--continue) launch is only kept when every channel plugin comes
 * back; otherwise the agent is relaunched fresh (channel-continue-policy.ts,
 * condition 3). For the extras this needs a STRICTER probe than
 * probeChannelPluginLiveness: for slack (and discord) that probe also accepts
 * ANY matching poller anywhere on the host, which is right for a reparented
 * plugin but wrong here -- the main agent co-listens on Slack too, so its
 * poller would make every sub-agent's dead extra look alive. Here only the
 * resumed claude's own process tree counts.
 */
import { execFileSync } from 'node:child_process'
import type { ChannelProviderType } from '../channel-provider.js'
import { matchesProviderPollerCmd } from '../channel-coordinator/provider-poller-match.js'
import { snapshotProcsWithRetry, type PluginLiveness } from '../channel-coordinator/liveness.js'

/** Pure: is a poller for `provider` in the process tree under `claudePid`? `ps -o pid,ppid,command` output, header included. */
export function pluginInTree(psOutput: string, claudePid: number, provider: ChannelProviderType): boolean {
  const childrenOf = new Map<number, number[]>()
  const cmdOf = new Map<number, string>()
  for (const line of psOutput.split('\n').slice(1)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = parseInt(m[1], 10)
    const ppid = parseInt(m[2], 10)
    cmdOf.set(pid, m[3])
    const arr = childrenOf.get(ppid) ?? []
    arr.push(pid)
    childrenOf.set(ppid, arr)
  }
  const stack = [claudePid]
  const seen = new Set<number>()
  while (stack.length) {
    const p = stack.pop()!
    if (seen.has(p)) continue
    seen.add(p)
    if (p !== claudePid && matchesProviderPollerCmd(cmdOf.get(p) ?? '', provider)) return true
    for (const k of childrenOf.get(p) ?? []) stack.push(k)
  }
  return false
}

/** Every verdict 'alive' -> 'alive'; any 'down' -> 'down'; otherwise 'unknown'. */
export function combineLiveness(verdicts: readonly PluginLiveness[]): PluginLiveness {
  if (verdicts.every(v => v === 'alive')) return 'alive'
  if (verdicts.some(v => v === 'down')) return 'down'
  return 'unknown'
}

/** All extras alive under `claudePid`? A failed ps is 'unknown', never 'down'. */
export function probeExtraPluginsInTree(claudePid: number, providers: readonly ChannelProviderType[]): PluginLiveness {
  if (providers.length === 0) return 'alive'
  let ps: string
  try {
    ps = snapshotProcsWithRetry((timeoutMs) =>
      execFileSync('/bin/ps', ['-axww', '-o', 'pid,ppid,command'], { timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 }),
    )
  } catch {
    return 'unknown'
  }
  return combineLiveness(providers.map(p => (pluginInTree(ps, claudePid, p) ? 'alive' : 'down')))
}
