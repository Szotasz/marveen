import { listAgentNames, readAgentCapabilities } from '../agent-config.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// GET /.well-known/fleetq
// Returns a machine-readable capability manifest for the agent fleet.
// Each key is an agent id; the value is a list of capability tags declared
// in that agent's agent-config.json ("capabilities" field). Agents with no
// declared capabilities return an empty array.
// This endpoint is intentionally unauthenticated (standard .well-known convention).
export async function tryHandleFleetQ(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/.well-known/fleetq' || ctx.method !== 'GET') return false

  const manifest: Record<string, string[]> = {}
  for (const name of listAgentNames()) {
    manifest[name] = readAgentCapabilities(name)
  }
  json(ctx.res, manifest)
  return true
}
