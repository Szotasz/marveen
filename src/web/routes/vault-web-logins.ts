// /api/vault/web-logins (VAULTLOGIN1112): the vault's web logins.
//
//   GET    /api/vault/web-logins            list, never a password
//   POST   /api/vault/web-logins            create (owner)
//   PUT    /api/vault/web-logins/:id        change, a new password included (owner)
//   DELETE /api/vault/web-logins/:id        delete, the password with it (owner)
//   POST   /api/vault/web-logins/:id/unlock lift the wrong-password lock (owner)
//   POST   /api/vault/web-logins/:id/login  an AGENT logs in, in its own browser; the answer is the outcome only
//
// Who the calling agent is: a sub-agent's own token (AGENT_TOKENS), or the name the shared token claims (X-Agent-Id).
// The claim is self-asserted, the same trust the vault allowlist gives it; a caller that names no agent is refused,
// because the login happens in a named agent's browser. Every agent runs as the same OS user, so this is an access
// rule, not isolation (plan point 7).
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'
import { mayActAsOwner, refuseOwner } from './auth.js'
import { claimedAgentOf } from '../vault-acl.js'
import { listAgentNames } from '../agent-config.js'
import {
  attemptRefusal,
  createWebLogin,
  deleteWebLogin,
  getWebLogin,
  listWebLogins,
  readWebLoginPassword,
  recordAttempt,
  unlockWebLogin,
  updateWebLogin,
  type LoginOutcome,
  type WebLogin,
} from '../vault-web-logins.js'
import { agentBrowserOutputDir, cleanOutputDirSince, ensureAgentBrowser, syncAgentBrowserMcp } from '../agent-browser.js'
import { fillWebLogin, type FillRequest, type FillResult } from '../vault-web-login-filler.js'

const BODY_MAX_BYTES = 16 * 1024

/** Test seam: the browser and the filler. */
export const webLoginDeps = {
  ensureBrowser: (agent: string): Promise<string | null> => ensureAgentBrowser(agent),
  fill: (req: FillRequest): Promise<FillResult> => fillWebLogin(req),
  outputDir: (agent: string): string => agentBrowserOutputDir(agent),
  syncMcp: (): Promise<string[]> => syncAgentBrowserMcp(),
}

function toApi(e: WebLogin) {
  return {
    id: e.id,
    origin: e.origin,
    username: e.username,
    loginUrl: e.loginUrl,
    userSelector: e.userSelector,
    passSelector: e.passSelector,
    allowedAgents: e.allowedAgents,
    locked: e.lockedAt !== null,
    lastResult: e.lastResult,
    lastAttemptAt: e.lastAttemptAt ? new Date(e.lastAttemptAt * 1000).toISOString() : null,
    lastAgent: e.lastAgent,
  }
}

