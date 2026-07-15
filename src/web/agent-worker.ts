import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, lstatSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { createHash } from 'node:crypto'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import {
  capturePane,
  isSessionReadyForPrompt,
  sendPromptToSession,
  sessionExistsOnHost,
} from './agent-process.js'
import { readClaudeCodeOauthJson } from './claude-credentials.js'
import { detectPaneState } from '../pane-state.js'
import { notifyChannel } from '../notify.js'

// =============================================================================
// Interactive-tmux agent worker (jun.15 subscription migration).
//
// runAgent() used to spawn the Claude Agent SDK (`query`), which bills on the
// API (the jun.15 change). This drives a SINGLE always-on INTERACTIVE Claude
// Code session in tmux instead -- which runs on the host's own ~/.claude
// SUBSCRIPTION login, exactly like the fleet agents. The 4 runAgent callers
// (heartbeat, memory digest, schedules, scaffold) and llm-breakdown all route
// through here unchanged.
//
// Reliability bonus (beyond billing): the worker is launched WITHOUT any
// channel plugin (isolated CLAUDE_CONFIG_DIR with enabledPlugins:{}), so it can
// never open a second Telegram getUpdates long-poll -- which is what caused the
// 409 Conflict that killed the live bot and clustered ~65% of restarts right
// after every hourly heartbeat.
//
// Output capture is via a TEMP-FILE sentinel, NOT pane-scrape: the callers need
// clean multi-line markdown (full CLAUDE.md / SOUL.md) and JSON, which terminal
// wrapping + ANSI + scrollback would corrupt. The worker is told to Write its
// answer to <reqid>.out and signal with <reqid>.done; runAgent polls the files.
// =============================================================================

const TMUX = resolveFromPath('tmux')

const WORKER_MODEL = process.env.MARVEEN_WORKER_MODEL || 'claude-opus-4-8[1m]'

// How long to wait for a freshly launched worker to reach an idle prompt.
const WORKER_BOOT_TIMEOUT_MS = 90_000
// Poll cadence while waiting for the <reqid>.done sentinel.
const CAPTURE_POLL_MS = 1_500
// Channel plugins to force-disable in the worker's isolated settings.json.
const WORKER_DISABLED_PLUGINS = ['telegram', 'slack-channel']
// ~/.claude entries NOT symlinked into the isolated config dir:
//  - settings.json: we own it (enabledPlugins:{} override).
//  - CLAUDE.md: skipped so global user memory never tints one-shot gens (refinement #1).
const WORKER_CONFIG_SKIP = new Set(['settings.json', 'CLAUDE.md', '.DS_Store', '.lock'])

// --- Per-session context ------------------------------------------------------
//
// Each interactive Claude Code session (slow + fast) has its own home dir and
// isolated CLAUDE_CONFIG_DIR so they never share a Telegram long-poll connection
// (the root cause of the 409 Conflicts; see the comment at the top of this file).
// All per-session mutable state (promise-chain mutex, stuck-alert timer) lives
// in WorkerCtx so tests can instantiate independent contexts.

export interface WorkerCtx {
  readonly session: string
  readonly home: string
  readonly configDir: string
  readonly scratchDir: string
  chain: Promise<unknown>
  lastStuckAlert: number
}

export function makeWorkerCtx(session: string, homeDir: string): WorkerCtx {
  return {
    session,
    home: homeDir,
    configDir: join(homeDir, '.claude-config'),
    scratchDir: join(homeDir, 'scratch'),
    chain: Promise.resolve() as Promise<unknown>,
    lastStuckAlert: 0,
  }
}

