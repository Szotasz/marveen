import { getAgentActivity } from '../../db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleAgentActivity(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/agent-activity' && method === 'GET') {
    json(res, getAgentActivity())
    return true
  }

  return false
}
