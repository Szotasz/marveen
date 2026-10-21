import type { RouteContext } from '../routes/types.js'
import { MEMORY_MCP_ENABLED, MEMORY_MCP_REDIRECT_HOSTS, DASHBOARD_PUBLIC_URL } from '../../config.js'
import { logger } from '../../logger.js'
import { sendJson } from './util.js'
import * as store from './store.js'
import {
  type OAuthState, protectedResourceMetadata, authorizationServerMetadata,
  handleRegister, handleAuthorizeGet, handleAuthorizePost, handleToken,
} from './oauth.js'
import { handleMcp } from './mcp.js'

export interface MemoryMcpConfig { enabled: boolean; publicUrl: string; redirectHosts: string[] }

function isHttps(url: string): boolean {
  try { return new URL(url).protocol === 'https:' } catch { return false }
}

export function createMemoryMcpHandler(cfg: MemoryMcpConfig): (ctx: RouteContext) => Promise<boolean> {
  const publicUrl = cfg.publicUrl.trim().replace(/\/+$/, '')
  const active = cfg.enabled && isHttps(publicUrl)
  if (cfg.enabled && !active) {
    logger.warn('memory-mcp: MEMORY_MCP_ENABLED is set but DASHBOARD_PUBLIC_URL is not an https URL; connector stays off')
  }
  const st: OAuthState = {
    publicUrl,
    redirectHosts: cfg.redirectHosts.map((h) => h.trim().toLowerCase()).filter(Boolean),
    registrations: [],
    nonces: new Map(),
  }

  return async (ctx) => {
    if (!active) return false
    const { path, method, res } = ctx

    if (method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      sendJson(res, 200, protectedResourceMetadata(st))
      return true
    }
    if (method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      sendJson(res, 200, authorizationServerMetadata(st))
      return true
    }
    if (method === 'POST' && path === '/oauth/register') { await handleRegister(ctx, st); return true }
    if (path === '/oauth/authorize' && method === 'GET') { handleAuthorizeGet(ctx, st); return true }
    if (path === '/oauth/authorize' && method === 'POST') { await handleAuthorizePost(ctx, st); return true }
    if (method === 'POST' && path === '/oauth/token') { await handleToken(ctx); return true }
    if (path === '/mcp') { await handleMcp(ctx, publicUrl); return true }

    if (method === 'GET' && path === '/api/memory-mcp/tokens') {
      const auth = ctx.auth
      if (auth?.kind !== 'session' && auth?.kind !== 'token') { sendJson(res, 403, { error: 'Forbidden' }); return true }
      const grants = store.listGrants(auth.kind === 'session' ? auth.user ?? '' : null, auth.kind === 'token')
      sendJson(res, 200, {
        tokens: grants.map((g) => ({
          id: String(g.id), username: g.username, client_name: g.client_name, label: g.label,
          mode: g.mode, created_at: g.created_at, last_used_at: g.last_used_at,
          ...(auth.kind === 'token' ? { revoked_at: g.revoked_at } : {}),
        })),
      })
      return true
    }
    const rev = method === 'POST' ? /^\/api\/memory-mcp\/tokens\/(\d+)\/revoke$/.exec(path) : null
    if (rev) {
      const auth = ctx.auth
      if (auth?.kind !== 'session' && auth?.kind !== 'token') { sendJson(res, 403, { error: 'Forbidden' }); return true }
      const grant = store.getGrant(Number(rev[1]))
      const own = grant && (auth.kind === 'token' || grant.username.toLowerCase() === (auth.user ?? '').toLowerCase())
      if (!grant || !own) { sendJson(res, 404, { error: 'Not found' }); return true }
      store.revokeGrant(grant.id, store.nowSec())
      sendJson(res, 200, { ok: true })
      return true
    }
    return false
  }
}

export const tryHandleMemoryMcp: (ctx: RouteContext) => Promise<boolean> = createMemoryMcpHandler({
  enabled: MEMORY_MCP_ENABLED,
  publicUrl: DASHBOARD_PUBLIC_URL,
  redirectHosts: MEMORY_MCP_REDIRECT_HOSTS,
})
