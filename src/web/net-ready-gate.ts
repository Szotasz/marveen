// Network-readiness gate for the reconcile auto-start (HALOZATELOTT923).
//
// MEASURED 2026-09-22 19:47, after a host restart. The reconcile loop started
// the desired agents 15s apart, beginning before the host's DNS was answering.
// The first three (designer 19:47:33, futoedzo 19:47:49, googledev 19:48:04)
// came up with ZERO external MCP servers; the three started from 19:48:22 got
// all of theirs. From the per-server logs under
// ~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-<server>/:
//
//   strava        getaddrinfo ENOTFOUND mcp.strava.com  (and the token refresh
//                 failed the same way on www.strava.com)
//   google-drive  connection timed out after 60000ms   (npx could not reach the
//   gmail         registry)
//
// Claude Code does not retry a server that failed at session start, and nothing
// surfaces the loss: the agent simply has no such tool. Fabio therefore told the
// owner he had no Strava access, which reads as an expired login and is not one.
// The session stays crippled until it is restarted, which is the actual repair.
//
// So: hold the burst until the network answers. The gate is a DEFERRAL, never a
// veto. A host that is genuinely offline must still get its fleet up, so after
// MAX_WAIT_MS the gate fails open and starts the agents anyway, with a warning.
// Once the network has answered once, the gate latches open and never probes
// again -- this is a boot-ordering race, not a link monitor.
//
// The decision is pure and lives here so it can be tested without DNS.

/** Hosts every agent needs on its first seconds: the npm registry (stdio MCP
 *  servers are `npx -y ...`) and the API the session itself talks to. Either one
 *  answering is enough -- we are detecting "DNS is up", not reachability. */
export const NET_CANARY_HOSTS = ['registry.npmjs.org', 'api.anthropic.com'] as const

/** How long the gate may hold the fleet down before it gives up and starts
 *  anyway. Five minutes is far past the ~50s the measured case needed, and far
 *  short of a human noticing an empty fleet. */
export const NET_GATE_MAX_WAIT_MS = 5 * 60 * 1000

/** Per-probe DNS timeout. Short: a wedged resolver must not stall the tick. */
export const NET_PROBE_TIMEOUT_MS = 3000

export interface NetGateState {
  /** Latched once the network has answered. Never goes back to false. */
  ready: boolean
  /** When the gate first saw a dead network, or null if it has not yet. */
  firstFailureAt: number | null
  /** Whether the "waiting" line has already been logged for this outage. */
  warned: boolean
}

export function newNetGateState(): NetGateState {
  return { ready: false, firstFailureAt: null, warned: false }
}

export type NetGateReason =
  /** The network answered on this tick. */
  | 'ready'
  /** It answered on an earlier tick; the gate no longer probes. */
  | 'latched'
  /** Dead network, still inside the wait window -- defer the burst. */
  | 'waiting'
  /** Dead network past the wait window -- fail open and start anyway. */
  | 'timed-out'

export interface NetGateDecision {
  allow: boolean
  reason: NetGateReason
  /** True only on the first deferred tick of an outage, so the caller logs once. */
  logWaiting: boolean
  /** Milliseconds the burst has been held back (0 when allowed on a live net). */
  waitedMs: number
}

/** Decide whether a reconcile burst may start agents. Mutates `state`: the latch
 *  and the outage start have to survive across ticks, and the caller holds the
 *  only copy. `resolved` is the outcome of probeNetwork(). */
export function decideNetGate(state: NetGateState, resolved: boolean, now: number): NetGateDecision {
  if (state.ready) return { allow: true, reason: 'latched', logWaiting: false, waitedMs: 0 }

  if (resolved) {
    const waitedMs = state.firstFailureAt === null ? 0 : Math.max(0, now - state.firstFailureAt)
    state.ready = true
    state.firstFailureAt = null
    state.warned = false
    return { allow: true, reason: 'ready', logWaiting: false, waitedMs }
  }

  if (state.firstFailureAt === null) state.firstFailureAt = now
  const waitedMs = Math.max(0, now - state.firstFailureAt)

  if (waitedMs >= NET_GATE_MAX_WAIT_MS) {
    // Fail open. Do NOT latch: the next boot deserves the same gate, and a
    // network that comes up later should still be reported as 'ready'.
    return { allow: true, reason: 'timed-out', logWaiting: false, waitedMs }
  }

  const logWaiting = !state.warned
  state.warned = true
  return { allow: false, reason: 'waiting', logWaiting, waitedMs }
}

/** Resolve a canary host. True as soon as ONE answers. Any error, and any host
 *  that outruns NET_PROBE_TIMEOUT_MS, counts as "not yet". */
export async function probeNetwork(
  hosts: readonly string[] = NET_CANARY_HOSTS,
  timeoutMs: number = NET_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const { lookup } = await import('node:dns/promises')
  const withTimeout = (host: string): Promise<boolean> =>
    Promise.race([
      lookup(host).then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref?.()),
    ])
  const results = await Promise.all(hosts.map(withTimeout))
  return results.some(Boolean)
}
