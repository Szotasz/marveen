// GROMZOOWNERQR1030 (+ MOBILRELOGINDASH1025): the dashboard's Gromzo panel.
//
//   GET  /api/gromzo/status    -> mxd's state for the panel (running / linked)
//   POST /api/gromzo/owner-qr  -> the owner's QR code: the first registration's join
//                                 code, or, once the owner is registered, the login
//                                 code for a new phone (see mxd-dash.ts requestOwnerQr)
//   GET  /api/gromzo/agents                    -> the fleet's agents and whether each is on Gromzo
//   POST /api/gromzo/agents/:slug/enable       -> asks the owner (in the app) to approve the agent
//   POST /api/gromzo/agents/:slug/consent      -> the pending consent; once approved, mxd adds the agent
//                                               (a state change: POST, behind the JSON + Origin gate; the
//                                               read side is GET /api/gromzo/agents, pendingUntil per row)
//   POST /api/gromzo/agents/:slug/disable      -> takes the agent off Gromzo
//   (GROMZOAGENTPICK1101; the rules are in ../gromzo-agents.ts. All four: the owner's session only.)
//
// Who may ask for the QR: ONLY the owner's dashboard session. This is stricter than
// issuing a device key (routes/auth.ts mayActAsOwnerOrFirstRun 'first-device', DEVKEYMINT1022),
// which lets the shared token mint the first key before the first dashboard login exists. Here
// that first-run branch is closed on purpose (Dani's review of #2365): the shared bearer
// is held by every fleet agent, and the first owner_invite claims the owner's chat
// seat on the controller once. On a fresh install the owner first sets up the
// dashboard login, then asks for the QR.
//
// The global Origin gate (csrf-origin) refuses a foreign-origin POST before this
// runs; the POST here also refuses a non-JSON body (415), as video-review does.
//
// The secret: written into this one response, inside `uri`, with no-store. Never
// logged (only the kind and the lifetime are), never in the URL, never stored.

import type http from 'node:http'
import { logger } from '../../logger.js'
import { json, methodNotAllowed, readBody } from '../http-helpers.js'
import { ownerCookieSession } from './auth.js'

/** The 403 body. Same code as auth.ts OWNER_SESSION_REQUIRED (the panel keys its
 *  sentence on it), but its own text: that one says the token works before the
 *  first login, which is not true here. */
export const OWNER_QR_SESSION_REQUIRED = {
  error: "The owner QR needs the owner's dashboard login. The access token never gets it, not even before the first login exists: set up the dashboard login first.",
  code: 'owner_session_required',
}
import { mxdDashCall, MxdDashError, MXD_AGENT_SLUG_RE, requestOwnerQr, type MxdDashCall, type OwnerQr } from '../mxd-dash.js'
import {
  checkGromzoAgent, disableGromzoAgent, enableGromzoAgent, listGromzoAgentsWithStatus, pendingGromzoConsentSlug, restorePendingGromzoConsents,
  sendGromzoAvatar, setPendingConsentStore, statusFactsOf, watcherDelayMs, type GromzoAgentDeps, type GromzoAgentOutcome, type PendingConsentStore,
} from '../gromzo-agents.js'
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { avatarProblem, readAgentAvatar } from '../gromzo-avatar.js'
import { agentDir, listAgentNames, readAgentDisplayName, readAgentGromzo, writeAgentGromzo } from '../agent-config.js'
import { isAgentRunning, restartAgentProcess, withTmuxBatch } from '../agent-process.js'
import { MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR, currentBotName } from '../../config.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { gateManualRestart } from '../manual-restart-gate.js'
import { hardRestartMarveenChannels } from '../channel-monitor.js'
import {
  mainGromzoLaunchState, mainGromzoPanelState, mainSessionLoadsGromzo, readMainGromzoToken, restartMainAfterMxdReload,
  restartMainForGromzoNow, switchMainGromzoOff, switchMainGromzoOn,
} from '../main-gromzo.js'
import type { RouteContext } from './types.js'

