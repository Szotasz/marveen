// "Add a Claude subscription by logging in" (SETUPTOKENWIZ1022): the dashboard
// side of src/web/setup-token-login.ts.
//
//   POST /api/claude-plans/login/start  {id, label, planType, channelsAllowed} -> {url}
//   POST /api/claude-plans/login/code   {code} -> the created plan (201) + verified
//   POST /api/claude-plans/login/cancel
//   GET  /api/claude-plans/login/status -> {active, phase, error, url}
//
// Every route takes the owner (mayIssueCredentials): this mints a credential
// that runs the whole fleet on a subscription, so the shared bearer token alone
// is not enough once a dashboard login exists. One more owner credential is let
// in here, and only here (SETUPTOKENHU1023, owner decision): a full-scope device
// key minted by Bridge pairing. The owner adds plans from the Bridge, and the
// Bridge signs every request with its paired key, never with a session.
//
// The plan fields are checked at start, before anyone logs in, so a login is
// never thrown away at the end over a taken id. The caught token is
// live-probed (liveProbeAuth, as onboarding.ts does) and then stored through
// commitNewPlan -- the same function POST /api/claude-plans runs for a pasted
// token. A token the probe proves dead is not stored; an inconclusive probe
// stores it with verified:false.
//
// The token never appears in a response, an error or a log line: the only
// place it goes is the sink below, and from there the vault.
import { homedir } from 'node:os'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { readClaudePlans, validatePlan, tokenSecretIdFor } from '../claude-plans.js'
import { liveProbeAuth, type AuthProbeResult } from '../claude-credentials-guard.js'
import {
  SetupTokenLogin, launchSetupTokenRelay, DEFAULT_LOGIN_TIMEOUTS,
  type LaunchResult, type LoginErrorCode, type LoginTimeouts,
} from '../setup-token-login.js'
import { commitNewPlan } from './claude-plans.js'
import { mayIssueCredentials, OWNER_SESSION_REQUIRED } from './auth.js'
import { getDeviceKey } from '../auth-device-keys.js'
import type { RouteContext } from './types.js'

interface PlanFields { id: string; label: string; planType: unknown; channelsAllowed: unknown }

interface LoginDeps {
  launch: () => LaunchResult
  probe: (token: string) => Promise<AuthProbeResult>
  timeouts: LoginTimeouts
}

const defaultDeps: LoginDeps = {
  launch: () => launchSetupTokenRelay(),
  probe: (token) => liveProbeAuth({ CLAUDE_CODE_OAUTH_TOKEN: token }),
  timeouts: DEFAULT_LOGIN_TIMEOUTS,
}
let deps: LoginDeps = defaultDeps

/** Tests only: swap the relay, the probe and the timeouts. */
export function setClaudePlanLoginDepsForTest(next: Partial<LoginDeps> | null): void {
  active?.login.cancel()
  active = null
  deps = next ? { ...defaultDeps, ...next } : defaultDeps
}

// One login at a time on the machine.
let active: { login: SetupTokenLogin; fields: PlanFields } | null = null

const ERROR_STATUS: Record<LoginErrorCode, number> = {
  'claude-not-found': 500,
  'spawn-failed': 500,
  'url-timeout': 504,
  'code-timeout': 410,
  'token-timeout': 504,
  'exited': 502,
  'cancelled': 409,
  'bad-code': 400,
  'wrong-phase': 409,
  'store-failed': 500,
}

const ERROR_TEXT: Record<LoginErrorCode, string> = {
  'claude-not-found': 'The claude binary was not found on this machine.',
  'spawn-failed': 'Could not start claude setup-token.',
  'url-timeout': 'claude setup-token did not show a login link in time.',
  'code-timeout': 'The login waited too long for the code. Start again.',
  'token-timeout': 'No token arrived after the code. Check the code and start again.',
  'exited': 'claude setup-token ended before it gave a token. Start again.',
  'cancelled': 'The login was cancelled.',
  'bad-code': 'That does not look like the code from the login page.',
  'wrong-phase': 'No login is waiting for a code. Start again.',
  'store-failed': 'The token arrived but could not be stored.',
}

function errorPayload(code: LoginErrorCode): { error: string; code: LoginErrorCode } {
  return { error: ERROR_TEXT[code], code }
}

async function readJson(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const body = JSON.parse((await readBody(ctx.req)).toString()) as unknown
    return body && typeof body === 'object' ? body as Record<string, unknown> : {}
  } catch {
    return null
  }
}

