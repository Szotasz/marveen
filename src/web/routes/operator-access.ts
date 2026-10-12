// GET/PUT /api/operator-access -- the owner's switches for the IT operator
// surface (DASHOPERATOR1005). OWNER LANES ONLY (token, session): a device key
// -- 'full' or 'operator' -- may neither read nor change what an operator gets,
// the same rule as user and device-key administration in routes/auth.ts.
// Every change lands in config_change_log with the actor.

import { readBody, json } from '../http-helpers.js'
import { logConfigChange } from '../../db.js'
import { normaliseOperatorAccess, readOperatorAccess, writeOperatorAccess } from '../operator-access.js'
import type { RouteContext } from './types.js'

const OWNER_KINDS = ['token', 'session']
const MAX_BODY = 4096

export async function tryHandleOperatorAccess(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx
  if (path !== '/api/operator-access') return false
  if (!auth || !OWNER_KINDS.includes(auth.kind)) {
    json(res, { error: 'Forbidden for this credential type' }, 403)
    return true
  }
  if (method === 'GET') {
    json(res, readOperatorAccess())
    return true
  }
  if (method === 'PUT') {
    let parsed: unknown
    try {
      parsed = JSON.parse((await readBody(req, { maxBytes: MAX_BODY })).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const before = readOperatorAccess()
    const next = normaliseOperatorAccess(parsed)
    writeOperatorAccess(next)
    const actor = auth.kind === 'session' ? `session:${auth.user ?? '?'}` : 'token'
    logConfigChange('operator-access', JSON.stringify(before), JSON.stringify(next), actor)
    json(res, next)
    return true
  }
  json(res, { error: 'Method not allowed' }, 405)
  return true
}