/** The owner's dashboard session, and nothing else: a session principal, or a
 *  credential sent alongside a valid session cookie of the owner's password login:
 *  the shared token (a logged-in owner whose browser also keeps the access token),
 *  or a FULL device key (the Bridge: its webview sends the key on every call, and
 *  the owner signs in with the password inside it; GROMZOAGENTPICK1101, Samu 64370).
 *  Never a bare credential, not even before the first login exists; never a
 *  sub-agent token, an operator key or a federation peer. */
export function isOwnerSession(auth: RouteContext['auth'], req: http.IncomingMessage): boolean {
  if (auth?.kind === 'session') return true
  const sharedToken = auth?.kind === 'token' && !auth.tokenAgent
  const fullDeviceKey = auth?.kind === 'device' && auth.scope === 'full'
  if (!sharedToken && !fullDeviceKey) return false
  const owner = ownerCookieSession(req)
  if (owner === null) return false
  // GROMZOBRIDGEWIZARD1107 D2: an action the Bridge makes with its key beside the owner's cookie leaves one audit line
  // naming the owner (as auth.ts bridgeOwnerAudited does for the other owner gates). Reads are not logged: the panel
  // polls them.
  if (fullDeviceKey && req.method !== 'GET' && req.method !== 'HEAD') {
    logger.info({ owner, auth: 'device', device: auth.device, method: req.method, path: req.url?.split('?')[0] }, 'gromzo: owner action on a Bridge key: the owner session beside it')
  }
  return true
}

/** GROMZOQRAUDITLOG1107: who asked for the owner QR, on every one of its log lines (issued, refused, failed):
 *  how the caller authenticated, the owner's dashboard login when it is known (the session's own, or the
 *  owner cookie beside a token or a Bridge key) and the Bridge device's name. Never the cookie, a token, a
 *  key or an address. The Bridge's root step (mxdctl on admin.sock) never comes here: mxd logs that one. */
export function ownerQrCaller(auth: RouteContext['auth'], req: http.IncomingMessage): Record<string, string> {
  const via = 'dashboard'
  switch (auth?.kind) {
    case 'session': return { via, auth: 'session', owner: auth.user ?? '-' }
    case 'device': return { via, auth: `device_${auth.scope}`, device: auth.device ?? '-', owner: ownerCookieSession(req) ?? '-' }
    case 'token': return { via, auth: auth.tokenAgent ? 'agent_token' : 'shared_token', owner: ownerCookieSession(req) ?? '-' }
    case 'federation': return { via, auth: 'federation' }
    default: return { via, auth: 'none' }
  }
}

const STATUS_PATH = '/api/gromzo/status'
const OWNER_QR_PATH = '/api/gromzo/owner-qr'
const AGENTS_PATH = '/api/gromzo/agents'
const AGENT_ACTION_RE = /^\/api\/gromzo\/agents\/([^/]{1,64})\/(enable|disable|consent|restart)$/

/** The dash.sock client (the socket path is read per call: MXD_DASH_SOCK or the default). */
const call: MxdDashCall = (request) => mxdDashCall(request)

/** The HTTP status for a failure code (transport or mxd). The body carries the code;
 *  the panel turns it into a sentence (web/lang gromzo.err.*). */
export function httpStatusFor(code: string): number {
  switch (code) {
    case 'bad_request': return 400
    case 'unknown_agent': return 404
    case 'main_agent':
    case 'no_pending':
    case 'consent_mismatch':
    case 'agent_exists':
    case 'add_in_progress':
    case 'pending_exists':
    case 'too_many_agents':
    case 'bad_slug':
    case 'reserved_slug':
    case 'bad_name':
    case 'reserved_name':
    // GROMZONAMETAKEN1106: the controller's name refusals (passed on by mxd): the owner picks another name.
    case 'name_taken':
    case 'bad_display_name':
    case 'mixed_script':
      return 409
    case 'rate_limited':
    case 'too_soon':
      return 429
    case 'agents_not_running':
    case 'not_running':
    case 'no_access':
    case 'forbidden':
      return 503
    case 'timeout': return 504
    case 'not_linked':
    case 'consent_required':
    case 'invite_outstanding':
    case 'owner_invite_already_issued':
    case 'owner_invite_used':
    case 'no_owner':
    case 'identity_reset_in_progress':
    case 'identity_reset_stalled':
    case 'team_lapsed':
    case 'team_unknown':
    case 'revoked':
      return 409
    case 'test_guard': return 500
    default: return 502
  }
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const ct = String(req.headers['content-type'] ?? '').toLowerCase()
  return ct.split(';')[0]!.trim() === 'application/json'
}

