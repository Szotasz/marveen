import type http from 'node:http'

// Shared shape every route handler in this folder consumes. The dispatcher in
// src/web.ts builds it once per request and walks each module's tryHandle*
// function. A handler returns true once it has written a response, false to
// let the next module try.
export interface RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  path: string
  method: string
  url: URL
  /** Federation caller identity, set by the auth gate when a peer's inbound
   *  token authenticated this request. Absent/undefined and null both mean
   *  "not a federation-token caller" (e.g. dashboard token) -- handlers must
   *  treat the two identically. */
  fedPeer?: string | null
  /** Resolved auth principal for this request, set by the gate. Absent means
   *  the request carried no valid credential (only possible on ungated public
   *  paths, which are reached without a principal). `user` is set for the
   *  'session' kind; `peer` mirrors fedPeer for the 'federation' kind;
   *  `device` is the key name for the 'device' kind. `claimedAgent` is the
   *  caller's SELF-ASSERTED fleet-agent id (X-Agent-Id, shared 'token' kind
   *  only): validated against the roster but NOT authenticated -- one shared
   *  token means it can be typed by anyone, so it may warn and attribute,
   *  never authorize. Lets routes distinguish a human session from a
   *  token/fleet caller or an enrolled device. */
  auth?: { kind: 'token' | 'session' | 'federation' | 'device'; user?: string; peer?: string; device?: string; deviceId?: number; scope?: 'full' | 'operator'
    /** Set only for kind 'token' when the bearer was a sub-agent's own token
     *  (agents/<name>/.dashboard-token). Absent means the shared/main token.
     *  AUTHENTICATED (unlike claimedAgent): by the time a route runs, the gate
     *  (auth-gate.ts gateRequest) has (1) confined this principal to
     *  AGENT_TOKEN_ALLOWLIST, (2) refused its schedule writes, and (3) checked
     *  AGENT_IDENTITY_BINDINGS: every identity the request asserts equals this
     *  name, no owner-lane field is present, and the edited row EXISTED and
     *  belonged to this name when the gate looked (after the body was read).
     *  That lookup is a pre-check, not a lock: a route whose write must stay
     *  bound to the caller enforces it in the write itself, as PUT
     *  /api/messages/:id does with closeMessageAsRecipient. A route that scopes
     *  by agent keys off THIS field, never off the self-asserted claim. */
    agent?: string
    /** Self-asserted X-Agent-Id on the SHARED token lane: advisory only, never
     *  a credential, never the basis of a restriction or an authorization. */
    claimedAgent?: string }
}

export type RouteHandler = (ctx: RouteContext) => Promise<boolean>
