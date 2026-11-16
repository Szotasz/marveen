// /api/support-access: support standby on this machine (SUPPORTKULCS1109, PR1b 2b-2; terv-v7 3.4).
//
//   GET  /api/support-access          what the routine's status says, and whether enable is offered. Only
//                                     reports: writes nothing, asks no service, never shows a token.
//   POST /api/support-access/enable   owner gate, then the code-level switch below, then the owner's password
//                                     (its own bucket, support-password-gate.ts), then the KIT's copy of the
//                                     routine with the one-time code on its standard input. On success one row
//                                     in support_consents, copied from the group record the routine wrote.
//   POST /api/support-access/disable  owner gate, no password (switching off must stay cheap); the routine's
//                                     disable from this tree, which needs no kit. Success closes the open rows.
//
// THE SWITCH (Samu 32142, after Dani's Q3): until the real dispatcher exists (PR1c) every support login would be
// refused anyway, so enabling would redeem the code and write a token and lines for nothing. Enable therefore stays
// OFF in code (not a setting, not a variable): it refuses with its own code before it reads the body. PR1c turns it
// on with one line. Disable and the status are always reachable.
import type http from 'node:http'
import { getDashboardUser, insertSupportConsent, revokeOpenSupportConsents } from '../../db.js'
import { supportConsentLangOf, supportConsentSha256 } from '../../support-consent-text.js'
import { logger } from '../../logger.js'
import { readGroupRecord } from '../../support-group-record.js'
import { runKitRoutine } from '../../support-kit-loader.js'
import type { SupportPasswordGate } from '../../support-password-gate.js'
import { createStandbyDeps, createStatusDeps } from '../../support-standby-cli.js'
import { disableSupportStandby, SUPPORT_CONSENT_VERSION, type StandbyDeps } from '../../support-standby-enable.js'
import { formatSupportStatus, supportStatus, type SupportStatusDeps } from '../../support-standby.js'
import { json, readBodyOrRefuse } from '../http-helpers.js'
import { verifyPassword } from '../password-hash.js'
import { supportPasswordGate } from '../support-password.js'
import { withSupportStandbyLock } from '../support-standby-lock.js'
import { bridgeOwner, mayActAsOwner, ownerCookieSession, refuseOwner } from './auth.js'
import type { RouteContext } from './types.js'

/** OFF until PR1c (the real dispatcher). Turning it on is that PR's one-line change. */
export const SUPPORT_ENABLE_ROUTE_ON = false

/** What the routes reach outside the request. The real ones are below; tests give their own. */
export interface SupportAccessDeps {
  readonly enableOn: boolean
  readonly runKit: typeof runKitRoutine
  readonly standbyDeps: () => StandbyDeps
  readonly statusDeps: () => SupportStatusDeps
  readonly passwordGate: () => SupportPasswordGate
}

const OWNER_KINDS = ['token', 'session']
const ENABLE_MAX_BODY = 4096
const ENABLE_FIELDS = new Set(['consentVersion', 'locale', 'password', 'code'])
const LOCALE = /^[a-z]{2}(?:-[A-Z]{2})?$/
const ENABLE_TIMEOUT_MS = 90_000
const REFUSAL_LINE = /^enable: refused: ([a-z0-9_]{1,64})\n$/

/** The routine's refusal code -> HTTP status. A code not named here is a 409 (the machine is not ready). */
const REFUSAL_STATUS: Readonly<Record<string, number>> = {
  code_required: 400,
  code_shape: 400,
  license_key_not_accepted: 400,
  consent_invalid: 400,
  code_rejected: 400,
  rate_limited: 429,
  service_unavailable: 502,
  answer_unreadable: 502,
  enable_write_failed: 500,
}

/** What the API answers for a refusal the routine named. The service being unreachable has its own name (3.4). */
function refusalBody(code: string): { error: string } {
  return { error: code === 'service_unavailable' ? 'code_exchange_unavailable' : code }
}

/** The owner's user name on this request: the session's, or the owner cookie beside a token or a Bridge key. */
function ownerName(ctx: RouteContext): string | null {
  if (ctx.auth?.kind === 'session') return ctx.auth.user ?? null
  return ownerCookieSession(ctx.req)
}

function actorOf(ctx: RouteContext, owner: string | null): string {
  return ctx.auth?.kind === 'session' ? `session:${owner ?? '?'}` : ctx.auth?.kind === 'device' ? `bridge:${owner ?? '?'}` : `token:${owner ?? '?'}`
}