/** The one response that carries a secret. Its headers are set HERE, explicitly,
 *  so no shared helper's later change can make the browser or a proxy keep it. */
function sendOwnerQr(res: http.ServerResponse, qr: OwnerQr): void {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify({ kind: qr.kind, uri: qr.uri, expires_in: qr.expires_in }))
}

function failure(res: http.ServerResponse, code: string, retryAfter?: number): void {
  json(res, retryAfter === undefined ? { error: code } : { error: code, retry_after: retryAfter }, httpStatusFor(code))
}

/** After mxd's reload (it exits ~0.5 s after an add or a remove): wait until dash.sock answers again, up to ~60 s,
 *  then restart that ONE agent so its Gromzo plugin loads or goes. Nothing else is restarted. */
async function restartAfterMxdReload(slug: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 2_000))
  for (let i = 0; i < 30; i++) {
    try {
      const r = await call({ verb: 'status' })
      if (r.ok === true && r.running === true) break
    } catch { /* still reloading */ }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  await avatarAfterReload(slug)
  const res = await restartAgentProcess(slug)
  if (res.ok) logger.info({ slug }, 'gromzo agents: the agent restarted for its Gromzo switch')
  else logger.error({ slug, error: res.error }, 'gromzo agents: the agent did NOT restart after its Gromzo switch')
}

/** After mxd's reload: an add (its flag is on by now) sends the agent's dashboard picture, before the agent restarts;
 *  a remove (flag off) sends nothing. A failure is logged and changes nothing else: the add stands. */
export async function avatarAfterReload(slug: string, retryDelayMs = 2_000, appliedRetryMs = AVATAR_APPLIED_RETRY_MS): Promise<void> {
  if (agentDeps.readFlag(slug)) await pushAvatarAfterAdd(slug, retryDelayMs, appliedRetryMs)
  else logger.info({ slug }, 'gromzo agents: no picture sent (the switch is off: a remove)')
}

// mxd's agent_avatar takes one picture per agent per minute (marveen-mxd main.rs take_avatar), so a try again after
// "stored, not set yet" waits a little over a minute.
export const AVATAR_APPLIED_RETRY_MS = 65_000
const AVATAR_APPLIED_TRIES = 3

/** One send, with a few tries while mxd may still be settling after its reload (transport failure or "unavailable"). */
async function sendAvatarSettling(slug: string, retryDelayMs: number): Promise<GromzoAgentOutcome> {
  let o: GromzoAgentOutcome = { ok: false, code: 'io' }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { o = await sendGromzoAvatar(slug, agentDeps) } catch (e) {
      o = { ok: false, code: e instanceof MxdDashError ? e.code : 'io' }
    }
    if (o.ok) return o
    const retry = o.code === 'unavailable' || o.code === 'not_running' || o.code === 'timeout' || o.code === 'io'
    if (!retry || attempt === 3) return o
    await new Promise((r) => setTimeout(r, retryDelayMs))
  }
  return o
}

/** The picture after an add. Logs the slug and the size only, and every outcome (GAZDA-TESZT build 19, Samu 65189:
 *  an add whose picture never showed). mxd answers applied=false when it stored the picture but could not set it on
 *  the agent (the new agent was not running there yet, right after its reload); it would set it only at the agent's
 *  NEXT start. So that is a WARN, and the picture goes again in the background, a little over a minute apart, until
 *  mxd sets it, the switch goes off, or the tries run out. The agent restart never waits for it. */