// Slow session: long-running tasks (analysis, reports, search). The original
// worker -- all existing callers default to this. Session name keys off
// MAIN_AGENT_ID (per #611) so notify.sh's "${MAIN_AGENT_ID}-worker" branch
// matches on renamed installs; default installs stay "marveen-worker". The
// WORKER_DIR stays fixed (.marveen-worker) -- the config-dir hash depends on it.
const ctxSlow = makeWorkerCtx(
  process.env.MARVEEN_WORKER_SESSION || `${MAIN_AGENT_ID}-worker`,
  process.env.MARVEEN_WORKER_DIR || join(homedir(), '.marveen-worker'),
)
// Fast session: short, conversational tasks (< 300 chars, no analysis keywords).
// Separate home + config dir eliminates any shared state with the slow session.
const ctxFast = makeWorkerCtx(
  process.env.MARVEEN_WORKER_SESSION_FAST || `${MAIN_AGENT_ID}-worker-fast`,
  process.env.MARVEEN_WORKER_DIR_FAST || join(homedir(), '.marveen-worker-fast'),
)

// --- Message priority routing -------------------------------------------------
//
// Short, conversational messages go to the fast session; anything that suggests
// a long-running analysis or search goes to the slow session. Exported so the
// routing logic is unit-testable without live sessions.

const SLOW_MESSAGE_KEYWORDS = /elemezd|keresd|összefoglaló|analyze|search|summary|report/i
const FAST_MESSAGE_MAX_LEN = 300

export function classifyPriority(message: string): 'fast' | 'slow' {
  if (message.length >= FAST_MESSAGE_MAX_LEN) return 'slow'
  if (SLOW_MESSAGE_KEYWORDS.test(message)) return 'slow'
  return 'fast'
}

// =============================================================================
// macOS auth precedence (discovered 2026-06-10 debugging the worker 401):
// when CLAUDE_CONFIG_DIR is a non-default path, Claude Code reads the OAuth
// token from a PATH-HASHED macOS Keychain service:
//     "Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0:8]>"  (acct = $USER)
// and this Keychain entry takes PRECEDENCE over <CONFIG_DIR>/.credentials.json.
// The interactive worker wrote this entry on a prior login; its access token
// then expired, and Claude kept reading the STALE Keychain entry -- ignoring a
// freshly re-seeded .credentials.json -- which is the silent 401 from the bake.
//
// Fix: the file must be authoritative. We (1) re-seed .credentials.json from the
// host's default `Claude Code-credentials` Keychain entry (which the host's own
// interactive sessions keep fresh), and (2) DELETE the path-hashed Keychain
// entry so Claude falls back to the fresh file. Verified: with the path-hashed
// entry absent, the worker config dir authenticates from the file; a `-p` run
// does not recreate it. See [[claude-config-dir-isolation-auth]].
// =============================================================================

// Claude Code prints these in its own error chrome when auth is dead. Matched
// against the pane TAIL only (its status area), so unrelated task content
// deeper in scrollback that merely mentions "401" does not false-trip.
const WORKER_AUTH_FAILURE_RX =
  /Please run \/login|Not logged in|Invalid bearer token|Invalid authentication credentials|API Error:\s*401|OAuth (?:token|authentication) (?:has )?expired|Failed to authenticate/i

/**
 * The macOS Keychain service name Claude Code uses for a given CLAUDE_CONFIG_DIR.
 * sha256(configDir)[0:8] suffix -- reverse-engineered + verified 2026-06-10
 * against the live worker (sha256("/Users/marvin/.marveen-worker/.claude-config")
 * -> "1d2e1367"). Pure + exported so the locked test vector guards the algorithm.
 */
export function configDirKeychainService(configDir: string): string {
  const suffix = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `Claude Code-credentials-${suffix}`
}

function workerKeychainService(ctx: WorkerCtx): string {
  return configDirKeychainService(ctx.configDir)
}

/** Delete the worker's path-hashed Keychain entry so .credentials.json is the
 * authoritative source. No-op if absent. Never touches the host default entry. */
function clearWorkerKeychainEntry(ctx: WorkerCtx): void {
  try {
    execFileSync('/usr/bin/security',
      ['delete-generic-password', '-s', workerKeychainService(ctx), '-a', userInfo().username],
      { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] })
  } catch { /* absent -> nothing to clear */ }
}

/**
 * Make the worker's file-based credentials authoritative + fresh:
 *  1. materialise the host's current login JSON as <CONFIG_DIR>/.credentials.json
 *     (the host keeps its `Claude Code-credentials` token fresh);
 *  2. delete the stale path-hashed Keychain entry that would otherwise shadow it.
 * Cheap (two `security` calls) so it is safe to run before every (re)boot. Off
 * macOS readClaudeCodeOauthJson returns null and the worker runs logged-out.
 * Returns true if a credential file was written.
 */
