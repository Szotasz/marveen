import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import type { RouteContext } from '../routes/types.js'
import { logger } from '../../logger.js'
import { readLimited, sendJson, stripControl, escapeHtml, BodyTooLargeError } from './util.js'
import * as store from './store.js'
import type { Mode } from './store.js'

const CODE_TTL_S = 600
export const ACCESS_TTL_S = 3600
const REFRESH_TTL_S = 30 * 24 * 3600
const NONCE_TTL_MS = 10 * 60 * 1000
const REGISTER_LIMIT = 20
const REGISTER_WINDOW_MS = 60 * 60 * 1000
const MODES: Mode[] = ['rw', 'r', 'w']

export interface OAuthState {
  publicUrl: string
  redirectHosts: string[]
  registrations: number[]
  nonces: Map<string, { username: string; client_id: string; redirect_uri: string; code_challenge: string; state: string | null; expires: number }>
}

function secret(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url')
}

export function protectedResourceMetadata(st: OAuthState): Record<string, unknown> {
  return { resource: `${st.publicUrl}/mcp`, authorization_servers: [st.publicUrl], bearer_methods_supported: ['header'] }
}

export function authorizationServerMetadata(st: OAuthState): Record<string, unknown> {
  return {
    issuer: st.publicUrl,
    authorization_endpoint: `${st.publicUrl}/oauth/authorize`,
    token_endpoint: `${st.publicUrl}/oauth/token`,
    registration_endpoint: `${st.publicUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  }
}

async function readParams(ctx: RouteContext, maxBytes: number): Promise<{ ok: true; json: unknown; form: URLSearchParams } | { ok: false }> {
  let raw: string
  try {
    raw = (await readLimited(ctx.req, maxBytes)).toString('utf8')
  } catch (err) {
    if (err instanceof BodyTooLargeError) return { ok: false }
    throw err
  }
  const ct = String(ctx.req.headers['content-type'] ?? '').toLowerCase()
  if (ct.includes('application/json')) {
    try { return { ok: true, json: JSON.parse(raw), form: new URLSearchParams() } } catch { return { ok: false } }
  }
  return { ok: true, json: null, form: new URLSearchParams(raw) }
}

// ---------------------------------------------------------------- register

export async function handleRegister(ctx: RouteContext, st: OAuthState): Promise<void> {
  const { res } = ctx
  const parsed = await readParams({ ...ctx }, 64 * 1024)
  const meta = parsed.ok ? parsed.json : undefined
  // Registration bodies are JSON by spec; a form body is not accepted.
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return sendJson(res, 400, { error: 'invalid_client_metadata' })
  }
  const m = meta as Record<string, unknown>
  const uris = m.redirect_uris
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every((u) => typeof u === 'string' && redirectAllowed(u, st.redirectHosts))) {
    return sendJson(res, 400, { error: 'invalid_redirect_uri' })
  }
  const nowMs = Date.now()
  st.registrations = st.registrations.filter((t) => nowMs - t < REGISTER_WINDOW_MS)
  if (st.registrations.length >= REGISTER_LIMIT) return sendJson(res, 429, { error: 'too_many_registrations' })

  let name = typeof m.client_name === 'string' ? stripControl(m.client_name).trim().slice(0, 100) : ''
  if (!name) name = 'MCP client'
  const client = {
    client_id: 'mvmcp_client_' + randomBytes(16).toString('hex'),
    client_name: name,
    redirect_uris: uris as string[],
    created_at: Math.floor(nowMs / 1000),
  }
  store.insertClient(client)
  st.registrations.push(nowMs)
  sendJson(res, 201, {
    client_id: client.client_id,
    client_id_issued_at: client.created_at,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  })
}

function redirectAllowed(uri: string, hosts: string[]): boolean {
  let u: URL
  try { u = new URL(uri) } catch { return false }
  return u.protocol === 'https:' && u.hash === '' && !uri.includes('#') && hosts.includes(u.hostname.toLowerCase())
}

// ---------------------------------------------------------------- authorize

// formOrigins: where the form's answer may redirect to. Browsers apply form-action to the
// redirect that follows a submit, so the consent page must allow the connector's origin.
function htmlPage(res: RouteContext['res'], status: number, title: string, body: string, formOrigins: string[] = []): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${["'self'", ...formOrigins].join(' ')}`,
  })
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    '<style>body{font-family:sans-serif;max-width:34em;margin:3em auto;padding:0 1em}label{display:block;margin:.4em 0}button{margin:1em .5em 0 0;padding:.5em 1em}</style>' +
    `</head><body>${body}</body></html>`)
}