export async function pushAvatarAfterAdd(slug: string, retryDelayMs = 2_000, appliedRetryMs = AVATAR_APPLIED_RETRY_MS): Promise<void> {
  const o = await sendAvatarSettling(slug, retryDelayMs)
  if (!o.ok) {
    logger.warn({ slug, code: o.code }, 'gromzo agents: picture NOT sent after the add (the add stands)')
    return
  }
  if (o.state !== 'avatar_sent') {
    logger.warn({ slug, state: o.state }, 'gromzo agents: picture send answered an unexpected state')
    return
  }
  if (o.applied) {
    logger.info({ slug, bytes: o.bytes, applied: true }, 'gromzo agents: picture sent after the add')
    return
  }
  // MXDAVATARAPPLY1101: mxd's agents were still starting; it stored the picture and sets it itself once they run
  // (and again at every later start), so a try again a minute later would only wait for what mxd already does.
  // An older mxd never answers pending: the try-again line below stays for it.
  if (o.pending) {
    logger.info({ slug, bytes: o.bytes, applied: false, pending: true }, 'gromzo agents: picture stored by mxd while its agents start; mxd sets it once they run (no try again)')
    return
  }
  // At most one try-again line per agent (Dani 65222/2): a second add or a restart while one runs would run into
  // mxd's one-per-minute limit with a parallel line.
  if (avatarRetrying.has(slug)) {
    logger.warn({ slug, bytes: o.bytes, applied: false }, 'gromzo agents: picture stored by mxd but NOT set on the agent yet; a try again already runs for it')
    return
  }
  logger.warn({ slug, bytes: o.bytes, applied: false }, 'gromzo agents: picture stored by mxd but NOT set on the agent yet; sending it again')
  avatarRetrying.add(slug)
  void retryUntilApplied(slug, retryDelayMs, appliedRetryMs)
    .catch((e) => logger.error({ slug, err: e instanceof Error ? e.message : String(e) }, 'gromzo agents: picture retry failed'))
    .finally(() => avatarRetrying.delete(slug))
}

const avatarRetrying = new Set<string>()

async function retryUntilApplied(slug: string, retryDelayMs: number, gapMs: number): Promise<void> {
  for (let tryNo = 2; tryNo <= AVATAR_APPLIED_TRIES; tryNo++) {
    await new Promise((r) => setTimeout(r, gapMs))
    if (!agentDeps.readFlag(slug)) {
      logger.info({ slug }, 'gromzo agents: picture retry stopped (the switch went off)')
      return
    }
    const o = await sendAvatarSettling(slug, retryDelayMs)
    if (o.ok && o.state === 'avatar_sent' && o.applied) {
      logger.info({ slug, bytes: o.bytes, applied: true, try: tryNo }, 'gromzo agents: picture set on the agent')
      return
    }
    if (o.ok && o.state === 'avatar_sent' && o.pending) {
      logger.info({ slug, bytes: o.bytes, applied: false, pending: true, try: tryNo }, 'gromzo agents: picture stored by mxd while its agents start; mxd sets it once they run (no try again)')
      return
    }
    if (!o.ok && o.code !== 'rate_limited') {
      logger.warn({ slug, code: o.code, try: tryNo }, 'gromzo agents: picture NOT sent on the retry (the add stands)')
      return
    }
  }
  logger.warn({ slug, tries: AVATAR_APPLIED_TRIES }, 'gromzo agents: picture still NOT set on the agent; mxd sets the stored one at the agent\'s next start')
}