function seedWorkerCredentials(ctx: WorkerCtx): boolean {
  if (process.platform === 'darwin') clearWorkerKeychainEntry(ctx)
  const credentialsJson = readClaudeCodeOauthJson()
  if (!credentialsJson) return false
  if (!existsSync(ctx.configDir)) mkdirSync(ctx.configDir, { recursive: true })
  writeFileSync(join(ctx.configDir, '.credentials.json'), credentialsJson, { mode: 0o600 })
  return true
}

/** Scan the worker pane tail for Claude Code's auth-failure chrome. */
function workerPaneHasAuthFailure(ctx: WorkerCtx): boolean {
  const pane = capturePane(ctx.session)
  if (!pane) return false
  const tail = pane.split('\n').slice(-30).join('\n')
  return WORKER_AUTH_FAILURE_RX.test(tail)
}

// --- pure, unit-testable logic -------------------------------------------------

/**
 * Build the per-request prompt: the caller's prompt verbatim, plus a transport
 * directive telling the worker to Write its answer to a scratch file (capture
 * mechanism) instead of printing it. The directive is transport, NOT content --
 * the caller prompt remains the only *content* instruction.
 */
export function buildWorkerPrompt(callerPrompt: string, outPath: string, donePath: string): string {
  return [
    callerPrompt,
    '',
    '---',
    'OUTPUT INSTRUCTIONS (delivery mechanism, not part of the task):',
    `1. Write your COMPLETE response -- and nothing else, no commentary, no code fences around it unless the task itself asks -- to this exact file using the Write tool:`,
    `   ${outPath}`,
    `2. Then write the single word done to:`,
    `   ${donePath}`,
    'Do not print the response in the chat. Those two files are your only output.',
  ].join('\n')
}

/**
 * Coarse classification of a NOT-ready worker pane, used by the boot-time
 * self-heal. TS port of scripts/stuck-modal-guard.sh classify_pane (the
 * channels-session guard), tuned for the worker:
 *  - 'busy'/'idle': a live turn or a healthy prompt -- never self-heal these;
 *  - 'auth': the login/401 chrome -- handled by the existing auth recovery;
 *  - 'modal': confirm/option-list chrome without an idle footer (e.g. the CC
 *    2.1.202 fullscreen-renderer upsell, or whatever first-run dialog a future
 *    CC ships) -- the self-heal target;
 *  - 'empty': inconclusive (still booting);
 *  - 'unknown': text without any recognised marker -- also a self-heal target,
 *    because an unrecognised full-screen overlay hides the idle footer.
 */
export type WorkerPaneClass = 'idle' | 'busy' | 'auth' | 'modal' | 'empty' | 'unknown'

export function classifyWorkerPane(pane: string | null): WorkerPaneClass {
  if (pane == null || pane.trim() === '') return 'empty'
  const tail = pane.split('\n').slice(-30).join('\n')
  if (WORKER_AUTH_FAILURE_RX.test(tail)) return 'auth'
  const st = detectPaneState(pane)
  if (st === 'busy') return 'busy'
  if (st === 'idle' || st === 'typing') return 'idle'
  // Modal chrome: a numbered option list or a confirm footer. Matches the
  // fullscreen-upsell dialog captured live on 2026-07-08 and the Trust-folder /
  // onboarding dialog family.
  if (/Enter to confirm|Esc to cancel|❯\s*1\./.test(pane)) return 'modal'
  return 'unknown'
}

/** Pure decision: should the boot poll attempt a self-heal for this pane class? */
export function shouldSelfHeal(cls: WorkerPaneClass): boolean {
  return cls === 'modal' || cls === 'unknown'
}

export type PollDecision = 'ready' | 'timeout' | 'dead' | 'wait'

