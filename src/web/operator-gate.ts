// The server-side fence around an operator key (DASHOPERATOR1005).
//
// Decided BEFORE any route handler runs: an 'operator' scoped device key may
// reach /api/operator/* and nothing else, and nothing at all while the owner
// keeps the operator surface off. Deny-by-default on purpose: a route added
// later is closed to the operator without anyone remembering to close it.
// Every other credential (token, session, 'full' device key, federation) is
// untouched by this gate.

import type { OperatorAccess } from './operator-access.js'

export const OPERATOR_API_PREFIX = '/api/operator/'

export interface GateAuth {
  kind: string
  scope?: string
}

/**
 * null = let it through; otherwise the reason for a 403. The owner's switches
 * are read only for an operator key (getAccess is lazy), so every other
 * request costs nothing here.
 */
export function operatorGateDecision(auth: GateAuth, path: string, getAccess: () => OperatorAccess): string | null {
  if (auth.kind !== 'device' || auth.scope !== 'operator') return null
  if (!getAccess().enabled) return 'operator access is turned off'
  if (!path.startsWith(OPERATOR_API_PREFIX)) return 'operator credential: not an operator endpoint'
  return null
}