function sessionUser(ctx: RouteContext): { id: number; username: string } | undefined {
  if (ctx.auth?.kind !== 'session' || !ctx.auth.user) return undefined
  return store.getActiveUser(ctx.auth.user)
}

function redirectTo(res: RouteContext['res'], redirectUri: string, params: Record<string, string | null>): void {
  const loc = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v !== null) loc.searchParams.set(k, v)
  res.writeHead(302, { Location: loc.toString(), 'Cache-Control': 'no-store' })
  res.end()
}

export function handleAuthorizeGet(ctx: RouteContext, st: OAuthState): void {
  const { res, url } = ctx
  const q = url.searchParams
  const client = store.getClient(q.get('client_id') ?? '')
  if (!client) return htmlPage(res, 400, 'Error', '<p>Unknown client.</p>')
  const redirectUri = q.get('redirect_uri') ?? ''
  if (!client.redirect_uris.includes(redirectUri)) return htmlPage(res, 400, 'Error', '<p>The redirect URI is not registered for this client.</p>')

  const user = sessionUser(ctx)
  if (!user) {
    // The login cookie is SameSite=Strict, so the connector's cross-site navigation arrives
    // without it even when the user is logged in. Following a link on this page is a
    // same-site navigation and carries the cookie.
    const again = escapeHtml(`${url.pathname}${url.search}`)
    return htmlPage(res, 401, 'Sign in required',
      '<h1>Sign in required</h1><p>If you are logged in to the dashboard in this browser, ' +
      `<a href="${again}">continue</a>. Otherwise <a href="/">log in to the dashboard</a> first, then come back and continue.</p>`)
  }

  const state = q.get('state')
  const challenge = q.get('code_challenge') ?? ''
  if (q.get('response_type') !== 'code' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(challenge) || q.get('code_challenge_method') !== 'S256') {
    return redirectTo(res, redirectUri, { error: 'invalid_request', state })
  }

  const nowMs = Date.now()
  for (const [k, v] of st.nonces) if (v.expires <= nowMs) st.nonces.delete(k)
  const nonce = randomBytes(24).toString('base64url')
  st.nonces.set(nonce, { username: user.username, client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, state, expires: nowMs + NONCE_TTL_MS })

  const target = new URL(redirectUri)
  const host = target.host
  htmlPage(res, 200, 'Authorize connector', `
<h1>Connect to your memory</h1>
<p><strong>${escapeHtml(client.client_name)}</strong> (${escapeHtml(host)}) asks for access to the long-term memory of <strong>${escapeHtml(user.username)}</strong>.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<label>Label (optional) <input type="text" name="label" maxlength="100"></label>
<label><input type="radio" name="mode" value="rw" checked> rw: read and write</label>
<label><input type="radio" name="mode" value="r"> r: read only</label>
<label><input type="radio" name="mode" value="w"> w: write only (cannot read back)</label>
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`, [target.origin])
}

export async function handleAuthorizePost(ctx: RouteContext, st: OAuthState): Promise<void> {
  const { res } = ctx
  const parsed = await readParams(ctx, 64 * 1024)
  const form = parsed.ok ? parsed.form : new URLSearchParams()
  const user = sessionUser(ctx)
  if (!user) return htmlPage(res, 401, 'Sign in required', '<p>Log in to the dashboard in this browser, then try again.</p>')

  const nonce = form.get('nonce') ?? ''
  const bound = st.nonces.get(nonce)
  if (!bound || bound.expires <= Date.now()) {
    st.nonces.delete(nonce)
    return htmlPage(res, 400, 'Error', '<p>This consent page expired or was already used. Start again from the connector.</p>')
  }
  // A foreign session is refused without burning the nonce, so the user who opened the page can still answer it.
  if (bound.username !== user.username) return htmlPage(res, 403, 'Error', '<p>This consent page belongs to another user.</p>')
  st.nonces.delete(nonce)

  const decision = form.get('decision')
  if (decision === 'deny') return redirectTo(res, bound.redirect_uri, { error: 'access_denied', state: bound.state })
  if (decision !== 'approve') return htmlPage(res, 400, 'Error', '<p>Unknown decision.</p>')
  const mode = form.get('mode') as Mode | null
  if (!mode || !MODES.includes(mode)) return htmlPage(res, 400, 'Error', '<p>Unknown access mode.</p>')
  const label = stripControl(form.get('label') ?? '').trim().slice(0, 100) || null

  const code = secret('mvmcp_c_')
  store.insertCode({
    code_hash: store.sha256Hex(code), client_id: bound.client_id, username: user.username, mode, label,
    redirect_uri: bound.redirect_uri, code_challenge: bound.code_challenge, expires_at: store.nowSec() + CODE_TTL_S,
  })
  logger.info({ username: user.username, mode, client_id: bound.client_id }, 'memory-mcp: consent approved')
  redirectTo(res, bound.redirect_uri, { code, state: bound.state })
}