async function readJson(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse((await readBody(ctx.req, { maxBytes: BODY_MAX_BYTES })).toString() || '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function writeRefused(ctx: RouteContext, what: string): boolean {
  if (mayActAsOwner(ctx.auth, ctx.req)) return false
  refuseOwner(ctx.res, `${what} needs the dashboard login (an owner session).`)
  return true
}

async function syncMcpQuietly(): Promise<string[]> {
  try { return await webLoginDeps.syncMcp() } catch (err) {
    logger.warn({ err: (err as Error).message }, 'vault web login: MCP sync failed')
    return []
  }
}

/** One login at a time per agent: two fills in one browser would race for the same page. */
const busy = new Set<string>()

export async function tryHandleVaultWebLogins(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (!path.startsWith('/api/vault/web-logins')) return false

  if (path === '/api/vault/web-logins' && method === 'GET') {
    json(res, { logins: listWebLogins().map(toApi) })
    return true
  }

  if (path === '/api/vault/web-logins' && method === 'POST') {
    if (writeRefused(ctx, 'Adding a web login')) return true
    const body = await readJson(ctx)
    if (!body) { json(res, { error: 'Invalid JSON body' }, 400); return true }
    const r = createWebLogin(body, listAgentNames())
    if ('error' in r) { json(res, { error: r.error }, r.status); return true }
    logger.info({ event: 'vault-web-login-created', id: r.id, origin: r.origin }, 'vault web login created')
    const restart = await syncMcpQuietly()
    json(res, { login: toApi(r), restartAgents: restart }, 201)
    return true
  }

  const one = path.match(/^\/api\/vault\/web-logins\/([a-z0-9-]{1,64})(?:\/(unlock|login))?$/)
  if (!one) { json(res, { error: 'Not found' }, 404); return true }
  const id = one[1]!
  const action = one[2]

  if (!action && method === 'PUT') {
    if (writeRefused(ctx, 'Changing a web login')) return true
    const body = await readJson(ctx)
    if (!body) { json(res, { error: 'Invalid JSON body' }, 400); return true }
    const r = updateWebLogin(id, body, listAgentNames())
    if ('error' in r) { json(res, { error: r.error }, r.status); return true }
    logger.info({ event: 'vault-web-login-updated', id, password: body.password !== undefined }, 'vault web login updated')
    const restart = await syncMcpQuietly()
    json(res, { login: toApi(r), restartAgents: restart })
    return true
  }

  if (!action && method === 'DELETE') {
    if (writeRefused(ctx, 'Removing a web login')) return true
    if (!deleteWebLogin(id)) { json(res, { error: 'Not found' }, 404); return true }
    logger.info({ event: 'vault-web-login-deleted', id }, 'vault web login deleted')
    const restart = await syncMcpQuietly()
    json(res, { ok: true, restartAgents: restart })
    return true
  }

  if (action === 'unlock' && method === 'POST') {
    if (writeRefused(ctx, 'Unlocking a web login')) return true
    if (!unlockWebLogin(id)) { json(res, { error: 'Not found' }, 404); return true }
    logger.info({ event: 'vault-web-login-unlocked', id }, 'vault web login unlocked')
    json(res, { ok: true })
    return true
  }

  if (action === 'login' && method === 'POST') {
    const agent = ctx.auth?.kind === 'token' && ctx.auth.tokenAgent ? ctx.auth.tokenAgent : claimedAgentOf(ctx.auth)
    const entry = getWebLogin(id)
    const logRow = (outcome: string): void => {
      // One line per call: who, which entry, which origin, the outcome. Never the username, a URL query or the password.
      logger.info({ event: 'vault-web-login', id, origin: entry?.origin ?? null, agent, outcome }, 'vault: web login attempt')
    }
    if (!agent) { logRow('no-agent'); json(res, { error: 'Name the agent (X-Agent-Id): the login happens in that agent\'s browser' }, 403); return true }
    if (!entry) { logRow('not-found'); json(res, { error: 'Not found' }, 404); return true }
    const nowSec = Math.floor(Date.now() / 1000)
    const refusal = attemptRefusal(entry, agent, nowSec)
    if (refusal === 'not-allowed') { logRow('not-allowed'); json(res, { outcome: 'not-allowed' }, 403); return true }
    if (refusal === 'locked') { logRow('locked'); json(res, { outcome: 'locked' }, 423); return true }
    if (refusal === 'cooldown') { logRow('cooldown'); json(res, { outcome: 'cooldown' }, 429); return true }
    if (busy.has(agent)) { logRow('busy'); json(res, { outcome: 'busy' }, 409); return true }
    busy.add(agent)
    const startedMs = Date.now()
    let outcome: LoginOutcome = 'unknown'
    try {
      const endpoint = await webLoginDeps.ensureBrowser(agent)
      if (!endpoint) outcome = 'browser-unavailable'
      else {
        const password = readWebLoginPassword(id)
        if (password === null) outcome = 'unknown'
        else {
          outcome = (await webLoginDeps.fill({
            cdpEndpoint: endpoint,
            origin: entry.origin,
            loginUrl: entry.loginUrl ?? `${entry.origin}/`,
            username: entry.username,
            password,
            userSelector: entry.userSelector,
            passSelector: entry.passSelector,
          })).outcome
        }
      }
    } catch {
      outcome = 'unknown'
    } finally {
      // Whatever the agent's browser tool wrote while the password could be in the page goes before the answer.
      cleanOutputDirSince(webLoginDeps.outputDir(agent), startedMs)
      busy.delete(agent)
    }
    recordAttempt(id, agent, outcome, nowSec)
    logRow(outcome)
    json(res, { outcome })
    return true
  }

  json(res, { error: 'Not found' }, 404)
  return true
}
