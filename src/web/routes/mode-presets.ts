// MODEPRESETS1109: only an owner session can grant preset authority.
import { readBody, json } from '../http-helpers.js'
import { logConfigChange } from '../../db.js'
import { readModePresets, validateModePresets, writeModePresets } from '../mode-presets.js'
import { bridgeOwner, mayActAsOwner, ownerCookieSession, refuseOwner } from './auth.js'
import type { RouteContext } from './types.js'

export async function tryHandleModePresets(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx
  if (path !== '/api/mode-presets') return false
  if (method === 'PUT') {
    // Check ownership before consuming the body, whatever the credential kind.
    if (!mayActAsOwner(auth, req)) {
      refuseOwner(res)
      return true
    }
    let next
    try {
      next = validateModePresets(JSON.parse((await readBody(req, { maxBytes: 65536 })).toString()))
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : 'Invalid presets' }, 400)
      return true
    }
    const before = readModePresets()
    writeModePresets(next)
    const actor = auth?.kind === 'session' ? `session:${auth?.user ?? '?'}` : auth?.kind === 'device' ? `bridge:${ownerCookieSession(req) ?? '?'}` : 'token'
    logConfigChange('mode-presets', JSON.stringify(before), JSON.stringify(next), actor)
    json(res, next)
    return true
  }
  if (!auth || (!['token', 'session'].includes(auth.kind) && !bridgeOwner(auth, req))) {
    json(res, { error: 'Forbidden for this credential type' }, 403)
    return true
  }
  if (method === 'GET') { json(res, readModePresets()); return true }
  json(res, { error: 'Method not allowed' }, 405)
  return true
}
