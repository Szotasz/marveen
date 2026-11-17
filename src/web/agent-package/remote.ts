// Agent package remote (MIOAGENTINSTALL1114, PR-I2; plan 5, 5.2, 6, 6.4, 6.5).
//
// The ONE network module of the agent package feature: the fixed origin, the
// outgoing calls (redeem and catalog here; the download comes with PR-I3), the
// closed table that maps the publishing side's answers to ours, and the
// credential file (write, read, delete, tmp-leftover cleanup).
//
// The credential (the mdt_ device token) never leaves this module: no exported
// function returns it or takes it as a parameter, and only this module reads
// the file. A parse error of the redeem body or of the credential file is never
// passed on: JSON.parse quotes its input in the message, and the input is the
// token (T1); a fixed text of our own goes to the log instead.
//
// No environment and no test switch: the origin is the constant below, and a
// test builds its own Remote with makeRemote('https://...') and an in-memory
// fetchImpl. The route takes the instance from its deps, never from here.

import { lstatSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../../config.js'
import { logger } from '../../logger.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { PeerResponseTooLargeError, readBoundedBytes } from '../federation/http.js'
import { SLUG_RE, VERSION_RE } from './verify.js'

/** The publishing side's origin. EMPTY until the host is decided (N3): every outgoing call answers not_configured. */
export const PACKAGE_ORIGIN = ''

/** The whole request, body read included (plan 6). */
export const REQUEST_TIMEOUT_MS = 30_000
/** The redeem call (plan 6). */
export const REDEEM_TIMEOUT_MS = 15_000
/** The catalog's 200 body (plan 6.5). */
export const CATALOG_MAX_BYTES = 256 * 1024
/** An error body of the publishing side, and the redeem answer (plan 6). */
export const ERROR_BODY_MAX_BYTES = 4 * 1024

const REDEEM_PATH = '/functions/v1/device-link-redeem'
const CATALOG_PATH = '/functions/v1/agent-packages'

const CREDENTIAL_FILE = 'agent-package-credential.json'
const TOKEN_RE = /^mdt_[A-Za-z0-9_-]{43}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Plan 6: retryAfterSeconds is an integer of at most one day. */
const RETRY_AFTER_MAX_S = 86_400

/** What a call needs from its caller, given PER CALL (5.2): the route passes its deps. */
export interface CallDeps {
  fetchImpl: typeof fetch
  now: () => Date
}

/** An answer of ours: the status and the JSON body the route writes as it is. */
export interface Refusal {
  status: number
  body: { error: string } & Record<string, unknown>
}

/** The GET shape of the credential (6.4). Never the token. */
export type CredentialView =
  | { connected: false }
  | { connected: true; label: string; deviceTokenId: string; connectedAt: string }

export type RedeemResult =
  | { ok: true; view: CredentialView & { connected: true }; replaced: boolean; replacedDeviceTokenId: string | null }
  | { ok: false; refusal: Refusal }

export type CatalogResult = { ok: true; catalog: Record<string, unknown> } | { ok: false; refusal: Refusal }

export interface Remote {
  /** POST device-link-redeem with a normalized code; on success the credential file is (over)written. */
  redeem(code: string, deps: CallDeps): Promise<RedeemResult>
  /** GET agent-packages with the stored credential. */
  catalog(deps: CallDeps): Promise<CatalogResult>
}

// ---------------------------------------------------------------------------
// The closed answer table (plan 6, the A-side table; 6.4 for the redeem call)
// ---------------------------------------------------------------------------

export type TransportReason = 'network' | 'timeout' | 'redirect' | 'too_large' | 'not_configured' | 'upstream'
/** Which call answered: the redeem call has its own error codes (6.4); catalog and download share the table. */
export type CallKind = 'redeem' | 'package'

/** A failure before or outside an answer we can map: no host, transport, redirect, size, unreadable body. */
export function transportRefusal(kind: CallKind, reason: TransportReason): Refusal {
  return { status: 502, body: { error: kind === 'redeem' ? 'redeem_failed' : 'download_failed', reason } }
}

function retryAfterSeconds(headers: Headers): number | null {
  const v = (headers.get('retry-after') ?? '').trim()
  if (!/^[0-9]{1,10}$/.test(v)) return null
  return Math.min(Number(v), RETRY_AFTER_MAX_S)
}

function errorOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const e = (body as { error?: unknown }).error
  return typeof e === 'string' ? e : undefined
}

/**
 * Maps a non-2xx, non-3xx answer of the publishing side to ours. `body` is the
 * parsed error body, or undefined when it was not JSON. Everything the table
 * does not name is 502 upstream; every field passed on is checked by type.
 */