/** key=value lines -> an object. The status prints only enumerated values (no token, address or grant id). */
function statusObject(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1)
  }
  return out
}

/**
 * The password checks of this process, one after the other (a promise chain; a failure does not break it). Per
 * PROCESS, not per machine (Dani's review of #2781): today one dashboard process serves the machine; a second one
 * (a second instance) would have its own chain, though the bucket's state itself is shared through the database.
 */
let passwordQueue: Promise<unknown> = Promise.resolve()
function onePasswordCheckAtATime<T>(step: () => Promise<T>): Promise<T> {
  const run = passwordQueue.then(step, step)
  passwordQueue = run.catch(() => undefined)
  return run
}

function tooMany(res: http.ServerResponse, retryAfterS: number | null): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' }
  if (retryAfterS !== null) headers['Retry-After'] = String(retryAfterS)
  res.writeHead(429, headers)
  res.end(JSON.stringify({ error: 'support_password_locked' }))
}

async function handleEnable(ctx: RouteContext, deps: SupportAccessDeps): Promise<void> {
  const { req, res } = ctx
  if (!deps.enableOn) {
    json(res, { error: 'support_enable_not_available' }, 403)
    return
  }
  const raw = await readBodyOrRefuse(req, res, { maxBytes: ENABLE_MAX_BODY })
  if (raw === null) return
  let body: unknown
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    json(res, { error: 'Invalid JSON' }, 400)
    return
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    json(res, { error: 'Invalid JSON' }, 400)
    return
  }
  const fields = body as Record<string, unknown>
  if (Object.keys(fields).some((k) => !ENABLE_FIELDS.has(k))) {
    json(res, { error: 'field_not_accepted' }, 400)
    return
  }
  const { consentVersion, locale, password, code } = fields
  if (!Number.isInteger(consentVersion) || (consentVersion as number) < 1 || (consentVersion as number) > 9999) {
    json(res, { error: 'consent_invalid' }, 400)
    return
  }
  if (locale !== undefined && (typeof locale !== 'string' || !LOCALE.test(locale))) {
    json(res, { error: 'locale_invalid' }, 400)
    return
  }
  if (typeof password !== 'string' || password.length === 0) {
    json(res, { error: 'password_required' }, 400)
    return
  }
  if (typeof code !== 'string' || code.length === 0) {
    json(res, { error: 'code_required' }, 400)
    return
  }

  // The password: its own bucket, checked BEFORE the KDF; while locked the answer is the same, right or wrong.
  // ONE password check at a time on this machine (Dani's review of #2781, F1): the check of the bucket, the KDF
  // and the recording run as one step, so a burst of parallel attempts cannot all pass the check before the first
  // failure is recorded. The others wait their turn and then see the lock.
  const owner = ownerName(ctx)
  const verdict = await onePasswordCheckAtATime(async (): Promise<'locked' | 'wrong' | 'right'> => {
    const gate = deps.passwordGate()
    const before = gate.check()
    if (before.locked) return 'locked'
    const user = owner === null ? undefined : getDashboardUser(owner)
    if (user === undefined || user.disabled || !(await verifyPassword(password, user.password_hash))) {
      gate.recordFailure()
      return 'wrong'
    }
    gate.recordSuccess()
    return 'right'
  })
  if (verdict === 'locked') {
    const now = deps.passwordGate().check()
    tooMany(res, now.locked ? now.retryAfterS : null)
    return
  }
  if (verdict === 'wrong') {
    json(res, { error: 'invalid_password' }, 401)
    return
  }

  let supportDir: string
  try {
    supportDir = deps.standbyDeps().supportDir
  } catch {
    json(res, { error: 'login_user_unknown' }, 500)
    return
  }
  const run = await deps.runKit({
    supportDir,
    args: ['enable', '--consent', String(consentVersion)],
    stdin: code,
    timeoutMs: ENABLE_TIMEOUT_MS,
  })
  if (!run.ok) {
    logger.warn({ problem: run.problem }, 'support access: enable did not run')
    json(res, { error: run.problem }, run.problem === 'kit_run_failed' || run.problem === 'kit_no_output' ? 500 : 409)
    return
  }
  if (run.code !== 0) {
    const named = REFUSAL_LINE.exec(run.stderr)
    const refusal = run.code === 1 && named !== null ? named[1] : 'enable_failed'
    logger.info({ refusal, exit: run.code }, 'support access: enable refused')
    json(res, refusalBody(refusal), REFUSAL_STATUS[refusal] ?? (refusal === 'enable_failed' ? 500 : 409))
    return
  }

  const actor = actorOf(ctx, owner)
  const record = readGroupRecord(supportDir)
  if (record.kind === 'ok') {
    revokeOpenSupportConsents('replaced')
    insertSupportConsent({
      grantId: record.record.grantId,
      consentVersion: record.record.consentVersion,
      consentLang: supportConsentLangOf(locale),
      consentSha256: supportConsentSha256(record.record.consentVersion, supportConsentLangOf(locale)),
      consentAt: record.record.consentAt,
      locale: typeof locale === 'string' ? locale : null,
      keyNames: record.record.keys.map((k) => k.name),
      createdVia: 'button',
      actor,
    })
  } else {
    // The routine said it wrote the record; the reconcile copies the row from the record later (Samu 78359, Q1).
    logger.warn({ record: record.kind }, 'support access: enabled, but the group record does not read back; no consent row yet')
  }
  logger.info({ actor }, 'support access: standby enabled')
  json(res, { state: 'standby', status: statusObject(run.stdout) })
}