/**
 * Decide the next poll action from observable state. Pure so the
 * done/timeout/liveness policy is testable without a live session.
 *  - done sentinel present            -> 'ready'
 *  - past the deadline                -> 'timeout'
 *  - worker session vanished mid-run  -> 'dead' (fail-fast, don't wait out the
 *                                        full timeout; refinement #2)
 *  - otherwise                        -> 'wait'
 * `done` is checked FIRST so a request that completed in the same tick the
 * session died still returns its result.
 */
export function decidePoll(opts: {
  doneExists: boolean
  sessionAlive: boolean
  elapsedMs: number
  timeoutMs: number
}): PollDecision {
  if (opts.doneExists) return 'ready'
  if (opts.elapsedMs >= opts.timeoutMs) return 'timeout'
  if (!opts.sessionAlive) return 'dead'
  return 'wait'
}

// --- per-session mutex ---------------------------------------------------------

function withWorkerLockFor<T>(ctx: WorkerCtx, fn: () => Promise<T>): Promise<T> {
  const run = ctx.chain.then(fn, fn)
  // Keep the chain alive regardless of this call's outcome.
  ctx.chain = run.then(() => undefined, () => undefined)
  return run
}

// --- isolated worker cwd / config ---------------------------------------------

function lstatSyncSafe(p: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(p) } catch { return null }
}

interface WorkerSettings { enabledPlugins?: Record<string, boolean>; [k: string]: unknown }

/**
 * Build (idempotently) the worker's isolated cwd + CLAUDE_CONFIG_DIR:
 *  - empty project .mcp.json (defense in depth);
 *  - config dir symlinks every ~/.claude entry EXCEPT settings.json + CLAUDE.md
 *    (so auth/transcripts/marketplaces stay shared, persona memory does not);
 *  - settings.json with every channel plugin disabled (no 409);
 *  - .credentials.json seeded from the host login (subscription auth);
 *  - .claude.json with projects[ctx.home] mirroring projects[PROJECT_ROOT]
 *    so the worker inherits Marveen's project-scoped MCP servers.
 * No CLAUDE.md is written here: the cwd is outside PROJECT_ROOT, so the worker
 * boots with a neutral context.
 */
export function ensureWorkerCwd(ctx: WorkerCtx = ctxSlow): void {
  if (!existsSync(ctx.home)) mkdirSync(ctx.home, { recursive: true })
  if (!existsSync(ctx.scratchDir)) mkdirSync(ctx.scratchDir, { recursive: true })

  const mcpPath = join(ctx.home, '.mcp.json')
  if (!existsSync(mcpPath)) writeFileSync(mcpPath, '{"mcpServers":{}}\n')

  if (!existsSync(ctx.configDir)) mkdirSync(ctx.configDir, { recursive: true })

  const realClaude = join(homedir(), '.claude')
  if (existsSync(realClaude)) {
    for (const entry of readdirSync(realClaude)) {
      if (WORKER_CONFIG_SKIP.has(entry)) continue
      const linkPath = join(ctx.configDir, entry)
      const target = join(realClaude, entry)
      let needsLink = true
      const st = lstatSyncSafe(linkPath)
      if (st) {
        if (st.isSymbolicLink()) needsLink = false
        else rmSync(linkPath, { recursive: true, force: true })
      }
      if (needsLink) {
        try { symlinkSync(target, linkPath) }
        catch (err) { logger.warn({ err, target, linkPath }, 'worker: failed to symlink config entry') }
      }
    }
  }

  // settings.json: own it; force all channel plugins off (merge-preserve any
  // hook config Claude Code wrote in a prior run).
  const settingsPath = join(ctx.configDir, 'settings.json')
  let current: WorkerSettings = {}
  const sst = lstatSyncSafe(settingsPath)
  if (sst?.isSymbolicLink()) {
    rmSync(settingsPath, { force: true })
  } else if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as WorkerSettings
    } catch { /* rewrite */ }
  }
  const enabledPlugins: Record<string, boolean> = { ...(current.enabledPlugins ?? {}) }
  for (const p of WORKER_DISABLED_PLUGINS) enabledPlugins[p] = false
  // skipDangerousModePermissionPrompt: suppress the "Bypass Permissions mode"
  // first-run warning so the headless worker (launched with
  // --dangerously-skip-permissions) reaches its prompt without a blocking modal.
  writeFileSync(settingsPath, JSON.stringify({ ...current, enabledPlugins, skipDangerousModePermissionPrompt: true }, null, 2) + '\n')

  // Subscription auth: materialise the host login JSON as .credentials.json AND
  // clear the stale path-hashed Keychain entry that would shadow it (see the
  // macOS auth-precedence note at the top of this file).
  seedWorkerCredentials(ctx)

  // Inherit project-scoped MCP servers under the worker's own cwd key, AND
  // pre-accept the first-run dialogs so the headless interactive session never
  // parks on a modal (Trust folder / project onboarding). hasCompletedOnboarding
  // (global) suppresses the theme picker + login onboarding. We stamp the trust
  // flags on BOTH ctx.home and its realpath (macOS /var, symlinked $HOME
  // edge-cases) since Claude Code keys trust by the resolved workspace path.
  try {
    const homeClaudeJson = join(homedir(), '.claude.json')
    const parsed: { projects?: Record<string, unknown>; hasCompletedOnboarding?: boolean; [k: string]: unknown } =
      existsSync(homeClaudeJson) ? JSON.parse(readFileSync(homeClaudeJson, 'utf-8')) : {}
    stampWorkerFirstRun(parsed)
    const projects: Record<string, unknown> = (parsed.projects && typeof parsed.projects === 'object') ? parsed.projects : {}
    const base = (projects[PROJECT_ROOT] && typeof projects[PROJECT_ROOT] === 'object')
      ? projects[PROJECT_ROOT] as Record<string, unknown>
      : {}
    const trusted = { ...base, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1 }
    const keys = new Set<string>([ctx.home])
    try { keys.add(realpathSync(ctx.home)) } catch { /* dir may not resolve yet */ }
    for (const k of keys) projects[k] = { ...trusted }
    parsed.projects = projects
    writeFileSync(join(ctx.configDir, '.claude.json'), JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
  } catch (err) {
    logger.warn({ err }, 'worker: failed to materialise .claude.json (worker may park on a first-run modal)')
  }
}

