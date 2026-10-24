// Direct dashboard sends to Microsoft Teams over the Bot Framework REST API.
//
// The Teams channel plugin delivers the agent's own replies inside its session,
// but the dashboard's main-channel alerts (owner notifications in notify.ts,
// scheduler alerts in web/schedule-runner.ts) have no session to piggyback on:
// they need the Bot Framework's outbound call, which is a client-credentials
// token against login.microsoftonline.com plus a POST to the conversation's
// serviceUrl. Until now both alert paths threw 'teams: direct dashboard send
// not supported', so a CHANNEL_PROVIDER=teams install silently had NO alerts.
//
// Security shape (SSRF): the conversation's serviceUrl comes from disk (the
// plugin's conversation-refs.json) or from TEAMS_SERVICE_URL, and is sent the
// bearer token -- so it must be a real Bot Framework host before anything is
// requested or sent. isTeamsServiceUrl accepts only https://smba.trafficmanager.net
// and https://smba.<region>.trafficmanager.net (no userinfo, no port, no IP
// literal, no look-alike domain). The token is fetched only AFTER the route is
// known to be allowed.
//
// Secret hygiene: neither the client secret nor the access token ever reaches
// an error message, a log line or a return value other than the token itself.

import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger.js'

const TEAMS_CONFIG_PREFIX = 'Teams API config: '
const TEAMS_DEFAULT_TIMEOUT_MS = 10_000
const TEAMS_REFS_FILE = 'conversation-refs.json'
const TEAMS_REFS_MAX_BYTES = 1_048_576 // 1 MiB: a pairing store, never large
const TEAMS_TOKEN_SAFETY_S = 300 // refresh this far before expiry
// The only readTeamsServiceUrl answers that mean "no stored reference": TEAMS_SERVICE_URL may stand in for those.
// Every other answer (a symlink, another user's file, a foreign host, ...) is a refs file that was REJECTED, and an
// override must not paper over it.
const TEAMS_NO_REF_REASONS = new Set([
  `no ${TEAMS_REFS_FILE} in the Teams state directory`,
  'no conversation reference for the target conversation',
])

// A value a response echoed back may carry a credential: every occurrence of the token or the secret is cut out.
function scrubCredentials(text: string, secrets: readonly string[]): string {
  let out = text
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]')
  return out
}

/**
 * True only for a Bot Framework service host: https, no userinfo, no explicit
 * port, and a hostname that is exactly `smba.trafficmanager.net` or
 * `smba.<one-label>.trafficmanager.net`. Everything else -- http, an IP
 * literal, `evil.trafficmanager.net`, `smba.a.b.trafficmanager.net`,
 * `smba.trafficmanager.net.evil.com`, userinfo, a port, an unparsable string --
 * is false, so it can never become the destination of a bearer-token POST.
 */
export function isTeamsServiceUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  if (u.username !== '' || u.password !== '') return false
  if (u.port !== '') return false
  const host = u.hostname.toLowerCase()
  return host === 'smba.trafficmanager.net' || /^smba\.[a-z0-9-]+\.trafficmanager\.net$/.test(host)
}

/**
 * The per-conversation serviceUrl the Teams plugin recorded at pairing time.
 *
 * Reads `<stateDir>/conversation-refs.json` and returns the stored serviceUrl
 * for the conversation, or `{ reason }` -- never throws -- when the file is
 * missing, not a regular file owned by us, too large, malformed, has no entry
 * for the conversation (both the top-level conversationId and the nested
 * ref.conversation.id must match), or points at a host isTeamsServiceUrl
 * rejects. Every reason is a short English sentence the caller can surface.
 */