const defaultAgentDeps: GromzoAgentDeps = {
  call: (request) => call(request),
  agents: () => listAgentNames(),
  // GROMZOMAINAGENT1106: for the main agent the flag is its .env gromzo id and the restart is the main session's
  // own (main-gromzo.ts); every other agent keeps its agent-config flag and its own restart.
  readFlag: (slug) => slug === MAIN_AGENT_ID ? (() => { const t = readMainGromzoToken(PROJECT_ROOT); return t.ok && t.on })() : readAgentGromzo(slug),
  writeFlag: (slug, on) => {
    if (slug === MAIN_AGENT_ID) { if (on) switchMainGromzoOn(PROJECT_ROOT); else switchMainGromzoOff(PROJECT_ROOT); return }
    writeAgentGromzo(slug, on)
  },
  mainLaunchState: () => {
    const t = readMainGromzoToken(PROJECT_ROOT)
    return mainGromzoPanelState(t.ok && t.on, mainSessionLoadsGromzo(MAIN_CHANNELS_SESSION))
  },
  displayName: (slug) => readAgentDisplayName(slug) || slug,
  // GROMZONAMETAKEN1106 (the owner, Samu 71820): the main agent joins Gromzo under the name the owner set for it
  // (.env BOT_NAME, read per call like the dashboard's own label; "Marveen" when unset); every other agent under its
  // display name.
  gromzoName: (slug) => (slug === MAIN_AGENT_ID ? currentBotName() : readAgentDisplayName(slug) || slug),
  isRunning: (slug) => isAgentRunning(slug),
  // agentDir(slug) only for a slug slugRefusal passed (sendGromzoAvatar checks first; the list only names fleet agents).
  readAvatar: (slug) => readAgentAvatar(agentDir(slug)),
  avatarProblem: (slug) => avatarProblem(agentDir(slug)),
  // One tmux list-sessions per server for the whole list, not one sync call per agent.
  batch: (fn) => withTmuxBatch(fn),
  // MXDAGENTSOCKID1106: the agents' token protection from the same dash status (marveen-mxd main.rs status_agents):
  // agents.protected / agents.refused / agents.running (slugs only) and the top-level ratchet_unreadable. An older
  // mxd has none of these: null, and the rows show nothing.
  // One status call gives the list both the held agents and the protection.
  statusFacts: async () => {
    try {
      return statusFactsOf(await call({ verb: 'status' }))
    } catch { return { held: new Set<string>(), protection: null } }
  },
  held: async () => {
    // dash status carries held_agents only when it is not empty (marveen-mxd link.rs status).
    try {
      const r = await call({ verb: 'status' })
      const h = r.held_agents
      return new Set(Array.isArray(h) ? h.filter((x): x is string => typeof x === 'string' && MXD_AGENT_SLUG_RE.test(x)) : [])
    } catch { return new Set() }
  },
  restartOne: (slug) => {
    if (slug === MAIN_AGENT_ID) {
      // The launch side stopped (marketplace or .env): nothing to load, so no restart.
      const st = mainGromzoLaunchState()
      if (st === 'marketplace_failed' || st === 'env_failed') return
      // Switched off: mxd is not part of it (it keeps the main agent), so no wait and no held check; the
      // plugin goes with the next start, through the same pane gate.
      const tok = readMainGromzoToken(PROJECT_ROOT)
      if (tok.ok && !tok.on) {
        void restartMainForGromzoNow(mainRestartDeps()).catch((e) => logger.error({ err: e instanceof Error ? e.message : String(e) }, 'gromzo main agent: restart failed'))
        return
      }
      void restartMainAfterMxdReload(mainRestartDeps()).catch((e) => logger.error({ err: e instanceof Error ? e.message : String(e) }, 'gromzo main agent: restart failed'))
      return
    }
    void restartAfterMxdReload(slug).catch((e) => logger.error({ slug, err: e instanceof Error ? e.message : String(e) }, 'gromzo agents: restart failed'))
  },
  now: () => Date.now(),
}
let agentDeps: GromzoAgentDeps = defaultAgentDeps