// ---------------------------------------------------------------- token

function tokenError(res: RouteContext['res'], error: string, description: string): void {
  sendJson(res, 400, { error, error_description: description }, { 'Cache-Control': 'no-store', Pragma: 'no-cache' })
}

function issueTokens(res: RouteContext['res'], grantId: number, now: number): void {
  const access = secret('mvmcp_at_')
  const refresh = secret('mvmcp_rt_')
  store.insertToken({ token_hash: store.sha256Hex(access), grant_id: grantId, kind: 'access', expires_at: now + ACCESS_TTL_S, created_at: now })
  store.insertToken({ token_hash: store.sha256Hex(refresh), grant_id: grantId, kind: 'refresh', expires_at: now + REFRESH_TTL_S, created_at: now })
  sendJson(res, 200, { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: 'memory' },
    { 'Cache-Control': 'no-store', Pragma: 'no-cache' })
}

function param(p: ReturnType<typeof paramsOf>, key: string): string {
  const v = p(key)
  return typeof v === 'string' ? v : ''
}

function paramsOf(parsed: { json: unknown; form: URLSearchParams }): (key: string) => unknown {
  const j = parsed.json && typeof parsed.json === 'object' && !Array.isArray(parsed.json) ? parsed.json as Record<string, unknown> : null
  return (key) => (j ? j[key] : parsed.form.get(key) ?? undefined)
}

export async function handleToken(ctx: RouteContext): Promise<void> {
  const { res } = ctx
  const parsed = await readParams(ctx, 64 * 1024)
  if (!parsed.ok) return tokenError(res, 'invalid_request', 'Unreadable request body')
  const get = paramsOf(parsed)
  const now = store.nowSec()
  const grantType = param(get, 'grant_type')

  if (grantType === 'authorization_code') {
    const row = store.consumeCode(store.sha256Hex(param(get, 'code')), now)
    if (!row) return tokenError(res, 'invalid_grant', 'Invalid, used or expired code')
    if (row.client_id !== param(get, 'client_id') || row.redirect_uri !== param(get, 'redirect_uri')) {
      return tokenError(res, 'invalid_grant', 'Client or redirect URI mismatch')
    }
    const computed = Buffer.from(createHash('sha256').update(param(get, 'code_verifier')).digest('base64url'))
    const expected = Buffer.from(row.code_challenge)
    if (computed.length !== expected.length || !timingSafeEqual(computed, expected)) {
      return tokenError(res, 'invalid_grant', 'PKCE verification failed')
    }
    const user = store.getActiveUser(row.username)
    if (!user) return tokenError(res, 'invalid_grant', 'User is not available')
    const grantId = store.insertGrant({ client_id: row.client_id, username: user.username, mode: row.mode, label: row.label }, now)
    return issueTokens(res, grantId, now)
  }

  if (grantType === 'refresh_token') {
    const row = store.getToken(store.sha256Hex(param(get, 'refresh_token')), 'refresh')
    if (!row || row.expires_at <= now) return tokenError(res, 'invalid_grant', 'Invalid or expired refresh token')
    const grant = store.getGrant(row.grant_id)
    if (!grant || grant.revoked_at !== null || grant.client_id !== param(get, 'client_id')) {
      return tokenError(res, 'invalid_grant', 'Invalid refresh token')
    }
    if (row.used_at !== null) {
      store.revokeGrant(grant.id, now)
      logger.warn({ grant_id: grant.id }, 'memory-mcp: refresh token replay, grant revoked')
      return tokenError(res, 'invalid_grant', 'Refresh token already used')
    }
    store.markTokenUsed(row.token_hash, now)
    return issueTokens(res, grant.id, now)
  }

  tokenError(res, 'unsupported_grant_type', 'Unsupported grant_type')
}