export function readTeamsServiceUrl(
  stateDir: string,
  conversationId: string,
  deps?: { lstat?: typeof lstatSync; readFile?: (p: string) => string; uid?: number | null },
): { url: string } | { reason: string } {
  const lstat = deps?.lstat ?? lstatSync
  const readFile = deps?.readFile ?? ((p: string) => readFileSync(p, 'utf-8'))
  const path = join(stateDir, TEAMS_REFS_FILE)

  let st: ReturnType<typeof lstatSync>
  try {
    st = lstat(path)
  } catch (err) {
    // Only a file that is not there is "no reference": a permission or other filesystem error is a refs file that
    // could not be checked, and TEAMS_SERVICE_URL must not stand in for it.
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') {
      return { reason: `no ${TEAMS_REFS_FILE} in the Teams state directory` }
    }
    return { reason: `${TEAMS_REFS_FILE} cannot be read` }
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { reason: `${TEAMS_REFS_FILE} is not a regular file` }
  }
  const uid = deps?.uid !== undefined ? deps.uid : (process.getuid?.() ?? null)
  if (uid !== null && st.uid !== uid) {
    return { reason: `${TEAMS_REFS_FILE} belongs to another user` }
  }
  if (st.size > TEAMS_REFS_MAX_BYTES) {
    return { reason: `${TEAMS_REFS_FILE} is too large` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFile(path))
  } catch {
    return { reason: `${TEAMS_REFS_FILE} has an unexpected format` }
  }
  const root = parsed as { version?: unknown; refs?: unknown } | null
  if (root === null || typeof root !== 'object' || Array.isArray(root) || root.version !== 1 || !Array.isArray(root.refs)) {
    return { reason: `${TEAMS_REFS_FILE} has an unexpected format` }
  }
  const entry = (root.refs as unknown[]).find(
    (e): e is { ref?: { serviceUrl?: unknown; conversation?: { id?: unknown } } } => {
      if (e === null || typeof e !== 'object') return false
      const r = e as { conversationId?: unknown; ref?: { conversation?: { id?: unknown } } }
      return r.conversationId === conversationId && r.ref?.conversation?.id === conversationId
    },
  )
  if (!entry) {
    return { reason: 'no conversation reference for the target conversation' }
  }
  const serviceUrl = entry.ref?.serviceUrl
  if (typeof serviceUrl !== 'string' || !isTeamsServiceUrl(serviceUrl)) {
    return { reason: 'the stored serviceUrl is not a Teams service host' }
  }
  return { url: serviceUrl }
}

/** The Bot Framework app registration the Teams plugin authenticates with. */
export interface TeamsCreds {
  appId: string
  secret: string
  tenant: string
}

/** Every "cannot send, config is missing or wrong" case. The message always
 *  starts with 'Teams API config: ' so classifySendError can sort it permanent. */
export class TeamsConfigError extends Error {
  constructor(reason: string) {
    super(TEAMS_CONFIG_PREFIX + reason)
    this.name = 'TeamsConfigError'
  }
}

// One warn line per thrown config error, so a Teams install that cannot alert
// says why in the dashboard log instead of failing silently. The reason is the
// bare sentence (no 'Teams API config: ' prefix, no other fields) -- never the
// secret or the token.
function teamsConfigFail(reason: string): TeamsConfigError {
  logger.warn({ provider: 'teams', reason }, 'Teams riasztas nem kuldheto')
  return new TeamsConfigError(reason)
}

// Token cache keyed by `${appId}|${tenant}`: the scheduler can fire several
// alerts in one tick, and each client-credentials round trip costs a login
// request (and Entra throttles aggressively). Reused while now() is at least
// TEAMS_TOKEN_SAFETY_S before the recorded expiry.
const teamsTokenCache = new Map<string, { token: string; expiresAt: number }>()

/** Test seam: drop the cached tokens between cases. */
export function clearTeamsTokenCache(): void {
  teamsTokenCache.clear()
}

const TEAMS_TENANT_RX = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/

/**
 * A client-credentials access token for https://api.botframework.com/.default.
 *
 * Throws TeamsConfigError when the tenant id is malformed or Entra refuses the
 * credentials (HTTP 400/401 -- a wrong secret or app id, which retrying cannot
 * fix); a plain Error for network failures, timeouts, other HTTP statuses and
 * unreadable bodies. The secret and the token never appear in any of them.
 */
