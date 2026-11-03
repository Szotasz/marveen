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
   *  `device` is the key name for the 'device' kind. `agent` is the caller's
   *  SELF-ASSERTED fleet-agent id (X-Agent-Id, 'token' kind only): validated
   *  against the roster but NOT authenticated -- one shared token means it can
   *  be typed by anyone, so it may warn and attribute, never authorize.
   *  Lets routes distinguish a human session from a token/fleet caller. */
  auth?: { kind: 'token' | 'session' | 'federation' | 'device'; user?: string; peer?: string; device?: string; deviceId?: number; agent?: string; scope?: 'full' | 'operator'
    /** Set only for kind 'token' when the bearer was a sub-agent's OWN token
     *  (agents/<name>/.dashboard-token, AGENT_TOKENS; `agent` then carries the
     *  same name). AUTHENTICATED, unlike `agent` on the shared token: by the
     *  time a route runs, the gate (auth-gate.ts gateRequest) has confined this
     *  principal to AGENT_TOKEN_ALLOWLIST, refused its schedule writes and
     *  checked AGENT_IDENTITY_BINDINGS (every asserted identity equals this
     *  name, no owner-lane field, the edited row existed and belonged to it).
     *  That row lookup is a pre-check, not a lock: a route whose write must
     *  stay bound to the caller enforces it in the write itself, as
     *  PUT /api/messages/:id does with closeMessageAsRecipient. Authorization
     *  decisions read THIS field, never `agent`. */
    tokenAgent?: string }
}

export type RouteHandler = (ctx: RouteContext) => Promise<boolean>
