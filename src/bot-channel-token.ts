/**
 * Channel-token-only check of a Bot Framework request (TEAMSAPPROVECARD1118, Samu's decision D1).
 *
 * The approval-card click reaches the dashboard through the Teams plugin, which forwards the click's activity and its
 * original Authorization header. The dashboard does not trust the plugin for the decision: it checks the token itself,
 * so no secret has to be shared with the plugin (every process of the install runs as one OS user, so a secret the
 * plugin can read, the agents can read too). The token is one the Bot Framework channel service signs; an agent cannot
 * make one. The Bot Framework SDK is not used for this: on its own it also accepts an "emulator" token, an Azure AD
 * token whose appid/azp is the bot's own app id, which anyone who can read the bot password can request
 * (TEAMSEMUTOKEN1118).
 *
 * The rules are the SDK's channel branch (ChannelValidation_authenticateChannelToken, governmentChannelValidation_
 * ValidateIdentity, JwtTokenExtractor in botframework-connector 4.23.3), narrowed:
 *   - "Bearer <jwt>", alg exactly RS256, a kid;
 *   - iss exactly https://api.botframework.com, aud exactly the bot app id;
 *   - exp / nbf within CLOCK_SKEW_S (the SDK's 5 minutes);
 *   - the serviceurl claim equal to the activity's serviceUrl (the activity must carry one), channelId msteams;
 *   - the key from the Bot Framework OpenID metadata's JWKS (jwks_uri on the metadata host), RSA, endorsed for msteams.
 * Keys are cached KEYS_TTL_MS; an unknown kid refetches at most every REFETCH_MIN_MS, and so does a failed fetch (Dani
 * R1 on the plugin copy: without the failure time, every request that passes the cheap claims would start a fetch
 * during an outage).
 *
 * The plugin has the same logic (claude-channel-teams src/teams/channelToken.ts); keep the two in step.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'

export const CHANNEL_TOKEN_ISSUER = 'https://api.botframework.com'
export const CHANNEL_OPENID_METADATA_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration'
export const REQUIRED_CHANNEL = 'msteams'
export const CLOCK_SKEW_S = 300
export const KEYS_TTL_MS = 24 * 60 * 60 * 1000
export const REFETCH_MIN_MS = 5 * 60 * 1000

export type ChannelTokenResult = { ok: true; claims: Record<string, unknown> } | { ok: false; reason: string }

export interface ChannelTokenDeps {
  fetch?: typeof fetch
  now?: () => number
  metadataUrl?: string
}

interface CachedKey { key: KeyObject; endorsements: string[] }

function b64urlJson(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A verifier bound to one bot app id, with its own key cache. Never throws; a refusal is a fixed reason. */
export function createChannelTokenVerifier(appId: string, deps: ChannelTokenDeps = {}) {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const metadataUrl = deps.metadataUrl ?? CHANNEL_OPENID_METADATA_URL
  let keys = new Map<string, CachedKey>()
  let fetchedAt = -Infinity
  let failedAt = -Infinity

  async function loadKeys(): Promise<void> {
    const metaRes = await doFetch(metadataUrl, { redirect: 'error', signal: AbortSignal.timeout(8_000) })
    if (!metaRes.ok) throw new Error(`metadata HTTP ${metaRes.status}`)
    const meta = (await metaRes.json()) as { jwks_uri?: unknown }
    if (typeof meta.jwks_uri !== 'string') throw new Error('metadata has no jwks_uri')
    const jwksUrl = new URL(meta.jwks_uri)
    if (jwksUrl.protocol !== 'https:' || jwksUrl.host !== new URL(metadataUrl).host) throw new Error('jwks_uri is not on the metadata host')
    const jwksRes = await doFetch(jwksUrl.toString(), { redirect: 'error', signal: AbortSignal.timeout(8_000) })
    if (!jwksRes.ok) throw new Error(`jwks HTTP ${jwksRes.status}`)
    const jwks = (await jwksRes.json()) as { keys?: unknown }
    const next = new Map<string, CachedKey>()
    for (const k of Array.isArray(jwks.keys) ? jwks.keys : []) {
      const jwk = k as Record<string, unknown>
      if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue
      const endorsements = Array.isArray(jwk.endorsements) ? jwk.endorsements.filter((x): x is string => typeof x === 'string') : []
      try {
        next.set(jwk.kid, { key: createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }), endorsements })
      } catch { /* an unusable key is skipped */ }
    }
    keys = next
    fetchedAt = now()
  }

  async function keyFor(kid: string): Promise<CachedKey | undefined> {
    const age = now() - fetchedAt
    const stale = age > KEYS_TTL_MS
    if (stale || (!keys.has(kid) && age > REFETCH_MIN_MS)) {
      if (now() - failedAt < REFETCH_MIN_MS) {
        if (stale) throw new Error('signing keys unavailable (a recent fetch failed)')
        return keys.get(kid)
      }
      try {
        await loadKeys()
      } catch (err) {
        failedAt = now()
        throw err
      }
    }
    return keys.get(kid)
  }

  return async function verifyChannelToken(authHeader: string | undefined, activity: unknown): Promise<ChannelTokenResult> {
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return { ok: false, reason: 'no bearer token' }
    const parts = authHeader.slice('Bearer '.length).trim().split('.')
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed token' }
    const [h, p, s] = parts as [string, string, string]
    const header = b64urlJson(h)
    const claims = b64urlJson(p)
    if (!header || !claims) return { ok: false, reason: 'malformed token' }
    if (header.alg !== 'RS256') return { ok: false, reason: 'algorithm is not RS256' }
    if (typeof header.kid !== 'string' || header.kid === '') return { ok: false, reason: 'no key id' }
    if (claims.iss !== CHANNEL_TOKEN_ISSUER) return { ok: false, reason: 'not a Bot Framework channel token (issuer)' }
    if (typeof claims.aud !== 'string' || claims.aud !== appId) return { ok: false, reason: 'audience is not this bot' }
    const t = Math.floor(now() / 1000)
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < t) return { ok: false, reason: 'token expired' }
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - CLOCK_SKEW_S > t)) return { ok: false, reason: 'token not yet valid' }
    const act = activity && typeof activity === 'object' ? (activity as { serviceUrl?: unknown; channelId?: unknown }) : {}
    if (typeof act.serviceUrl !== 'string' || act.serviceUrl === '' || claims.serviceurl !== act.serviceUrl) {
      return { ok: false, reason: 'serviceUrl claim does not match the activity' }
    }
    if (act.channelId !== REQUIRED_CHANNEL) return { ok: false, reason: 'activity is not from the msteams channel' }
    let key: CachedKey | undefined
    try {
      key = await keyFor(header.kid)
    } catch {
      return { ok: false, reason: 'signing keys unavailable' }
    }
    if (!key) return { ok: false, reason: 'unknown signing key' }
    if (!key.endorsements.includes(REQUIRED_CHANNEL)) return { ok: false, reason: 'signing key is not endorsed for msteams' }
    let good = false
    try {
      good = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key.key, Buffer.from(s, 'base64url'))
    } catch {
      good = false
    }
    if (!good) return { ok: false, reason: 'bad signature' }
    return { ok: true, claims }
  }
}

export type ChannelTokenVerifier = ReturnType<typeof createChannelTokenVerifier>
