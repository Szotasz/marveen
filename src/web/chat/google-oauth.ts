// Google OAuth (authorization code flow) for the chat app login.
//
// Trust model: the id_token is obtained server-side, directly from Google's
// token endpoint over TLS, so its JWT signature is NOT re-verified here --
// the TLS channel to oauth2.googleapis.com authenticates the issuer (this is
// the standard "token endpoint response" trust case from OIDC Core 3.1.3.7).
// What MUST still be validated server-side, because the values themselves can
// be wrong for our purposes even in a genuine Google token: iss, aud, exp,
// nonce, email_verified, and the Workspace domain (hd + email suffix -- the
// `hd` REQUEST parameter is a client-side hint only and is spoofable, so the
// domain decision is made exclusively on the returned claims).

export interface GoogleIdClaims {
  iss?: string
  aud?: string
  exp?: number
  nonce?: string
  email?: string
  email_verified?: boolean
  hd?: string
}

export interface OAuthClientConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

export function buildGoogleAuthUrl(
  cfg: { clientId: string; redirectUri: string },
  state: string,
  nonce: string,
  domainHint?: string,
): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state,
    nonce,
    prompt: 'select_account',
  })
  // UX hint only (pre-filters the account chooser); the real domain check
  // happens on the returned claims in validateWorkspaceUser.
  if (domainHint) params.set('hd', domainHint)
  return `${GOOGLE_AUTH_URL}?${params.toString()}`
}

export async function exchangeCodeForIdToken(code: string, cfg: OAuthClientConfig): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Google token endpoint returned ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as { id_token?: string }
  if (!data.id_token) throw new Error('Google token response missing id_token')
  return data.id_token
}

export function decodeIdTokenClaims(idToken: string): GoogleIdClaims {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('Malformed id_token')
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8')
  return JSON.parse(payload) as GoogleIdClaims
}

export function validateIdClaims(
  claims: GoogleIdClaims,
  expected: { clientId: string; nonce: string },
  nowMs = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (!claims.iss || !GOOGLE_ISSUERS.has(claims.iss)) return { ok: false, reason: 'bad issuer' }
  if (claims.aud !== expected.clientId) return { ok: false, reason: 'audience mismatch' }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) return { ok: false, reason: 'token expired' }
  if (!claims.nonce || claims.nonce !== expected.nonce) return { ok: false, reason: 'nonce mismatch' }
  if (claims.email_verified !== true) return { ok: false, reason: 'email not verified' }
  if (!claims.email) return { ok: false, reason: 'missing email' }
  return { ok: true }
}

// The Workspace gate. Both conditions are required: `hd` proves the account
// belongs to the Workspace org (a gmail.com account named like the domain has
// no hd), and the email suffix pins the primary address to the same domain.
export function validateWorkspaceUser(
  claims: GoogleIdClaims,
  allowedDomain: string,
): { ok: true; email: string } | { ok: false; reason: string } {
  const domain = allowedDomain.trim().toLowerCase()
  if (!domain) return { ok: false, reason: 'no allowed domain configured' }
  const email = (claims.email ?? '').trim().toLowerCase()
  if (!email) return { ok: false, reason: 'missing email' }
  if ((claims.hd ?? '').toLowerCase() !== domain) return { ok: false, reason: 'not a workspace account of the allowed domain' }
  if (!email.endsWith(`@${domain}`)) return { ok: false, reason: 'email domain mismatch' }
  return { ok: true, email }
}