export function refusalFor(kind: CallKind, status: number, headers: Headers, body: unknown): Refusal {
  if (status === 429) return { status: 429, body: { error: 'rate_limited', retryAfterSeconds: retryAfterSeconds(headers) } }
  const error = errorOf(body)
  const o = body as Record<string, unknown>
  if (kind === 'redeem') {
    if (status === 404 && error === 'invalid_code') return { status: 404, body: { error: 'invalid_code' } }
    if (status === 409 && error === 'token_limit') return { status: 409, body: { error: 'token_limit' } }
    return transportRefusal(kind, 'upstream')
  }
  if (status === 401 && (error === 'token_expired' || error === 'invalid_token')) {
    // E6: never a 401 of ours (it would sign the owner out of the dashboard, M16).
    return { status: 409, body: { error: 'credential_rejected', reason: error } }
  }
  if (status === 403 && error === 'not_entitled' && (o.reason === 'free' || o.reason === 'trial_limit')) {
    const pick = o.trial_pick
    if (pick === null || (typeof pick === 'string' && SLUG_RE.test(pick))) {
      return { status: 409, body: { error: 'not_entitled', reason: o.reason, trialPick: pick } }
    }
  }
  if (status === 404 && error === 'not_found') return { status: 404, body: { error: 'package_not_found' } }
  if (status === 409 && error === 'incompatible' && typeof o.min_marveen_version === 'string'
    && VERSION_RE.test(o.min_marveen_version)) {
    return { status: 409, body: { error: 'incompatible', minMarveenVersion: o.min_marveen_version } }
  }
  if (status === 503) return { status: 503, body: { error: 'temporarily_unavailable' } }
  return transportRefusal(kind, 'upstream')
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type Exchange =
  | { ok: true; status: number; headers: Headers; bytes: Buffer }
  | { ok: false; reason: TransportReason }

function reasonOf(err: unknown): TransportReason {
  if (err instanceof PeerResponseTooLargeError) return 'too_large'
  const name = (err as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network'
}

/**
 * One request to the fixed origin and its body, read with a bound that depends
 * on the status (a 2xx gets `okMaxBytes`, anything else ERROR_BODY_MAX_BYTES).
 * Redirects are never followed: a 3xx is the `redirect` reason, and no second
 * request is made. The timeout covers the body read too (the signal aborts it).
 */
async function exchange(url: string, init: RequestInit, timeoutMs: number, okMaxBytes: number, deps: CallDeps): Promise<Exchange> {
  let res: Response
  try {
    res = await deps.fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    return { ok: false, reason: reasonOf(err) }
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    try { await res.body?.cancel() } catch { /* best effort */ }
    return { ok: false, reason: 'redirect' }
  }
  const ok = res.status >= 200 && res.status < 300
  try {
    const bytes = await readBoundedBytes(res, ok ? okMaxBytes : ERROR_BODY_MAX_BYTES)
    return { ok: true, status: res.status, headers: res.headers, bytes }
  } catch (err) {
    return { ok: false, reason: reasonOf(err) }
  }
}

/** Strict UTF-8 JSON; undefined when the bytes are not that. The parse error is dropped (T1). */
function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// The credential file (6.4): store/agent-package-credential.json, 0600
// ---------------------------------------------------------------------------

interface StoredCredential {
  schema: 1
  token: string
  deviceTokenId: string
  label: string
  connectedAt: string
}

function credentialPath(): string {
  return join(STORE_DIR, CREDENTIAL_FILE)
}

/**
 * The stored credential, or null when the file is missing, corrupt, of another
 * shape, or readable by more than its owner (the skill client's rule,
 * src/skill-cli-fs.ts: a wider file is not loaded). A read or parse failure is
 * logged with a fixed text, never with the exception (T1).
 */
function loadCredential(): StoredCredential | null {
  const p = credentialPath()
  let raw: string
  try {
    if (process.platform !== 'win32' && (statSync(p).mode & 0o077) !== 0) {
      logger.warn('agent package credential file is readable by others; not used (chmod 600 it, or connect again)')
      return null
    }
    raw = readFileSync(p, 'utf8')
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') logger.warn('agent package credential file could not be read')
    return null
  }
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    logger.warn('agent package credential file is not valid JSON; treated as not connected')
    return null
  }
  if (!isPlainObject(v) || v.schema !== 1 || typeof v.token !== 'string' || !TOKEN_RE.test(v.token)
    || typeof v.deviceTokenId !== 'string' || !UUID_RE.test(v.deviceTokenId)
    || typeof v.label !== 'string' || typeof v.connectedAt !== 'string') {
    logger.warn('agent package credential file has an unexpected shape; treated as not connected')
    return null
  }
  return { schema: 1, token: v.token, deviceTokenId: v.deviceTokenId, label: v.label, connectedAt: v.connectedAt }
}

function viewOf(c: StoredCredential): CredentialView & { connected: true } {
  return { connected: true, label: c.label, deviceTokenId: c.deviceTokenId, connectedAt: c.connectedAt }
}

/** GET /api/agent-packages/credential (6.4): the stored credential without its token, or connected:false. */
export function readCredentialView(): CredentialView {
  const c = loadCredential()
  return c === null ? { connected: false } : viewOf(c)
}

/**
 * DELETE /api/agent-packages/credential (6.4): removes the local copy; idempotent. Revoking it is the account page's.
 * A directory in the file's place is not a credential and stays. Throws when an existing file could not be removed.
 */
export function deleteCredential(): void {
  try {
    if (lstatSync(credentialPath()).isDirectory()) return
  } catch {
    return
  }
  rmSync(credentialPath(), { force: true })
}

/**
 * T3: removes what an interrupted atomic write of the credential left in the
 * store (atomicWriteFileSync's tmp is `<file>.<pid>.<ms>.<hex>.tmp`, and it
 * holds the token). Names starting with the credential file name and ending in
 * `.tmp`. Called once at server start. Returns how many it removed.
 */
export function removeCredentialTmpLeftovers(): number {
  let names: string[]
  try {
    names = readdirSync(STORE_DIR)
  } catch {
    return 0
  }
  let removed = 0
  for (const n of names) {
    if (n === CREDENTIAL_FILE || !n.startsWith(CREDENTIAL_FILE) || !n.endsWith('.tmp')) continue
    try {
      unlinkSync(join(STORE_DIR, n))
      removed++
    } catch { /* a directory or already gone: nothing to do */ }
  }
  return removed
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

/** The origin if it is a bare https origin, else null (every call then answers not_configured). */
function checkedOrigin(origin: string): string | null {
  try {
    const u = new URL(origin)
    return u.protocol === 'https:' && u.origin === origin ? origin : null
  } catch {
    return null
  }
}

async function redeemAt(origin: string | null, code: string, deps: CallDeps): Promise<RedeemResult> {
  if (origin === null) return { ok: false, refusal: transportRefusal('redeem', 'not_configured') }
  const x = await exchange(origin + REDEEM_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  }, REDEEM_TIMEOUT_MS, ERROR_BODY_MAX_BYTES, deps)
  if (!x.ok) return { ok: false, refusal: transportRefusal('redeem', x.reason) }
  const body = parseJson(x.bytes)
  if (x.status !== 200) return { ok: false, refusal: refusalFor('redeem', x.status, x.headers, body) }
  if (!isPlainObject(body) || typeof body.token !== 'string' || !TOKEN_RE.test(body.token)
    || typeof body.device_token_id !== 'string' || !UUID_RE.test(body.device_token_id)
    || typeof body.label !== 'string') {
    return { ok: false, refusal: transportRefusal('redeem', 'upstream') }
  }
  const fresh: StoredCredential = {
    schema: 1,
    token: body.token,
    deviceTokenId: body.device_token_id,
    label: body.label,
    connectedAt: deps.now().toISOString(),
  }
  let replaced = false
  try {
    statSync(credentialPath())
    replaced = true
  } catch { /* no previous credential */ }
  const previous = replaced ? loadCredential() : null
  try {
    atomicWriteFileSync(credentialPath(), JSON.stringify(fresh) + '\n', { mode: 0o600 })
  } catch {
    // Redeemed on the publishing side, not stored here: the owner revokes it by this id on the account page.
    logger.error({ deviceTokenId: fresh.deviceTokenId }, 'agent package credential redeemed but not stored; revoke this device token on the account page')
    return { ok: false, refusal: { status: 500, body: { error: 'credential_store_failed' } } }
  }
  return { ok: true, view: viewOf(fresh), replaced, replacedDeviceTokenId: previous?.deviceTokenId ?? null }
}

async function catalogAt(origin: string | null, deps: CallDeps): Promise<CatalogResult> {
  const c = loadCredential()
  if (c === null) return { ok: false, refusal: { status: 409, body: { error: 'not_connected' } } }
  if (origin === null) return { ok: false, refusal: transportRefusal('package', 'not_configured') }
  const x = await exchange(origin + CATALOG_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${c.token}` },
  }, REQUEST_TIMEOUT_MS, CATALOG_MAX_BYTES, deps)
  if (!x.ok) return { ok: false, refusal: transportRefusal('package', x.reason) }
  const body = parseJson(x.bytes)
  if (x.status !== 200) return { ok: false, refusal: refusalFor('package', x.status, x.headers, body) }
  if (!isPlainObject(body)) return { ok: false, refusal: transportRefusal('package', 'upstream') }
  // T4: the only place an A-side body goes out unchanged; never with our token in it.
  if (JSON.stringify(body).includes(c.token)) return { ok: false, refusal: transportRefusal('package', 'upstream') }
  return { ok: true, catalog: body }
}

/** A Remote bound to `origin`. Only an https origin with nothing after it is used; any other answers not_configured. */
export function makeRemote(origin: string): Remote {
  const o = checkedOrigin(origin)
  return {
    redeem: (code, deps) => redeemAt(o, code, deps),
    catalog: (deps) => catalogAt(o, deps),
  }
}
