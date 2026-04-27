import { json } from '../http-helpers.js'
import { listProfileTemplates } from '../profiles.js'
import type { RouteContext } from './types.js'

export async function tryHandleProfiles(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/profiles' && method === 'GET') {
    json(res, listProfileTemplates().map(p => ({
      id: p.id,
      label: p.label,
      description: p.description,
      permissionMode: p.permissionMode,
      allowCount: p.filesystem.allow.length,
      denyCount: p.filesystem.deny.length,
    })))
    return true
  }

  return false
}
