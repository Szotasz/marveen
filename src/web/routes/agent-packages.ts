// Agent package credential and catalog (MIOAGENTINSTALL1114, PR-I2; plan 6, 6.4, 6.5).
//
//   GET    /api/agent-packages/credential  -> {connected:false} | {connected:true, label, deviceTokenId, connectedAt}
//   POST   /api/agent-packages/credential  {code:"PPPP-SSSSSSSS"} -> the GET shape + replaced, replacedDeviceTokenId
//   DELETE /api/agent-packages/credential  -> {ok:true, connected:false, remoteRevoked:false}
//   GET    /api/agent-packages/catalog     -> {catalog: <the publishing side's body>}
//
// Every route takes the owner (mayActAsOwner) BEFORE it reads a body: the
// credential lets this machine download packages on the owner's account. The
// network and the credential file are remote.ts's; this file never sees the
// token. The Remote comes from `deps` (5.2): the released build is what web.ts
// wires, the handler called with ONE argument, so RELEASED_DEPS and its fixed
// origin apply; a test passes its own deps with a test origin.

import { json, methodNotAllowed, readBodyOrRefuse } from '../http-helpers.js'
import { RELEASED_KEYS } from '../agent-package/keys.js'
import { PACKAGE_ORIGIN, deleteCredential, makeRemote, readCredentialView, type Remote } from '../agent-package/remote.js'
import type { Jwk } from '../agent-package/verify.js'
import { mayActAsOwner, refuseOwner } from './auth.js'
import type { RouteContext } from './types.js'

export type PackageDeps = { keys: readonly Jwk[]; fetchImpl: typeof fetch; now: () => Date; remote: Remote }

export const RELEASED_DEPS: PackageDeps = {
  keys: RELEASED_KEYS,
  fetchImpl: fetch,
  now: () => new Date(),
  remote: makeRemote(PACKAGE_ORIGIN),
}

const CREDENTIAL_PATH = '/api/agent-packages/credential'
const CATALOG_PATH = '/api/agent-packages/catalog'
/** Plan 6: a request body is at most 4 KiB. */
const BODY_MAX_BYTES = 4 * 1024
const BAD_REQUEST = { error: 'bad_request' }

/**
 * The device-link code (A-side contract 4.1: `PPPP-SSSSSSSS`, Crockford base32)
 * in its canonical form, or null. As Crockford decoding reads it: case does not
 * matter, blanks and hyphens are ignored, O reads as 0 and I, L as 1.
 */
export function normalizeLinkCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null
  const s = raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(s)) return null
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

/** The redeem body: exactly {code}; null for anything else (the parse error is dropped, T1). */
function codeFromBody(raw: Buffer): string | null {
  let v: unknown
  try {
    v = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const keys = Object.keys(v)
  if (keys.length !== 1 || keys[0] !== 'code') return null
  return normalizeLinkCode((v as { code: unknown }).code)
}

export async function tryHandleAgentPackages(ctx: RouteContext, deps: PackageDeps = RELEASED_DEPS): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === CREDENTIAL_PATH && method === 'GET') {
    if (!mayActAsOwner(ctx.auth, req)) { refuseOwner(res); return true }
    json(res, readCredentialView())
    return true
  }

  if (path === CREDENTIAL_PATH && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) { refuseOwner(res); return true }
    const raw = await readBodyOrRefuse(req, res, { maxBytes: BODY_MAX_BYTES })
    if (raw === null) return true
    const code = codeFromBody(raw)
    if (code === null) { json(res, BAD_REQUEST, 400); return true }
    const r = await deps.remote.redeem(code, { fetchImpl: deps.fetchImpl, now: deps.now })
    if (!r.ok) { json(res, r.refusal.body, r.refusal.status); return true }
    json(res, { ...r.view, replaced: r.replaced, replacedDeviceTokenId: r.replacedDeviceTokenId })
    return true
  }

  if (path === CREDENTIAL_PATH && method === 'DELETE') {
    if (!mayActAsOwner(ctx.auth, req)) { refuseOwner(res); return true }
    try {
      deleteCredential()
    } catch {
      json(res, { error: 'credential_delete_failed' }, 500)
      return true
    }
    json(res, { ok: true, connected: false, remoteRevoked: false })
    return true
  }

  if (path === CATALOG_PATH && method === 'GET') {
    if (!mayActAsOwner(ctx.auth, req)) { refuseOwner(res); return true }
    const r = await deps.remote.catalog({ fetchImpl: deps.fetchImpl, now: deps.now })
    if (!r.ok) { json(res, r.refusal.body, r.refusal.status); return true }
    json(res, { catalog: r.catalog })
    return true
  }

  if (path === CREDENTIAL_PATH) { methodNotAllowed(res, method, ['GET', 'POST', 'DELETE']); return true }
  if (path === CATALOG_PATH) { methodNotAllowed(res, method, ['GET']); return true }
  return false
}
