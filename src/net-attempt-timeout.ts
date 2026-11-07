// Node's Happy Eyeballs (autoSelectFamily, on by default since Node 20) gives each
// connection attempt 250 ms before it moves to the next address. On a slow or lossy
// uplink a healthy host regularly needs longer than that to answer the SYN, so the
// dashboard's pollers fail with "fetch failed" / ETIMEDOUT where curl, with its
// whole-connect budget, succeeds against the same host in the same minute.
//
// Measured on one install (Mac mini behind double NAT, 2026-09-29): 9.0% (35/389) of
// curl connects took longer than 250 ms; the uptime poller's monitoring.googleapis.com
// calls failed 9.2% in the busy hours against 4.3% for curl on the same hosts. With
// the per-attempt timeout at 2500 ms the Node excess went away (7.4% vs 9.2% for curl
// on a worse network day): what is left is the network, not Node.
//
// Applied at startup, before anything opens a socket. An explicit
// --network-family-autoselection-attempt-timeout in NODE_OPTIONS wins, and
// MARVEEN_NET_ATTEMPT_TIMEOUT_MS overrides the default (0 = leave Node's own value).
import net from 'node:net'

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 2500

export type AttemptTimeoutResult =
  | { applied: true; ms: number; previous: number }
  | { applied: false; reason: 'node-options' | 'disabled' | 'already-higher' | 'invalid-env'; current: number }

type NetLike = Pick<typeof net, 'getDefaultAutoSelectFamilyAttemptTimeout' | 'setDefaultAutoSelectFamilyAttemptTimeout'>

export function applyNetAttemptTimeout(
  env: NodeJS.ProcessEnv = process.env,
  netMod: NetLike = net,
): AttemptTimeoutResult {
  const current = netMod.getDefaultAutoSelectFamilyAttemptTimeout()
  if ((env.NODE_OPTIONS ?? '').includes('--network-family-autoselection-attempt-timeout')) {
    return { applied: false, reason: 'node-options', current }
  }
  let ms = DEFAULT_ATTEMPT_TIMEOUT_MS
  const raw = env.MARVEEN_NET_ATTEMPT_TIMEOUT_MS
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) return { applied: false, reason: 'invalid-env', current }
    if (n === 0) return { applied: false, reason: 'disabled', current }
    ms = n
  }
  if (current >= ms) return { applied: false, reason: 'already-higher', current }
  netMod.setDefaultAutoSelectFamilyAttemptTimeout(ms)
  return { applied: true, ms, previous: current }
}

export const netAttemptTimeoutAtStartup = applyNetAttemptTimeout()
