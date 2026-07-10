// Outbound federation bridge: POST one pending qualified message to its peer.
//
// Error model (the status-class policy the router relies on):
//   2xx (202)          -> delivered  (remote id recorded in `result`)
//   401 from the peer  -> retry      (round 2: a rotated/stale token must NOT
//                                     burn the whole queue -- the owner gets
//                                     the abandon window to paste the new
//                                     token; backoff keeps the probing gentle)
//   other 4xx          -> failed     (terminal: unknown recipient, loop guard,
//                                     size cap... retrying cannot help)
//   5xx/network/timeout-> retry      (row stays pending, next tick)
//   peer in backoff    -> skipped    (no network attempt at all)
//   empty outboundToken-> failed     (pairing incomplete: nothing to present)
//
// Per-PEER backoff (circuit breaker): one failing peer must not be hammered at
// 12 attempts/min per message, and -- because the router tick is serialized --
// must not stall local delivery either. While a peer is backing off, its
// messages are skipped without a fetch. Success clears the state.
//
// Delivery semantics are send-then-mark: a crash between the peer's 202 and
// markMessageDelivered re-sends on restart. The RECEIVER's ref-dedup absorbs
// that (at-least-once + best-effort dedup); a durable dedup column is phase 2.
import { logger } from '../../logger.js'
import type { AgentMessage } from '../../db.js'
import { getFederationConfig, FEDERATION_MIN_TOKEN_LENGTH, type FederationPeer } from './config.js'
import { parseQualifiedId } from './address.js'
import { readBoundedBody } from './http.js'

// Peer inbox replies are tiny JSON ({id, ref}); anything bigger is broken or
// hostile. Bounded read -- see http.ts for why unbounded reads are an OOM
// vector.
const INBOX_REPLY_MAX_BYTES = 16 * 1024

export const FEDERATION_REQUEST_TIMEOUT_MS = 5000
// Keep comfortably under the receiver's 64KB whole-envelope inbox cap: an
// oversized POST would not even get a readable 413 back (readBody destroys
// the socket mid-request), so it must never leave this side.
export const FEDERATION_MAX_CONTENT_BYTES = 60 * 1024
// 10s, 20s, 40s, 80s, 160s, then capped at 5 minutes.
const BACKOFF_BASE_MS = 10_000
const BACKOFF_MAX_MS = 5 * 60_000

export type BridgeSendResult =
  | { kind: 'delivered'; remoteId: string }
  | { kind: 'failed'; error: string }
  | { kind: 'retry'; error: string }
  | { kind: 'skipped' }

interface PeerBackoffState {
  failures: number
  nextAttemptAt: number
}

const peerBackoff = new Map<string, PeerBackoffState>()

export function isPeerInBackoff(peerId: string, now: number): boolean {
  const st = peerBackoff.get(peerId)
  return !!st && now < st.nextAttemptAt
}

function noteFailure(peerId: string, now: number): void {
  const st = peerBackoff.get(peerId) ?? { failures: 0, nextAttemptAt: 0 }
  st.failures += 1
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (st.failures - 1), BACKOFF_MAX_MS)
  st.nextAttemptAt = now + delay
  peerBackoff.set(peerId, st)
}

function noteSuccess(peerId: string): void {
  peerBackoff.delete(peerId)
}

/** Production reset for the disable/removal lifecycle paths: a re-enabled or
 *  re-added peer must not inherit an escalated failure count. Omit peerId to
 *  clear everything. */
export function resetPeerBackoff(peerId?: string): void {
  if (peerId === undefined) peerBackoff.clear()
  else peerBackoff.delete(peerId)
}

/** Test seam. */
export function _resetBackoffForTest(): void {
  peerBackoff.clear()
}

function truncate(s: string, max = 300): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * Send one qualified pending message to its peer. Pure-ish: all config comes
 * from getFederationConfig(), the HTTP client is injectable for tests.
 */