// A paired Bridge: a full-scope device key that carries the install id. Only Bridge
// pairing (mintBridgeDeviceKey: the dashboard pairing, which takes the owner session,
// or the machine-local enroll CLIs) sets the install id; a key minted from the
// device-key list never has one, so a machine key (an MCP, a script) stays out.
// The shared token is not a device key, so an agent still cannot start a login.
function isPairedBridgeKey(auth: RouteContext['auth']): boolean {
  if (auth?.kind !== 'device' || auth.scope !== 'full' || typeof auth.deviceId !== 'number') return false
  const key = getDeviceKey(auth.deviceId)
  return key !== null && key.scope === 'full' && typeof key.installId === 'string' && key.installId.length > 0
}

export async function tryHandleClaudePlansLogin(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (!path.startsWith('/api/claude-plans/login/')) return false

  if (!mayIssueCredentials(ctx.auth, req) && !isPairedBridgeKey(ctx.auth)) {
    json(res, OWNER_SESSION_REQUIRED, 403)
    return true
  }

  if (path === '/api/claude-plans/login/status' && method === 'GET') {
    json(res, {
      active: !!active?.login.isActive(),
      phase: active?.login.getPhase() ?? null,
      error: active?.login.getError() ?? null,
      url: active?.login.getUrl() ?? null,
    })
    return true
  }

  if (path === '/api/claude-plans/login/start' && method === 'POST') {
    const body = await readJson(ctx)
    if (!body) { json(res, { error: 'Invalid JSON' }, 400); return true }
    if (active?.login.isActive()) {
      json(res, { error: 'Another login is already in progress. Cancel it first.', code: 'busy' }, 409)
      return true
    }
    const fields: PlanFields = {
      id: typeof body.id === 'string' ? body.id.trim() : '',
      label: typeof body.label === 'string' ? body.label.trim() : '',
      planType: body.planType,
      channelsAllowed: body.channelsAllowed,
    }
    // The same check the final write runs, with the token's vault id standing
    // in for the token that does not exist yet.
    if (!fields.id || !validatePlan({ ...fields, tokenSecretId: tokenSecretIdFor(fields.id) }, homedir())) {
      json(res, { error: 'Invalid plan: id (letters/digits/_.- only), label, planType (personal|team) and channelsAllowed (boolean) are required', code: 'invalid-plan' }, 400)
      return true
    }
    if (readClaudePlans().some((p) => p.id === fields.id)) {
      json(res, { error: `Plan id already exists: ${fields.id}`, code: 'id-taken' }, 409)
      return true
    }

    const login = new SetupTokenLogin(deps.launch, deps.timeouts)
    active = { login, fields }
    const started = await login.start()
    if (!started.ok) {
      logger.warn({ code: started.code }, 'Claude plan login: start failed')
      json(res, errorPayload(started.code), ERROR_STATUS[started.code])
      return true
    }
    logger.info({ id: fields.id }, 'Claude plan login: link ready')
    json(res, { url: started.url })
    return true
  }

  if (path === '/api/claude-plans/login/code' && method === 'POST') {
    const body = await readJson(ctx)
    if (!body) { json(res, { error: 'Invalid JSON' }, 400); return true }
    const current = active
    if (!current || current.login.getPhase() !== 'waiting-code') {
      json(res, errorPayload('wrong-phase'), ERROR_STATUS['wrong-phase'])
      return true
    }
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    const outcome = await current.login.submitCode(code, async (token) => {
      const probe = await deps.probe(token)
      if (probe === 'auth-rejected') {
        return { status: 400, payload: { error: 'The new token was rejected by a test call. Nothing was stored.', code: 'verify-failed' } }
      }
      const out = commitNewPlan({ ...current.fields, token })
      if (out.status !== 201) return out
      return { status: 201, payload: { ...(out.payload as object), verified: probe === 'ok' } }
    })
    if (!outcome.ok) {
      logger.warn({ code: outcome.code }, 'Claude plan login: code step failed')
      json(res, errorPayload(outcome.code), ERROR_STATUS[outcome.code])
      return true
    }
    logger.info({ id: current.fields.id, status: outcome.result.status }, 'Claude plan login: finished')
    json(res, outcome.result.payload, outcome.result.status)
    return true
  }

  if (path === '/api/claude-plans/login/cancel' && method === 'POST') {
    active?.login.cancel()
    json(res, { ok: true })
    return true
  }

  return false
}
