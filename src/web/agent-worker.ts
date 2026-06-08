import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, lstatSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import {
  capturePane,
  isSessionReadyForPrompt,
  sendPromptToSession,
  sessionExistsOnHost,
} from './agent-process.js'
import { readClaudeCodeOauthJson } from './claude-credentials.js'

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

const WORKER_SESSION = process.env.MARVEEN_WORKER_SESSION || 'marveen-worker'
// MUST be OUTSIDE PROJECT_ROOT so Claude Code's upward CLAUDE.md discovery never
// finds Marveen's persona CLAUDE.md -- one-shot generations (scaffold CLAUDE.md/
// SOUL.md for a NEW agent, memory digests) must be UNTINTED. The caller prompt
// is the only instruction. (Refinement #1.)
const WORKER_HOME = process.env.MARVEEN_WORKER_DIR || join(homedir(), '.marveen-worker')
const WORKER_CONFIG_DIR = join(WORKER_HOME, '.claude-config')
const SCRATCH_DIR = join(WORKER_HOME, 'scratch')
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

// --- single-worker mutex -------------------------------------------------------

// The worker is one interactive session -> one prompt at a time. Serialize all
// runViaWorker calls through a promise chain so an hourly heartbeat and an
// ad-hoc scheduled task never interleave on the same pane.
let workerChain: Promise<unknown> = Promise.resolve()
function withWorkerLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = workerChain.then(fn, fn)
  // Keep the chain alive regardless of this call's outcome.
  workerChain = run.then(() => undefined, () => undefined)
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
 *  - .claude.json with projects[WORKER_HOME] mirroring projects[PROJECT_ROOT]
 *    so the worker inherits Marveen's project-scoped MCP servers.
 * No CLAUDE.md is written here: the cwd is outside PROJECT_ROOT, so the worker
 * boots with a neutral context.
 */
