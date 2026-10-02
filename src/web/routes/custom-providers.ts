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
    json(res, { providers: listCustomProviders() })
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