export async function getTeamsBotToken(
  creds: TeamsCreds,
  deps?: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number },
): Promise<string> {
  if (!TEAMS_TENANT_RX.test(creds.tenant)) {
    throw new TeamsConfigError('Teams tenant id has an unexpected form')
  }
  const now = deps?.now ?? (() => Date.now())
  const cacheKey = `${creds.appId}|${creds.tenant}`
  const cached = teamsTokenCache.get(cacheKey)
  if (cached && now() < cached.expiresAt) return cached.token

  let res: Response
  try {
    res = await (deps?.fetch ?? fetch)(
      `https://login.microsoftonline.com/${encodeURIComponent(creds.tenant)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: creds.appId,
          client_secret: creds.secret,
          scope: 'https://api.botframework.com/.default',
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(deps?.timeoutMs ?? TEAMS_DEFAULT_TIMEOUT_MS),
      },
    )
  } catch {
    throw new Error('Teams API: token request failed (network error or timeout)')
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  if (res.status === 400 || res.status === 401) {
    // Entra's error body: { error, error_description, error_codes: [7000215, ...] }.
    // Only the numeric AADSTS code is carried into the message; the free-text
    // error_description can echo the request (and with it the secret).
    const fields = body !== null && typeof body === 'object' ? body as { error_codes?: unknown } : undefined
    const first = Array.isArray(fields?.error_codes) ? fields.error_codes[0] : undefined
    const aadsts = typeof first === 'number' && Number.isInteger(first) ? first : undefined
    throw new TeamsConfigError(`token request refused (HTTP ${res.status}${aadsts !== undefined ? `, AADSTS${aadsts}` : ''})`)
  }
  if (!res.ok) {
    throw new Error(`Teams API ${res.status}: token request failed`)
  }
  const accessToken = (body as { access_token?: unknown } | undefined)?.access_token
  const expiresIn = (body as { expires_in?: unknown } | undefined)?.expires_in
  if (typeof accessToken !== 'string' || !accessToken || typeof expiresIn !== 'number') {
    throw new Error('Teams API: token response unreadable')
  }
  const obtainedAt = now()
  teamsTokenCache.set(cacheKey, { token: accessToken, expiresAt: obtainedAt + (expiresIn - TEAMS_TOKEN_SAFETY_S) * 1000 })
  return accessToken
}

/**
 * Send one plain-text message to a Teams conversation over the Bot Framework
 * REST API. The destination is the conversation's recorded serviceUrl (or
 * TEAMS_SERVICE_URL as an operator override), and it must pass
 * isTeamsServiceUrl BEFORE any token is requested -- a missing or foreign route
 * fails locally, with nothing sent anywhere.
 *
 * TeamsConfigError (with one preceding logger.warn) for every config problem;
 * a plain Error for transport failures. Resolves with the HTTP status and the
 * activity id the service assigned.
 */
export async function sendTeamsMessage(
  creds: TeamsCreds,
  stateDir: string,
  conversationId: string,
  text: string,
  deps?: {
    fetch?: typeof fetch
    now?: () => number
    env?: Record<string, string | undefined>
    timeoutMs?: number
    readRefs?: typeof readTeamsServiceUrl
  },
): Promise<{ status: number; messageId?: string }> {
  if (!creds.appId || !creds.secret || !creds.tenant) {
    throw teamsConfigFail('Teams credentials incomplete (TEAMS_BOT_APP_ID, TEAMS_BOT_APP_PASSWORD and TEAMS_BOT_TENANT_ID are all needed)')
  }
  if (!conversationId) {
    throw teamsConfigFail('no target conversation (TEAMS_ALLOWED_CONVERSATION_ID)')
  }

  const ref = (deps?.readRefs ?? readTeamsServiceUrl)(stateDir, conversationId)
  let serviceUrl: string
  if ('url' in ref) {
    serviceUrl = ref.url
  } else {
    const override = (deps?.env ?? process.env).TEAMS_SERVICE_URL
    if (TEAMS_NO_REF_REASONS.has(ref.reason) && typeof override === 'string' && override !== '') {
      if (!isTeamsServiceUrl(override)) {
        throw teamsConfigFail('TEAMS_SERVICE_URL is not a Teams service host')
      }
      serviceUrl = override
    } else {
      throw teamsConfigFail(ref.reason)
    }
  }

  let token: string
  try {
    token = await getTeamsBotToken(creds, { fetch: deps?.fetch, now: deps?.now, timeoutMs: deps?.timeoutMs })
  } catch (err) {
    if (err instanceof TeamsConfigError) {
      throw teamsConfigFail(err.message.slice(TEAMS_CONFIG_PREFIX.length))
    }
    throw err
  }

  const base = serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`
  let res: Response
  try {
    res = await (deps?.fetch ?? fetch)(
      new URL(`v3/conversations/${encodeURIComponent(conversationId)}/activities`, base),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: 'message', text }),
        redirect: 'error',
        signal: AbortSignal.timeout(deps?.timeoutMs ?? TEAMS_DEFAULT_TIMEOUT_MS),
      },
    )
  } catch {
    throw new Error('Teams API: send failed (network error or timeout)')
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  if (!res.ok) {
    // Only the structured error.code / error.message fields, capped at 200
    // characters: the body can echo the request, and with it the token.
    const fields = body !== null && typeof body === 'object' ? (body as { error?: { code?: unknown; message?: unknown } }).error : undefined
    const parts: string[] = []
    if (typeof fields?.code === 'string') parts.push(fields.code)
    if (typeof fields?.message === 'string') parts.push(fields.message)
    const detail = scrubCredentials(parts.length > 0 ? parts.join(' ') : 'send failed', [token, creds.secret]).slice(0, 200)
    throw new Error(`Teams API ${res.status}: ${detail}`)
  }
  const id = (body as { id?: unknown } | undefined)?.id
  const clean = typeof id === 'string' && !id.includes(token) && !(creds.secret && id.includes(creds.secret))
  return { status: res.status, messageId: clean ? (id as string) : undefined }
}