export function ensureWorkerCwd(): void {
  if (!existsSync(WORKER_HOME)) mkdirSync(WORKER_HOME, { recursive: true })
  if (!existsSync(SCRATCH_DIR)) mkdirSync(SCRATCH_DIR, { recursive: true })

  const mcpPath = join(WORKER_HOME, '.mcp.json')
  if (!existsSync(mcpPath)) writeFileSync(mcpPath, '{"mcpServers":{}}\n')

  if (!existsSync(WORKER_CONFIG_DIR)) mkdirSync(WORKER_CONFIG_DIR, { recursive: true })

  const realClaude = join(homedir(), '.claude')
  if (existsSync(realClaude)) {
    for (const entry of readdirSync(realClaude)) {
      if (WORKER_CONFIG_SKIP.has(entry)) continue
      const linkPath = join(WORKER_CONFIG_DIR, entry)
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
  const settingsPath = join(WORKER_CONFIG_DIR, 'settings.json')
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

  // Subscription auth: materialise the host login JSON as .credentials.json.
  const credentialsJson = readClaudeCodeOauthJson()
  if (credentialsJson) {
    writeFileSync(join(WORKER_CONFIG_DIR, '.credentials.json'), credentialsJson, { mode: 0o600 })
  }

  // Inherit project-scoped MCP servers under the worker's own cwd key, AND
  // pre-accept the first-run dialogs so the headless interactive session never
  // parks on a modal (Trust folder / project onboarding). hasCompletedOnboarding
  // (global) suppresses the theme picker + login onboarding. We stamp the trust
  // flags on BOTH WORKER_HOME and its realpath (macOS /var, symlinked $HOME
  // edge-cases) since Claude Code keys trust by the resolved workspace path.
  try {
    const homeClaudeJson = join(homedir(), '.claude.json')
    const parsed: { projects?: Record<string, unknown>; hasCompletedOnboarding?: boolean; [k: string]: unknown } =
      existsSync(homeClaudeJson) ? JSON.parse(readFileSync(homeClaudeJson, 'utf-8')) : {}
    parsed.hasCompletedOnboarding = true
    const projects: Record<string, unknown> = (parsed.projects && typeof parsed.projects === 'object') ? parsed.projects : {}
    const base = (projects[PROJECT_ROOT] && typeof projects[PROJECT_ROOT] === 'object')
      ? projects[PROJECT_ROOT] as Record<string, unknown>
      : {}
    const trusted = { ...base, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1 }
    const keys = new Set<string>([WORKER_HOME])
    try { keys.add(realpathSync(WORKER_HOME)) } catch { /* dir may not resolve yet */ }
    for (const k of keys) projects[k] = { ...trusted }
    parsed.projects = projects
    writeFileSync(join(WORKER_CONFIG_DIR, '.claude.json'), JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
  } catch (err) {
    logger.warn({ err }, 'worker: failed to materialise .claude.json (worker may park on a first-run modal)')
  }
}

// --- session lifecycle ---------------------------------------------------------

function workerSessionExists(): boolean {
  return sessionExistsOnHost(null, WORKER_SESSION)
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Launch the interactive worker session if it is not already up. Subscription
 * login via the isolated CLAUDE_CONFIG_DIR; no --channels, bypassPermissions so
 * the Write-to-scratch capture works. Idempotent.
 */
export function startWorkerSession(): void {
  if (workerSessionExists()) return
  ensureWorkerCwd()
  // Detached session; launch claude via a login shell so PATH + the config-dir
  // env are set. The model suffix ([1m]) is single-quoted so it is not globbed.
  const launch =
    `export CLAUDE_CONFIG_DIR=${shArg(WORKER_CONFIG_DIR)}; ` +
    `cd ${shArg(WORKER_HOME)} && ` +
    `claude --dangerously-skip-permissions --model ${shArg(WORKER_MODEL)}`
  execFileSync(TMUX, ['new-session', '-d', '-s', WORKER_SESSION, '-c', WORKER_HOME, 'bash', '-lc', launch], { timeout: 8000 })
  logger.info({ session: WORKER_SESSION, cwd: WORKER_HOME }, 'agent-worker: launched interactive worker session')
}

function shArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

async function ensureWorkerReady(): Promise<boolean> {
  startWorkerSession()
  const deadline = Date.now() + WORKER_BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (isSessionReadyForPrompt(WORKER_SESSION)) return true
    await sleepMs(2000)
  }
  return false
}

function restartWorkerSession(): void {
  try { execFileSync(TMUX, ['kill-session', '-t', WORKER_SESSION], { timeout: 5000 }) } catch { /* not running */ }
  try { startWorkerSession() } catch (err) { logger.warn({ err }, 'agent-worker: restart failed') }
}

// Reset context between requests so unrelated one-shots never share/grow context.
function clearWorkerContext(): void {
  try {
    execFileSync(TMUX, ['send-keys', '-t', WORKER_SESSION, '-l', '/clear'], { timeout: 5000 })
    execFileSync('/bin/sleep', ['0.2'], { timeout: 2000 })
    execFileSync(TMUX, ['send-keys', '-t', WORKER_SESSION, 'Enter'], { timeout: 5000 })
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

/**
 * Run one prompt through the interactive worker and return its text output.
 * Serialized via the worker mutex. Returns text=null + error on timeout, a
 * mid-flight worker death (fail-fast + restart), or a non-ready worker.
 */
export async function runViaWorker(message: string, timeoutMs: number): Promise<{ text: string | null; error?: string }> {
  return withWorkerLock(async () => {
    const ready = await ensureWorkerReady()
    if (!ready) {
      logger.warn('agent-worker: worker not ready, failing request (text=null)')
      return { text: null, error: 'worker session not ready' }
    }

    const reqId = nextReqId()
    const outPath = join(SCRATCH_DIR, `${reqId}.out`)
    const donePath = join(SCRATCH_DIR, `${reqId}.done`)
    for (const p of [outPath, donePath]) { try { rmSync(p, { force: true }) } catch { /* none */ } }

    clearWorkerContext()
    sendPromptToSession(WORKER_SESSION, buildWorkerPrompt(message, outPath, donePath))

    const start = Date.now()
    try {
      while (true) {
        await sleepMs(CAPTURE_POLL_MS)
        const decision = decidePoll({
          doneExists: existsSync(donePath),
          sessionAlive: workerSessionExists(),
          elapsedMs: Date.now() - start,
          timeoutMs,
        })
        if (decision === 'ready') {
          const text = existsSync(outPath) ? readFileSync(outPath, 'utf-8') : null
          return { text: text && text.trim() ? text : null, error: text && text.trim() ? undefined : 'worker produced empty output' }
        }
        if (decision === 'timeout') {
          logger.warn({ reqId, timeoutMs }, 'agent-worker: request timed out')
          return { text: null, error: `worker timeout after ${Math.round(timeoutMs / 1000)}s` }
        }
        if (decision === 'dead') {
          logger.warn({ reqId }, 'agent-worker: session died mid-request, restarting (fail-fast)')
          restartWorkerSession()
          return { text: null, error: 'worker session died mid-request' }
        }
      }
    } finally {
      for (const p of [outPath, donePath]) { try { rmSync(p, { force: true }) } catch { /* best effort */ } }
    }
  })
}