export async function sendFederatedMessage(
  msg: Pick<AgentMessage, 'id' | 'from_agent' | 'to_agent' | 'content'>,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<BridgeSendResult> {
  const target = parseQualifiedId(msg.to_agent)
  if (!target) return { kind: 'failed', error: `Invalid federated address: ${truncate(msg.to_agent, 80)}` }

  const cfg = getFederationConfig()
  if (!cfg.enabled) return { kind: 'failed', error: 'Federation is disabled on this system' }
  // Ids are case-insensitive (stored lowercase); a row created before the
  // normalization -- or via a direct createAgentMessage call -- may still
  // carry an uppercase system segment, so fold here too.
  const targetSystem = target.system.toLowerCase()
  if (targetSystem === cfg.systemId) {
    return { kind: 'failed', error: `Address system '${target.system}' is this system -- use the local agent id` }
  }
  const peer: FederationPeer | undefined = cfg.peers.find((p) => p.id === targetSystem)
  if (!peer) return { kind: 'failed', error: `Unknown federation peer '${target.system}'` }
  if (!peer.outboundToken || peer.outboundToken.length < FEDERATION_MIN_TOKEN_LENGTH) {
    return { kind: 'failed', error: `Pairing incomplete for peer '${peer.id}': no outbound token configured yet` }
  }

  // The stored from_agent is local (slash-free -- POST /api/messages rejects
  // qualified froms); qualify it on the wire so the receiver sees the origin.
  if (msg.from_agent.includes('/')) {
    return { kind: 'failed', error: 'Refusing to forward a message whose sender is already qualified' }
  }
  if (Buffer.byteLength(msg.content, 'utf8') > FEDERATION_MAX_CONTENT_BYTES) {
    return { kind: 'failed', error: `Message content exceeds the federation limit (${FEDERATION_MAX_CONTENT_BYTES} bytes)` }
  }

  if (isPeerInBackoff(peer.id, now)) return { kind: 'skipped' }

  let res: Response
  try {
    res = await fetchImpl(`${peer.baseUrl}/api/federation/inbox`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${peer.outboundToken}`,
      },
      body: JSON.stringify({
        federationVersion: 1,
        from: `${cfg.systemId}/${msg.from_agent}`,
        to: target.agent,
        content: msg.content,
        ref: String(msg.id),
      }),
      signal: AbortSignal.timeout(FEDERATION_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    noteFailure(peer.id, now)
    return { kind: 'retry', error: `Peer '${peer.id}' unreachable: ${truncate(String(err))}` }
  }

  let bodyText = ''
  try { bodyText = await readBoundedBody(res, INBOX_REPLY_MAX_BYTES) } catch { /* body is best-effort for diagnostics */ }

  if (res.ok) {
    noteSuccess(peer.id)
    let remoteId = ''
    try { remoteId = String(JSON.parse(bodyText).id ?? '') } catch { /* non-JSON 2xx still counts */ }
    return { kind: 'delivered', remoteId }
  }
  if (res.status === 401) {
    // Stale/rotated token: retryable ON PURPOSE. Terminal would burn the
    // entire queued backlog within minutes of a token rotation; retry +
    // backoff + the abandon window give the owner time to paste the new one.
    noteFailure(peer.id, now)
    return { kind: 'retry', error: `Peer '${peer.id}' rejected our token (401) -- outbound token stale or rotated` }
  }
  if (res.status >= 400 && res.status < 500) {
    // A rejection is an answer -- the peer is alive. No backoff.
    noteSuccess(peer.id)
    return { kind: 'failed', error: `Peer '${peer.id}' rejected (${res.status}): ${truncate(bodyText)}` }
  }
  noteFailure(peer.id, now)
  return { kind: 'retry', error: `Peer '${peer.id}' error (${res.status}): ${truncate(bodyText)}` }
}

/** Structured-log helper: peer-controlled strings stay in the fields object,
 *  never interpolated into the msg string (log-forgery guard). */
export function logFedOut(fields: Record<string, unknown>, msg: string): void {
  logger.info({ fedOut: true, ...fields }, msg)
}
