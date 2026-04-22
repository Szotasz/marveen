// Trust-graph decision for inter-agent messages.
//
// The router asks isTrustedPeer() for every pending message and picks one
// of two wrappers accordingly:
//
//   trusted  →  <trusted-peer> + TRUSTED_PEER_PREAMBLE   (coworker exchange)
//   not      →  <untrusted>    + UNTRUSTED_PREAMBLE      (external / unknown)
//
// The rules are symmetric -- if either end of the pair acknowledges the
// relation (reportsTo, delegatesTo, explicit trustFrom override), both
// sides treat each other as trusted. Asymmetric cases (a reviewer who
// should receive but not issue instructions) are covered by the
// TRUSTED_PEER_PREAMBLE's "judge on merits, escalate if destructive"
// wording rather than a trust-gate; pushing asymmetry into the graph
// itself is a V3.1+ concern.
//
// This module deliberately takes its fs / config dependencies as a
// TrustContext argument instead of importing web.ts helpers directly.
// That keeps the decision logic pure, synchronously testable with
// fake context objects, and free of the top-level side effects that
// loading web.ts would trigger.

export interface TeamConfigForTrust {
  reportsTo: string | null
  delegatesTo: string[]
  trustFrom?: string[]
}

export interface TrustContext {
  mainAgentId: string
  isKnownAgent(name: string): boolean
  readAgentTeam(name: string): TeamConfigForTrust
}

/**
 * Decide whether an inter-agent message should be wrapped as a trusted
 * peer exchange (<trusted-peer>) rather than untrusted content (<untrusted>).
 *
 * Rules, checked in order:
 *   1. Self-loop (from === to) → false.
 *   2. Either name empty → false.
 *   3. Either name not a known agent → false.
 *      (MUST run before the MAIN shortcut, otherwise a spoofed unknown
 *      `from` targeting MAIN would pass.)
 *   4. Either end is the main agent → true (main is implicit peer of all).
 *   5. Any of these holds between the team configs:
 *        - fromTeam.reportsTo === to  (to is from's leader)
 *        - toTeam.reportsTo === from  (from is to's leader)
 *        - to ∈ fromTeam.delegatesTo  (from explicitly delegates to to)
 *        - from ∈ toTeam.delegatesTo  (to explicitly delegates to from)
 *        - to ∈ fromTeam.trustFrom    (explicit override)
 *        - from ∈ toTeam.trustFrom    (explicit override)
 *   6. Otherwise → false.
 */
export function isTrustedPeer(from: string, to: string, ctx: TrustContext): boolean {
  if (!from || !to) return false
  if (from === to) return false

  // Known-agent check BEFORE main shortcut: a spoofed unknown sender
  // targeting MAIN would otherwise be trusted.
  if (!ctx.isKnownAgent(from) || !ctx.isKnownAgent(to)) return false

  if (from === ctx.mainAgentId || to === ctx.mainAgentId) return true

  const fromTeam = ctx.readAgentTeam(from)
  const toTeam = ctx.readAgentTeam(to)

  if (fromTeam.reportsTo === to) return true
  if (toTeam.reportsTo === from) return true
  if (fromTeam.delegatesTo.includes(to)) return true
  if (toTeam.delegatesTo.includes(from)) return true
  if ((fromTeam.trustFrom ?? []).includes(to)) return true
  if ((toTeam.trustFrom ?? []).includes(from)) return true

  return false
}
