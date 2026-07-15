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
}

export type RouteHandler = (ctx: RouteContext) => Promise<boolean>