/**
 * Pre-accept Claude Code's global first-run chrome for the worker so a fresh
 * install's very first generation call never parks on a modal:
 *  - hasCompletedOnboarding: theme picker + login onboarding;
 *  - fullscreenUpsellSeenCount: the CC >=2.1.202 "Try the new fullscreen
 *    renderer?" upsell, which otherwise sits over the input box and the 90s
 *    boot poll times out. Stamped HIGH (never lowered) so the modal never
 *    renders. We deliberately do NOT opt INTO the fullscreen renderer: the
 *    worker's whole output pipeline is a tmux capture-pane scrape and the
 *    pane-state heuristics assume the classic renderer's layout.
 * Pure (mutates the parsed object only) so it is unit-testable; idempotent and
 * harmless on CC versions that do not know these keys.
 */
export function stampWorkerFirstRun(parsed: { hasCompletedOnboarding?: boolean; fullscreenUpsellSeenCount?: unknown; [k: string]: unknown }): void {
  parsed.hasCompletedOnboarding = true
  const seen = Number(parsed.fullscreenUpsellSeenCount)
  parsed.fullscreenUpsellSeenCount = Number.isFinite(seen) ? Math.max(99, seen) : 99
}

// --- session lifecycle ---------------------------------------------------------

function workerSessionExists(ctx: WorkerCtx): boolean {
  return sessionExistsOnHost(null, ctx.session)
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Launch one interactive worker session if it is not already up. Subscription
 * login via the isolated CLAUDE_CONFIG_DIR; no --channels, bypassPermissions so
 * the Write-to-scratch capture works. Idempotent.
 */
function startWorkerSessionFor(ctx: WorkerCtx): void {
  if (workerSessionExists(ctx)) return
  ensureWorkerCwd(ctx)
  // Detached session; launch claude via a login shell so PATH + the config-dir
  // env are set. The model suffix ([1m]) is single-quoted so it is not globbed.
  const launch =
    `export CLAUDE_CONFIG_DIR=${shArg(ctx.configDir)}; ` +
    `cd ${shArg(ctx.home)} && ` +
    `claude --dangerously-skip-permissions --model ${shArg(WORKER_MODEL)}`
  execFileSync(TMUX, ['new-session', '-d', '-s', ctx.session, '-c', ctx.home, 'bash', '-lc', launch], { timeout: 8000 })
  logger.info({ session: ctx.session, cwd: ctx.home }, 'agent-worker: launched interactive worker session')
  logWorkerClaudeVersion(ctx)
}

/**
 * Pre-start both worker sessions. Called at server startup to amortise boot
 * latency across first requests. Idempotent -- a running session is a no-op.
 */
export function startWorkerSession(): void {
  startWorkerSessionFor(ctxSlow)
  startWorkerSessionFor(ctxFast)
}

/**
 * Log the Claude Code version the worker will run and persist the last seen
 * value; a change since the previous boot gets a WARN so a CC upgrade (the
 * usual source of brand-new first-run chrome, like the 2.1.202 fullscreen
 * upsell) is visible in the log timeline instead of being reverse-engineered
 * from a stuck pane. Best effort: a probe failure never blocks the boot.
 */
function logWorkerClaudeVersion(ctx: WorkerCtx): void {
  try {
    const claudeBin = resolveFromPath('claude')
    const v = execFileSync(claudeBin, ['--version'], { encoding: 'utf-8', timeout: 10_000 }).trim()
    const stampPath = join(ctx.home, '.last-claude-version')
    const prev = existsSync(stampPath) ? readFileSync(stampPath, 'utf-8').trim() : null
    if (prev && prev !== v) {
      logger.warn({ prev, current: v }, 'agent-worker: Claude Code version changed since the last worker boot -- watch for new first-run chrome')
    } else {
      logger.info({ version: v }, 'agent-worker: claude version')
    }
    writeFileSync(stampPath, v + '\n')
  } catch (err) {
    logger.warn({ err }, 'agent-worker: claude version probe failed (continuing)')
  }
}

function shArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Give a booting worker this long to reach an idle prompt on its own before
// the self-heal inspects the pane: normal boot chrome (MOTD, plugin load)
// resolves well within this window, so Escape is never fired into a healthy
// startup sequence.
const WORKER_SELF_HEAL_GRACE_MS = 20_000
// Bounded Escape presses against a parked dialog, with a ready-recheck between.
const WORKER_SELF_HEAL_MAX_ESCAPES = 3
// Operator alert at most once per hour per session, so a persistently broken
// worker does not spam the channel while still never failing silently.
const WORKER_STUCK_ALERT_COOLDOWN_MS = 60 * 60 * 1000

/**
 * One bounded self-heal pass for a worker parked on unexpected chrome:
 * Escape up to N times (rechecking between), then a full session restart if
 * the pane still is not healthy. Never touches a busy/idle/auth pane.
 * Returns true if it acted.
 */
function selfHealWorkerOnce(ctx: WorkerCtx): boolean {
  const cls = classifyWorkerPane(capturePane(ctx.session))
  if (!shouldSelfHeal(cls)) return false
  logger.warn({ cls, session: ctx.session }, 'agent-worker: pane parked on unexpected chrome -- bounded Escape self-heal')
  for (let i = 0; i < WORKER_SELF_HEAL_MAX_ESCAPES; i++) {
    try { execFileSync(TMUX, ['send-keys', '-t', ctx.session, 'Escape'], { timeout: 5000 }) } catch { break }
    try { execFileSync('/bin/sleep', ['0.5'], { timeout: 2000 }) } catch { /* best effort */ }
    const now = classifyWorkerPane(capturePane(ctx.session))
    if (now === 'idle' || now === 'busy') {
      logger.info({ escapes: i + 1, session: ctx.session }, 'agent-worker: self-heal cleared the parked chrome via Escape')
      return true
    }
  }
  logger.warn({ session: ctx.session }, 'agent-worker: Escape did not clear the parked chrome -- restarting the worker session')
  restartWorkerSession(ctx)
  return true
}

/** Loud, rate-limited operator signal: the worker never became ready. */
function alertWorkerStuck(ctx: WorkerCtx, paneTail: string): void {
  logger.error({ paneTail, session: ctx.session }, 'agent-worker: worker never became ready (agent-gen / capability-summary / heartbeat / digest consumers will fail)')
  if (Date.now() - ctx.lastStuckAlert < WORKER_STUCK_ALERT_COOLDOWN_MS) return
  ctx.lastStuckAlert = Date.now()
  void notifyChannel(
    `⚠️ Marveen worker [${ctx.session}]: a hatter-worker session nem all keszen (beragadt dialogus vagy ismeretlen kepernyo). Onjavitas lefutott (Escape + restart), de a keszenlet nem allt helyre. Erintett: agens-generalas, capability-osszefoglalo, heartbeat, digest. Nezz ra: tmux attach -t ${ctx.session}`,
  ).catch(() => { /* notifyChannel logs internally */ })
}

async function ensureWorkerReady(ctx: WorkerCtx): Promise<boolean> {
  startWorkerSessionFor(ctx)
  const start = Date.now()
  const deadline = start + WORKER_BOOT_TIMEOUT_MS
  let healed = false
  while (Date.now() < deadline) {
    if (isSessionReadyForPrompt(ctx.session)) return true
    if (!healed && Date.now() - start > WORKER_SELF_HEAL_GRACE_MS) {
      healed = true
      try { selfHealWorkerOnce(ctx) } catch (err) { logger.warn({ err }, 'agent-worker: self-heal pass failed') }
    }
    await sleepMs(2000)
  }
  const pane = capturePane(ctx.session)
  alertWorkerStuck(ctx, (pane ?? '').split('\n').slice(-12).join('\n'))
  return false
}

function restartWorkerSession(ctx: WorkerCtx): void {
  try { execFileSync(TMUX, ['kill-session', '-t', ctx.session], { timeout: 5000 }) } catch { /* not running */ }
  try { startWorkerSessionFor(ctx) } catch (err) { logger.warn({ err, session: ctx.session }, 'agent-worker: restart failed') }
}

// Reset context between requests so unrelated one-shots never share/grow context.
function clearWorkerContext(ctx: WorkerCtx): void {
  try {
    execFileSync(TMUX, ['send-keys', '-t', ctx.session, '-l', '/clear'], { timeout: 5000 })
    execFileSync('/bin/sleep', ['0.2'], { timeout: 2000 })
    execFileSync(TMUX, ['send-keys', '-t', ctx.session, 'Enter'], { timeout: 5000 })
    execFileSync('/bin/sleep', ['0.5'], { timeout: 2000 })
  } catch (err) {
    logger.warn({ err }, 'agent-worker: /clear failed (continuing)')
  }
}

let reqCounter = 0
function nextReqId(): string {
  reqCounter = (reqCounter + 1) % 1_000_000
  return `${Date.now().toString(36)}-${reqCounter}`
}

// Outcome of one worker attempt. 'auth' is split out from 'fail' so the caller
// can recover (reseed + restart) once, then signal an SDK fallback.
type AttemptResult =
  | { kind: 'ok'; text: string | null; error?: string }
  | { kind: 'auth' }
  | { kind: 'fail'; error: string }

async function runWorkerAttempt(ctx: WorkerCtx, message: string, timeoutMs: number): Promise<AttemptResult> {
  const ready = await ensureWorkerReady(ctx)
  if (!ready) {
    // A non-ready worker can be a dead auth (the session boots, prints the
    // login/401 chrome, never reaches an idle prompt) -- distinguish it.
    if (workerPaneHasAuthFailure(ctx)) return { kind: 'auth' }
    logger.warn({ session: ctx.session }, 'agent-worker: worker not ready, failing request (text=null)')
    return { kind: 'fail', error: 'worker session not ready' }
  }

  const reqId = nextReqId()
  const outPath = join(ctx.scratchDir, `${reqId}.out`)
  const donePath = join(ctx.scratchDir, `${reqId}.done`)
  for (const p of [outPath, donePath]) { try { rmSync(p, { force: true }) } catch { /* none */ } }

  clearWorkerContext(ctx)
  sendPromptToSession(ctx.session, buildWorkerPrompt(message, outPath, donePath))

  const start = Date.now()
  try {
    while (true) {
      await sleepMs(CAPTURE_POLL_MS)
      const decision = decidePoll({
        doneExists: existsSync(donePath),
        sessionAlive: workerSessionExists(ctx),
        elapsedMs: Date.now() - start,
        timeoutMs,
      })
      if (decision === 'ready') {
        const text = existsSync(outPath) ? readFileSync(outPath, 'utf-8') : null
        return { kind: 'ok', text: text && text.trim() ? text : null, error: text && text.trim() ? undefined : 'worker produced empty output' }
      }
      // Not done yet: catch a mid-flight auth failure (the access token can
      // expire while the session is up) BEFORE burning the full timeout.
      if (workerPaneHasAuthFailure(ctx)) {
        logger.warn({ reqId, session: ctx.session }, 'agent-worker: auth failure detected mid-request')
        return { kind: 'auth' }
      }
      if (decision === 'timeout') {
        logger.warn({ reqId, timeoutMs, session: ctx.session }, 'agent-worker: request timed out')
        return { kind: 'fail', error: `worker timeout after ${Math.round(timeoutMs / 1000)}s` }
      }
      if (decision === 'dead') {
        logger.warn({ reqId, session: ctx.session }, 'agent-worker: session died mid-request, restarting (fail-fast)')
        restartWorkerSession(ctx)
        return { kind: 'fail', error: 'worker session died mid-request' }
      }
    }
  } finally {
    for (const p of [outPath, donePath]) { try { rmSync(p, { force: true }) } catch { /* best effort */ } }
  }
}

/**
 * Run one prompt through the interactive worker and return its text output.
 * Routes to the fast or slow session based on message length + keyword heuristic
 * (overridable via the `priority` parameter). Serialized within each session via
 * its own mutex so slow and fast tasks never block each other. Returns
 * text=null + error on timeout, a mid-flight worker death (fail-fast + restart),
 * or a non-ready worker.
 *
 * Auth self-healing: on an auth failure (stale path-hashed Keychain token /
 * expired login) the worker re-seeds its credentials, clears the shadowing
 * Keychain entry, restarts, and retries ONCE. If it still fails, it returns
 * authFailed=true so runAgent can fall back to the SDK backend for this call
 * rather than dying silently (the 2026-06-10 bake failure mode).
 */
export async function runViaWorker(
  message: string,
  timeoutMs: number,
  priority?: 'fast' | 'slow',
): Promise<{ text: string | null; error?: string; authFailed?: boolean }> {
  const p = priority ?? classifyPriority(message)
  const ctx = p === 'fast' ? ctxFast : ctxSlow
  return withWorkerLockFor(ctx, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await runWorkerAttempt(ctx, message, timeoutMs)
      if (r.kind === 'ok') return { text: r.text, error: r.error }
      if (r.kind === 'fail') {
        // A momentary not-ready is TRANSIENT, not terminal: the boot-time
        // self-heal (or a plain restart here) usually brings the worker back,
        // and every consumer (agent-gen, capability-summary, heartbeat,
        // digest) reaches this single choke point -- so one central retry
        // fixes them all. Mirrors the auth-recovery retry-once shape above.
        if (r.error === 'worker session not ready' && attempt === 0) {
          logger.warn({ session: ctx.session }, 'agent-worker: worker not ready -- restarting once and retrying the request')
          restartWorkerSession(ctx)
          continue
        }
        return { text: null, error: r.error }
      }
      // r.kind === 'auth'
      if (attempt === 0) {
        logger.warn({ session: ctx.session }, 'agent-worker: auth failure -> recovering (reseed creds + clear keychain + restart)')
        seedWorkerCredentials(ctx)
        restartWorkerSession(ctx)
        continue
      }
      logger.error({ session: ctx.session }, 'agent-worker: auth failure persists after recovery -> signalling SDK fallback (authFailed)')
      return { text: null, error: 'worker auth failed (401/login) after recovery', authFailed: true }
    }
    return { text: null, error: 'worker auth failed', authFailed: true }
  })
}