/** The main session's restart for its Gromzo switch: the manual-restart pane gate, never forced. */
function mainRestartDeps() {
  return {
    status: () => call({ verb: 'status' }),
    gate: () => gateManualRestart(MAIN_CHANNELS_SESSION),
    restart: () => hardRestartMarveenChannels(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    mainSlug: MAIN_AGENT_ID,
  }
}

// --- GROMZOBRIDGEWIZARD1107 D1: the server sees an approval through ------------------------------------------------
// The pending consent is kept in store/ (0600; the consent id is the server's own, never the client's), and a watcher
// checks it without the panel (gromzo-agents.ts: the pace, "used", the final answers). Wired by initGromzoConsentWatch
// from web.ts only: a route test never touches the real store.

/** The saved pending consent: store/gromzo-agent-consent.json, mode 0600, written whole through a temp file. */
export function fileConsentStore(path = join(STORE_DIR, 'gromzo-agent-consent.json')): PendingConsentStore {
  return {
    read: () => {
      try { return JSON.parse(readFileSync(path, 'utf8')) } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'gromzo agents: the saved approval could not be read (none restored)')
        return []
      }
    },
    write: (entries) => {
      try {
        if (entries.length === 0) { rmSync(path, { force: true }); return }
        const tmp = `${path}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 })
        chmodSync(tmp, 0o600)
        renameSync(tmp, path)
      } catch (e) {
        // The consent stays in memory: the switch still works while this dashboard runs, only a restart would lose it.
        logger.error({ err: e instanceof Error ? e.message : String(e) }, 'gromzo agents: the pending approval could NOT be saved (kept in memory)')
      }
    },
  }
}

let watchOn = false
let watchTimer: ReturnType<typeof setTimeout> | null = null

/** One round of the server's own check of the pending consent (null: nothing pending, or the check failed and the
 *  consent is kept). Exported for the tests. */
export async function consentWatchTick(deps: GromzoAgentDeps = agentDeps): Promise<GromzoAgentOutcome | null> {
  const slug = pendingGromzoConsentSlug()
  if (!slug) return null
  try {
    const o = await checkGromzoAgent(slug, deps)
    if (o.ok && o.state === 'pending') return o
    if (o.ok && o.state === 'added') logger.info({ slug, by: 'server' }, 'gromzo agents: the owner approved in the app; the server finished the switch (no panel needed)')
    else logger.info({ slug, ...(o.ok ? { state: o.state } : { code: o.code }) }, 'gromzo agents: the server check got an answer')
    return o
  } catch (e) {
    logger.warn({ slug, code: e instanceof MxdDashError ? e.code : 'io' }, 'gromzo agents: the server check failed (the approval is kept, asked again)')
    return null
  }
}

/** Arms the next server check when a consent is pending and the watcher runs (a no-op otherwise). */
export function scheduleConsentWatch(): void {
  if (!watchOn || watchTimer) return
  const delay = watcherDelayMs(Date.now())
  if (delay === null) return
  watchTimer = setTimeout(() => {
    watchTimer = null
    void consentWatchTick().finally(scheduleConsentWatch)
  }, delay)
  watchTimer.unref?.()
}

/** From web.ts at start: the saved consent comes back, and (with the background services on) the watcher runs. A
 *  WEB_ONLY or second instance keeps the store but runs no watcher: finishing a switch restarts a live session. */
export function initGromzoConsentWatch(opts: { watch: boolean }): void {
  setPendingConsentStore(fileConsentStore())
  const restored = restorePendingGromzoConsents(agentDeps)
  if (restored) logger.info({ slug: restored }, 'gromzo agents: a pending approval came back after a restart')
  watchOn = opts.watch
  scheduleConsentWatch()
}

/** Test seam: the watcher off and its timer gone. */
export function stopGromzoConsentWatchForTest(): void {
  watchOn = false
  if (watchTimer) clearTimeout(watchTimer)
  watchTimer = null
}

/** Test seam: replace some of the agent switch's collaborators (null puts the real ones back). */
export function setGromzoAgentDepsForTest(deps: Partial<GromzoAgentDeps> | null): void {
  agentDeps = deps ? { ...defaultAgentDeps, ...deps } : defaultAgentDeps
}

function sendOutcome(res: http.ServerResponse, slug: string, action: string, o: GromzoAgentOutcome): void {
  if (o.ok) {
    logger.info({ slug, action, state: o.state }, 'gromzo agents: switch')
    json(res, o.state === 'pending' ? { state: o.state, expires_in: o.expiresIn } : { state: o.state })
    return
  }
  logger.warn({ slug, action, code: o.code, ...(o.added ? { added: o.added } : {}) }, 'gromzo agents: switch refused or failed')
  // consent_mismatch: mxd added ANOTHER agent than the one asked for (Dani 64260); the answer names it.
  if (o.added) json(res, { error: o.code, added_slug: o.added }, httpStatusFor(o.code))
  else failure(res, o.code)
}

async function handleAgents(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx
  const action = AGENT_ACTION_RE.exec(path)
  if (path !== AGENTS_PATH && !action) return false
  // Every action changes state (the consent check may add the agent, write its flag and restart it): POST only.
  const wantMethod = path === AGENTS_PATH ? 'GET' : 'POST'
  if (method !== wantMethod) { methodNotAllowed(res, method, [wantMethod]); return true }
  // GROMZONAMETAKEN1106: the switch-on may carry the owner's name for Gromzo ({"name": "..."}); every other action
  // sends an empty object, and nothing else in a body is read.
  let bodyName: string | undefined
  if (wantMethod === 'POST') {
    if (!isJsonRequest(req)) { json(res, { error: 'content_type_must_be_json' }, 415); return true }
    let raw: Buffer
    try { raw = await readBody(req, { maxBytes: 1024 }) } catch { json(res, { error: 'body_too_large' }, 413); return true }
    if (action?.[2] === 'enable' && raw.length > 0) {
      let parsed: unknown
      try { parsed = JSON.parse(raw.toString('utf8')) } catch { failure(res, 'bad_request'); return true }
      const n = parsed && typeof parsed === 'object' ? (parsed as { name?: unknown }).name : undefined
      if (n !== undefined && typeof n !== 'string') { failure(res, 'bad_request'); return true }
      bodyName = n
    }
  }
  if (!isOwnerSession(auth, req)) {
    logger.warn({ kind: auth?.kind, path }, 'gromzo agents: refused (needs the owner session)')
    json(res, OWNER_QR_SESSION_REQUIRED, 403)
    return true
  }
  if (!action) {
    json(res, await listGromzoAgentsWithStatus(agentDeps))
    return true
  }
  let slug: string
  try { slug = decodeURIComponent(action[1]!) } catch { failure(res, 'bad_request'); return true }
  // GROMZOMAINAGENT1106: "restart now" for the main agent's Gromzo switch, when the pane was busy before.
  if (action[2] === 'restart') {
    if (slug !== MAIN_AGENT_ID) { failure(res, 'bad_request'); return true }
    const st = await restartMainForGromzoNow(mainRestartDeps())
    logger.info({ state: st }, 'gromzo main agent: restart asked from the panel')
    json(res, { state: st })
    return true
  }
  try {
    const o = action[2] === 'enable' ? await enableGromzoAgent(slug, agentDeps, bodyName)
      : action[2] === 'disable' ? await disableGromzoAgent(slug, agentDeps)
        : await checkGromzoAgent(slug, agentDeps)
    // D1: a new pending consent is watched by the server from now on (the panel may close).
    if (action[2] === 'enable' && o.ok && o.state === 'pending') scheduleConsentWatch()
    sendOutcome(res, slug, action[2]!, o)
  } catch (e) {
    const code = e instanceof MxdDashError ? e.code : 'io'
    logger.warn({ slug, action: action[2], code }, 'gromzo agents: dash.sock failed')
    failure(res, code)
  }
  return true
}

export async function tryHandleGromzo(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx
  if (await handleAgents(ctx)) return true
  if (path !== STATUS_PATH && path !== OWNER_QR_PATH) return false

  if (path === STATUS_PATH) {
    if (method !== 'GET') { methodNotAllowed(res, method, ['GET']); return true }
    // GROMZOBRIDGEWIZARD1107 Q2: ?owner=1 asks mxd whether the team's owner has registered (marveen-mxd status
    // {owner:true}: a bool, cached there; a plain status never asks). An mxd from before that field refuses the
    // request: the plain status is asked again, and ownerSeat is simply absent.
    const wantOwner = ctx.url.searchParams.get('owner') === '1'
    try {
      let r = await call(wantOwner ? { verb: 'status', owner: true } : { verb: 'status' })
      if (wantOwner && r.ok !== true) r = await call({ verb: 'status' })
      if (r.ok !== true) {
        const code = typeof r.error === 'string' && /^[a-z0-9_]{1,40}$/.test(r.error) ? r.error : 'refused'
        json(res, { available: false, code })
        return true
      }
      const out: Record<string, unknown> = { available: true, running: r.running === true, linked: r.linked === true }
      // GROMZOLINKCONFIRM1106: mxd's status names a link that waits for the owner's confirmation (pending, with
      // its seconds left) and the last refused or failed one (last_refusal.kind). Without them the card could only
      // say "not linked yet" while the owner had 15 minutes to confirm on gromzo.com. Only these two shapes pass:
      // a whole number of seconds and a lower-case word; no address, no id, no secret.
      if (out.linked !== true) {
        const pending = r.pending as { op?: unknown; expires_in?: unknown } | undefined
        if (pending && pending.op === 'link' && typeof pending.expires_in === 'number'
          && Number.isSafeInteger(pending.expires_in) && pending.expires_in >= 0 && pending.expires_in <= 86400) {
          out.linkPendingExpiresIn = pending.expires_in
        }
        const refusal = r.last_refusal as { kind?: unknown } | undefined
        if (refusal && typeof refusal.kind === 'string' && /^[a-z_]{1,40}$/.test(refusal.kind)) out.linkRefusal = refusal.kind
      }
      // Only a bool passes (never an id); a failure only as a lower-case code.
      if (wantOwner && out.linked === true) {
        if (typeof r.owner_seat === 'boolean') out.ownerSeat = r.owner_seat
        else if (typeof r.owner_seat_error === 'string' && /^[a-z0-9_]{1,40}$/.test(r.owner_seat_error)) out.ownerSeatError = r.owner_seat_error
      }
      json(res, out)
    } catch (e) {
      const code = e instanceof MxdDashError ? e.code : 'io'
      json(res, { available: false, code })
    }
    return true
  }

  // OWNER_QR_PATH
  if (method !== 'POST') { methodNotAllowed(res, method, ['POST']); return true }
  if (!isJsonRequest(req)) { json(res, { error: 'content_type_must_be_json' }, 415); return true }
  // Drain the (empty) body; nothing in it is used.
  try { await readBody(req, { maxBytes: 1024 }) } catch { json(res, { error: 'body_too_large' }, 413); return true }
  const caller = ownerQrCaller(auth, req)
  if (!isOwnerSession(auth, req)) {
    logger.warn({ ...caller, kind: auth?.kind }, 'gromzo: owner QR refused (needs the owner session)')
    json(res, OWNER_QR_SESSION_REQUIRED, 403)
    return true
  }
  // The verbs asked of mxd, in order (owner_invite, then owner_login_code on a taken seat): which code was asked for.
  const asked: string[] = []
  const tracked: MxdDashCall = (request) => { asked.push(request.verb); return call(request) }
  let result
  try {
    result = await requestOwnerQr(tracked)
  } catch (e) {
    const code = e instanceof MxdDashError ? e.code : 'io'
    logger.warn({ ...caller, asked: asked.join('>'), code }, 'gromzo: owner QR failed (dash.sock)')
    failure(res, code)
    return true
  }
  if (!result.ok) {
    logger.warn({ ...caller, asked: asked.join('>'), code: result.code }, 'gromzo: owner QR refused by mxd')
    failure(res, result.code, result.retryAfter)
    return true
  }
  logger.info({ ...caller, asked: asked.join('>'), kind: result.qr.kind, expires_in: result.qr.expires_in }, 'gromzo: owner QR issued (the secret is not logged)')
  sendOwnerQr(res, result.qr)
  return true
}
