// Chat app login endpoints (/chat-api/auth/*). Google Workspace OAuth ->
// HttpOnly cookie session. This namespace is intentionally OUTSIDE /api/*:
// the dashboard bearer gate does not apply here, and the chat session cookie
// grants nothing under /api/*.
import { randomBytes } from 'node:crypto'
import {
  CHAT_APP_ENABLED, CHAT_GOOGLE_CLIENT_ID, CHAT_GOOGLE_CLIENT_SECRET,
  CHAT_ALLOWED_DOMAIN, CHAT_PUBLIC_URL, WEB_PORT,
} from '../../config.js'
import { logger } from '../../logger.js'
import { json } from '../http-helpers.js'
import {
  buildGoogleAuthUrl, exchangeCodeForIdToken, decodeIdTokenClaims,
  validateIdClaims, validateWorkspaceUser,
} from '../chat/google-oauth.js'
import { resolveAgentForEmail, CHAT_USERS_PATH } from '../chat/chat-users.js'
import {
  createSession, destroySession, getChatUser,
  buildSessionCookie, buildClearedSessionCookie, parseCookies,
} from '../chat/chat-session.js'
import type { RouteContext } from './types.js'

// Short-lived cookie carrying the OAuth state+nonce pair between /login and
// /callback. Cookie-bound (not a server-side map) so it survives a server
// restart mid-login and needs no cleanup.
const OAUTH_FLOW_COOKIE = 'marveen_chat_oauth'
const OAUTH_FLOW_TTL_SECONDS = 10 * 60

function publicBaseUrl(): string {
  return CHAT_PUBLIC_URL || `http://localhost:${WEB_PORT}`
}

function redirectUri(): string {
  return `${publicBaseUrl()}/chat-api/auth/callback`
}

function oauthConfigured(): boolean {
  return Boolean(CHAT_GOOGLE_CLIENT_ID && CHAT_GOOGLE_CLIENT_SECRET && CHAT_ALLOWED_DOMAIN)
}

function flowCookie(state: string, nonce: string): string {
  const attrs = [
    `${OAUTH_FLOW_COOKIE}=${state}.${nonce}`,
    'HttpOnly',
    'Path=/chat-api/auth',
    'SameSite=Lax',
    `Max-Age=${OAUTH_FLOW_TTL_SECONDS}`,
  ]
  if (publicBaseUrl().startsWith('https://')) attrs.push('Secure')
  return attrs.join('; ')
}

function clearedFlowCookie(): string {
  const attrs = [`${OAUTH_FLOW_COOKIE}=`, 'HttpOnly', 'Path=/chat-api/auth', 'SameSite=Lax', 'Max-Age=0']
  if (publicBaseUrl().startsWith('https://')) attrs.push('Secure')
  return attrs.join('; ')
}

// Login failures redirect back to the app root with a machine-readable code
// (the future chat UI shows the message); they carry no session cookie.
function failRedirect(res: RouteContext['res'], code: string): void {
  res.writeHead(302, {
    Location: `${publicBaseUrl()}/?login_error=${encodeURIComponent(code)}`,
    'Set-Cookie': clearedFlowCookie(),
    'Cache-Control': 'private, no-store',
  })
  res.end()
}

export async function tryHandleChatAuth(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  if (!path.startsWith('/chat-api/auth/')) return false

  if (!CHAT_APP_ENABLED) {
    json(res, { error: 'Chat app is not enabled' }, 404)
    return true
  }

  if (path === '/chat-api/auth/login' && method === 'GET') {
    if (!oauthConfigured()) {
      logger.error('Chat app login attempted without CHAT_GOOGLE_CLIENT_ID/SECRET/CHAT_ALLOWED_DOMAIN configured')
      json(res, { error: 'Chat login is not configured on this server' }, 503)
      return true
    }
    const state = randomBytes(16).toString('hex')
    const nonce = randomBytes(16).toString('hex')
    const authUrl = buildGoogleAuthUrl(
      { clientId: CHAT_GOOGLE_CLIENT_ID, redirectUri: redirectUri() },
      state, nonce, CHAT_ALLOWED_DOMAIN,
    )
    res.writeHead(302, {
      Location: authUrl,
      'Set-Cookie': flowCookie(state, nonce),
      'Cache-Control': 'private, no-store',
    })
    res.end()
    return true
  }

  if (path === '/chat-api/auth/callback' && method === 'GET') {
    const flowRaw = parseCookies(req.headers.cookie)[OAUTH_FLOW_COOKIE] ?? ''
    const [cookieState, cookieNonce] = flowRaw.split('.')
    const queryState = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code') ?? ''
    if (!cookieState || !cookieNonce || !queryState || queryState !== cookieState) {
      failRedirect(res, 'state_mismatch')
      return true
    }
    if (!code) {
      // User cancelled at Google (error=access_denied) or malformed callback.
      failRedirect(res, 'cancelled')
      return true
    }
    let email: string
    try {
      const idToken = await exchangeCodeForIdToken(code, {
        clientId: CHAT_GOOGLE_CLIENT_ID,
        clientSecret: CHAT_GOOGLE_CLIENT_SECRET,
        redirectUri: redirectUri(),
      })
      const claims = decodeIdTokenClaims(idToken)
      const claimCheck = validateIdClaims(claims, { clientId: CHAT_GOOGLE_CLIENT_ID, nonce: cookieNonce })
      if (!claimCheck.ok) {
        logger.warn({ reason: claimCheck.reason }, 'Chat login rejected: invalid id_token claims')
        failRedirect(res, 'invalid_token')
        return true
      }
      const domainCheck = validateWorkspaceUser(claims, CHAT_ALLOWED_DOMAIN)
      if (!domainCheck.ok) {
        logger.warn({ reason: domainCheck.reason }, 'Chat login rejected: domain check failed')
        failRedirect(res, 'forbidden_domain')
        return true
      }
      email = domainCheck.email
    } catch (err) {
      logger.error({ err }, 'Chat login: code exchange failed')
      failRedirect(res, 'exchange_failed')
      return true
    }

    const agentId = resolveAgentForEmail(email)
    if (!agentId) {
      logger.warn({ email }, `Chat login rejected: no agent mapping (add the user to ${CHAT_USERS_PATH})`)
      failRedirect(res, 'no_agent')
      return true
    }

    const { sid, maxAgeSeconds } = createSession(email, agentId)
    logger.info({ email, agentId }, 'Chat login successful')
    res.writeHead(302, {
      Location: `${publicBaseUrl()}/`,
      'Set-Cookie': [buildSessionCookie(sid, maxAgeSeconds), clearedFlowCookie()],
      'Cache-Control': 'private, no-store',
    })
    res.end()
    return true
  }

  if (path === '/chat-api/auth/me' && method === 'GET') {
    const user = getChatUser(req)
    if (!user) {
      json(res, { authenticated: false }, 401)
      return true
    }
    json(res, { authenticated: true, email: user.email, agent: user.agentId })
    return true
  }

  if (path === '/chat-api/auth/logout' && method === 'POST') {
    destroySession(req)
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': buildClearedSessionCookie(),
      'Cache-Control': 'private, no-store',
    })
    res.end(JSON.stringify({ ok: true }))
    return true
  }

  json(res, { error: 'Not found' }, 404)
  return true
}