async function handleDisable(ctx: RouteContext, deps: SupportAccessDeps): Promise<void> {
  const { res } = ctx
  let done
  try {
    done = await disableSupportStandby(deps.standbyDeps())
  } catch {
    json(res, { error: 'login_user_unknown' }, 500)
    return
  }
  const actor = actorOf(ctx, ownerName(ctx))
  if (!done.ok) {
    logger.warn({ actor, problem: done.problem, removedLines: done.removedLines }, 'support access: disable incomplete')
    json(res, { error: 'disable_incomplete', problem: done.problem, removed_lines: done.removedLines }, 500)
    return
  }
  const closed = revokeOpenSupportConsents('button')
  logger.info({ actor, removedLines: done.removedLines, closed }, 'support access: standby disabled')
  json(res, { state: 'off', removed_lines: done.removedLines })
}

export async function handleSupportAccess(ctx: RouteContext, deps: SupportAccessDeps): Promise<boolean> {
  const { req, res, path, method, auth } = ctx
  if (path !== '/api/support-access' && !path.startsWith('/api/support-access/')) return false
  if (!auth || (!OWNER_KINDS.includes(auth.kind) && !bridgeOwner(auth, req))) {
    json(res, { error: 'Forbidden for this credential type' }, 403)
    return true
  }
  if (path === '/api/support-access' && method === 'GET') {
    // The owner's view (Dani's review of #2781, N1): the shared token alone, which every sub-agent can read, is not
    // the owner.
    if (!mayActAsOwner(auth, req)) {
      refuseOwner(res, 'Support access is the owner\'s to look at (the dashboard login).')
      return true
    }
    let report
    try {
      report = await supportStatus(deps.statusDeps())
    } catch {
      json(res, { error: 'login_user_unknown' }, 500)
      return true
    }
    json(res, {
      enable_available: deps.enableOn,
      consent_version: SUPPORT_CONSENT_VERSION,
      status: statusObject(formatSupportStatus(report)),
    })
    return true
  }
  if ((path === '/api/support-access/enable' || path === '/api/support-access/disable') && method === 'POST') {
    if (!mayActAsOwner(auth, req)) {
      refuseOwner(res, 'Support access is switched on and off by the owner (the dashboard login).')
      return true
    }
    // One standby change at a time in this process: an enable, a disable, the teardown and the reconcile (R1).
    if (path === '/api/support-access/enable') await withSupportStandbyLock(() => handleEnable(ctx, deps))
    else await withSupportStandbyLock(() => handleDisable(ctx, deps))
    return true
  }
  json(res, { error: 'Not found' }, 404)
  return true
}

const REAL_DEPS: SupportAccessDeps = {
  enableOn: SUPPORT_ENABLE_ROUTE_ON,
  runKit: runKitRoutine,
  standbyDeps: () => createStandbyDeps(),
  statusDeps: () => createStatusDeps(),
  passwordGate: supportPasswordGate,
}

export function tryHandleSupportAccess(ctx: RouteContext): Promise<boolean> {
  return handleSupportAccess(ctx, REAL_DEPS)
}
