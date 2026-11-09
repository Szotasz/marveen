import { readBody, json } from '../http-helpers.js'
import {
  listCustomProviders,
  loadCustomProvider,
  saveCustomProvider,
  deleteCustomProvider,
  validateCustomProvider,
  type CustomProviderDef,
  type AuthHeaderType,
} from '../custom-providers.js'
import type { RouteContext } from './types.js'
import { mayActAsOwner, refuseOwner } from './auth.js'
import { listAllAgentNames, readAgentCustomProvider } from '../agent-config.js'

// The agents whose agent-config.json names each provider, hidden workers included: an agent whose provider is
// deleted no longer starts ("Custom provider ... not found"), so the delete question names them.
export function providerUsers(): Map<string, string[]> {
  const users = new Map<string, string[]>()
  for (const name of listAllAgentNames()) {
    const id = readAgentCustomProvider(name)
    if (!id) continue
    users.set(id, [...(users.get(id) ?? []), name])
  }
  return users
}

// GET/POST/DELETE /api/custom-providers
// Owner-only: federation callers cannot manage custom providers.
export async function tryHandleCustomProviders(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (!path.startsWith('/api/custom-providers')) return false

  // Reject federation callers: provider management is owner-only.
  if (ctx.fedPeer) {
    json(res, { error: 'Not allowed for federation callers' }, 403)
    return true
  }

  // GET /api/custom-providers
  if (path === '/api/custom-providers' && method === 'GET') {
    const users = providerUsers()
    json(res, { providers: listCustomProviders().map((p) => ({ ...p, usedBy: users.get(p.id) ?? [] })) })
    return true
  }

  // APIAGENTWRITE1104: a provider's baseUrl is where an agent's whole prompt is sent (the same class as the
  // OLLAMA_URL setting, #2513), so adding, replacing or removing one needs the owner, not the shared access token.
  // Reading the list stays as it was.
  const writes = (path === '/api/custom-providers' && method === 'POST') || (/^\/api\/custom-providers\/[^/]+$/.test(path) && method === 'DELETE')
  if (writes && !mayActAsOwner(ctx.auth, req)) {
    refuseOwner(res, 'Adding, changing or removing a custom provider needs the dashboard login (an owner session).')
    return true
  }

  // POST /api/custom-providers
  if (path === '/api/custom-providers' && method === 'POST') {
    const body = await readBody(req)
    let data: unknown
    try { data = JSON.parse(body.toString()) } catch {
      json(res, { error: 'Invalid JSON' }, 400); return true
    }

    const err = validateCustomProvider(data)
    if (err) { json(res, { error: err }, 400); return true }

    const d = data as Record<string, unknown>
    const def: CustomProviderDef = {
      id: (d.id as string).trim(),
      label: (d.label as string).trim(),
      baseUrl: (d.baseUrl as string).trim(),
      authHeader: d.authHeader as AuthHeaderType,
      vaultKey: d.vaultKey === null || d.vaultKey === undefined ? null : String(d.vaultKey).trim() || null,
    }

    saveCustomProvider(def)
    json(res, { ok: true, provider: def })
    return true
  }

  // DELETE /api/custom-providers/:id
  const delMatch = path.match(/^\/api\/custom-providers\/([^/]+)$/)
  if (delMatch && method === 'DELETE') {
    const id = decodeURIComponent(delMatch[1])
    const found = deleteCustomProvider(id)
    if (!found) { json(res, { error: 'Provider not found' }, 404); return true }
    json(res, { ok: true })
    return true
  }

  // GET /api/custom-providers/:id  (for detail lookup)
  const getMatch = path.match(/^\/api\/custom-providers\/([^/]+)$/)
  if (getMatch && method === 'GET') {
    const id = decodeURIComponent(getMatch[1])
    const p = loadCustomProvider(id)
    if (!p) { json(res, { error: 'Provider not found' }, 404); return true }
    json(res, { provider: p })
    return true
  }

  return false
}
