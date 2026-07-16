import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT, RESPAWN_ENABLED, APP_TZ } from '../config.js'
import { resolveFromPath } from '../platform.js'
import { listAgentNames } from './agent-config.js'
import { isAgentRunning, capturePane, startAgentProcess } from './agent-process.js'
import { quarantineFleetTokenIfDead } from './claude-credentials-guard.js'
import { resolveAgentSession } from './channel-mcp-reconnect.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { detectReauthNeeded } from './reauth-detect.js'
import { loginSequence, literalKeyArgs, specialKeyArgs } from './tmux-keys.js'

// Autonomous re-auth healer (Adam stability-fix #1, scoped 2026-06-03).
//
// The watchdog only restarts MISSING sessions; the reauth badge only surfaces
// the dead-token state in the dashboard. Neither acts on a session that is
// ALIVE but whose OAuth token is dead (401) -- it silently stops working.
//
// There is NO magic full-heal for an expired OAuth: the /login flow needs a
// human browser authorize step, and a restart yields another unauthenticated
// session (cf. issue #248). So this loop is, honestly: autonomous DETECTION +
// best-effort /login (which recovers only the rare transient/refreshable case)
// + LOUD escalation to the owner via notify.sh (plugin-independent Bot API, so
// it reaches the owner even when the channel plugin is also wedged).
//
// Scope (Marveen-approved): sub-agents get best-effort /login send-keys +
// escalate; the MAIN agent (always-on channels session) is escalate-ONLY -- we
// do not inject /login into a live conversation autonomously. Production-host
// only (RESPAWN_ENABLED), like the other recovery loops.

const TMUX = resolveFromPath('tmux')
const NOTIFY_SCRIPT = join(PROJECT_ROOT, 'scripts', 'notify.sh')

const PROBE_INTERVAL_MS = 3 * 60 * 1000 // 3 min
const INITIAL_DELAY_MS = 90_000         // after boot-grace, offset from other watchers
const DEAD_PROBE_THRESHOLD = 3          // ~9 min of consecutive dead-token probes before acting
const ESCALATION_COOLDOWN_MS = 30 * 60 * 1000 // 1 alert / agent / 30 min (re-alerts if still dead)

export interface ReauthHealerState {
  consecutiveDead: number
  lastActionAtMs: number | null
}

export interface ReauthHealerInput {
  isDeadToken: boolean
  sessionAlive: boolean
  isMain: boolean
  /**
   * Whether this host can actually complete an interactive /login (a browser
   * authorize step). FALSE on a headless Linux box: there a /login send-keys can
   * never finish AND it rotates the SHARED single-use OAuth refresh token, which
   * kicks every other fleet process into 401 -- the auth cascade. So on headless
   * we escalate-only and never inject /login.
   */
  canInteractiveLogin: boolean
  /**
   * The pane shows Claude Code's FIRST-RUN gate (the "Select login method"
   * picker, or the browser sign-in screen it advances into), not a dead token.
   * A /login send-keys is actively harmful there: on the picker the trailing
   * Enter accepts a login method and launches a browser OAuth flow on a
   * session whose credential is VALID (2026-07-15 bootcamp). The heal is a
   * restart -- startAgentProcess re-seeds hasCompletedOnboarding.
   */
  isFirstRunGate?: boolean
  prev: ReauthHealerState
  nowMs: number
}

export interface ReauthHealerThresholds {
  threshold: number
  cooldownMs: number
}

export interface ReauthHealerDecision {
  sendKeys: boolean   // best-effort autonomous /login (sub-agents only)
  restartAgent: boolean // first-run-gate heal: restart the sub-agent (re-seeds the onboarding flag)
  escalate: boolean   // notify.sh alert to the owner
  next: ReauthHealerState
}

export const NO_REAUTH_STATE: ReauthHealerState = { consecutiveDead: 0, lastActionAtMs: null }

/**
 * Pure decision for the healer. A clean probe (token healed, or session gone)
 * resets the spell. A confirmed dead-token-but-alive session escalates once the
 * consecutive count reaches `threshold`, then re-fires no more than once per
 * `cooldownMs`. send-keys is gated to the same cadence (so /login is not spammed
 * into the session every tick) and never fires for the main agent.
 */
export function decideReauthAction(input: ReauthHealerInput, t: ReauthHealerThresholds): ReauthHealerDecision {
  const { isDeadToken, sessionAlive, isMain, canInteractiveLogin, isFirstRunGate, prev, nowMs } = input

  // Clean / not-applicable: end the spell, allow a fresh alert next time.
  if (!isDeadToken || !sessionAlive) {
    return { sendKeys: false, restartAgent: false, escalate: false, next: NO_REAUTH_STATE }
  }

  const consecutiveDead = prev.consecutiveDead + 1
  const atThreshold = consecutiveDead >= t.threshold
  const cooldownElapsed = prev.lastActionAtMs == null || (nowMs - prev.lastActionAtMs) >= t.cooldownMs
  const fireNow = atThreshold && cooldownElapsed

  return {
    // Autonomous /login only where it can actually help: a sub-agent, at a host
    // that can complete the browser step. On headless it would amplify the
    // cascade (rotates the shared token), so suppress it and escalate-only.
    // NEVER on the first-run gate: a /login there advances the picker into a
    // browser OAuth flow on a valid credential.
    sendKeys: fireNow && !isMain && canInteractiveLogin && isFirstRunGate !== true,
    // First-run gate on a sub-agent: a restart heals it (startAgentProcess runs
    // ensureSharedClaudeOnboarded first). Works headless -- no browser step.
    // The main agent stays escalate-only; its monitored respawn paths re-seed.
    restartAgent: fireNow && !isMain && isFirstRunGate === true,
    escalate: fireNow,
    next: {
      consecutiveDead,
      lastActionAtMs: fireNow ? nowMs : prev.lastActionAtMs,
    },
  }
}

// True when this host can complete an interactive browser /login. macOS dev
// hosts can; a headless Linux fleet host (no display server) cannot -- and there
// a /login both fails AND rotates the shared OAuth token into a fleet-wide 401
// cascade, so we escalate-only instead (BUG #1.3 from the isapp06 report).
function hostCanInteractiveLogin(): boolean {
  if (process.platform === 'darwin') return true
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

const watchState = new Map<string, ReauthHealerState>()

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

// Fire-and-forget best-effort /login into a sub-agent session. Reuses the same
// scripted sequence as the dashboard button (loginSequence('start')).
async function sendBestEffortLogin(session: string): Promise<void> {
  for (const step of loginSequence('start')) {
    const args = step.kind === 'literal' ? literalKeyArgs(session, step.text) : specialKeyArgs(session, step.key)
    if (args) {
      await new Promise<void>((resolve) => {
        execFile(TMUX, args, { timeout: 5000 }, () => resolve())
      })
    }
    if (step.delayMs > 0) await sleep(step.delayMs)
  }
}

// -- Quiet hours (23:00-06:00 in the install zone, config.APP_TZ) ------------
//
// Overnight a dead token is not actionable: the fix is a manual browser
// /login, and nobody does that at 03:00 -- but the healer used to re-alert
// every 30 minutes all night (2026-07-09: spock+scotty alerted until morning).
// Inside the window the PROBE keeps running and the state stays accurate;
// ONLY the notify.sh escalation is held back. The first sweep after 06:00
// sends ONE summary naming the agents that are STILL dead at that moment
// (suppressed intermediates are dropped, healed agents are dropped silently),
// and the normal 30-min re-alert cadence resumes from that summary.
export const QUIET_START_HOUR = 23 // inclusive
export const QUIET_END_HOUR = 6    // exclusive

export function isQuietHour(hourLocal: number): boolean {
  return hourLocal >= QUIET_START_HOUR || hourLocal < QUIET_END_HOUR
}

// Wall-clock hour in the install zone (config.APP_TZ) regardless of the host TZ,
// the same explicit-TZ rule the whole fleet follows for time handling.
export function localHour(nowMs: number): number {
  return parseInt(
    new Intl.DateTimeFormat('en-GB', { timeZone: APP_TZ, hour: '2-digit', hour12: false }).format(new Date(nowMs)),
    10,
  )
}

export interface QuietSuppressedEntry {
  session: string
  label: string
  reason: string
  consecutiveDead: number
}

const quietSuppressed = new Map<string, QuietSuppressedEntry>()

export function buildEscalationMessage(label: string, reason: string, consecutiveDead: number): string {
  // Dynamic duration: consecutiveDead probes at PROBE_INTERVAL_MS each. On a
  // re-alert (after the 30min cooldown, still dead) this grows past the initial
  // ~9min, so a hardcoded value would lie -- compute it from the probe count.
  const approxMin = Math.round((consecutiveDead * PROBE_INTERVAL_MS) / 60_000)
  return `🔐 A(z) ${label} ágens halott OAuth tokent jelez (${reason}) több mint ~${approxMin} perce. Manuális browser /login kell a dashboardon (az ügynök kártyáján a "Bejelentkezés" gomb), automatikusan nem gyógyítható.`
}

export function buildQuietSummaryMessage(entries: QuietSuppressedEntry[]): string {
  const lines = entries.map((e) => {
    const approxMin = Math.round((e.consecutiveDead * PROBE_INTERVAL_MS) / 60_000)
    return `• ${e.label}: ${e.reason} (~${approxMin} perce)`
  })
  return [
    `🔐 Reggeli token-összegzés: az éjszakai csendes sáv (${QUIET_START_HOUR}:00-0${QUIET_END_HOUR}:00) alatt elnyomott riasztások. MOST IS halott tokent jelez:`,
    ...lines,
    'Manuális browser /login kell a dashboardon (az ügynök kártyáján a "Bejelentkezés" gomb).',
  ].join('\n')
}

/**
 * Route one escalation decision: outside quiet hours notify immediately;
 * inside, record it for the morning summary instead. Pure over its deps so
 * the night->morning sequence is simulatable in tests.
 */
export function routeEscalation(
  entry: QuietSuppressedEntry,
  quiet: boolean,
  notify: (msg: string) => void,
  suppressed: Map<string, QuietSuppressedEntry> = quietSuppressed,
): void {
  if (quiet) {
    suppressed.set(entry.session, entry)
    logger.warn({ label: entry.label, session: entry.session, reason: entry.reason }, 'reauth-healer: dead token escalation suppressed (quiet hours), queued for morning summary')
    return
  }
  notify(buildEscalationMessage(entry.label, entry.reason, entry.consecutiveDead))
}

/**
 * First sweep after quiet hours: send ONE summary for agents still dead now,
 * stamp their cooldown from the summary (it IS an alert), and drop everything
 * else silently. No-op while still quiet or when nothing was suppressed.
 */
export function flushQuietSummary(
  quiet: boolean,
  stillDeadCount: (session: string) => number,
  notify: (msg: string) => void,
  stampAlert: (session: string) => void,
  suppressed: Map<string, QuietSuppressedEntry> = quietSuppressed,
): void {
  if (quiet || suppressed.size === 0) return
  const entries = [...suppressed.values()]
  suppressed.clear()
  const stillDead = entries
    .map((e) => ({ ...e, consecutiveDead: stillDeadCount(e.session) }))
    .filter((e) => e.consecutiveDead > 0)
  if (stillDead.length === 0) return
  notify(buildQuietSummaryMessage(stillDead))
  for (const e of stillDead) stampAlert(e.session)
}

function sendNotify(msg: string): void {
  execFile('/bin/bash', [NOTIFY_SCRIPT, msg], { timeout: 10_000 }, (err) => {
    if (err) logger.warn({ err }, 'reauth-healer: notify.sh escalation failed')
  })
}

function checkSession(label: string, session: string, isMain: boolean, quiet: boolean): void {
  const pane = capturePane(session)
  const sessionAlive = pane != null
  const reauth = detectReauthNeeded(pane)
  const prev = watchState.get(session) ?? NO_REAUTH_STATE
  // The reasons produced by the two first-run-gate markers in reauth-detect.
  const isFirstRunGate = /onboarding picker|sign-in screen/i.test(reauth.reason ?? '')

  const decision = decideReauthAction(
    { isDeadToken: reauth.needsReauth, sessionAlive, isMain, canInteractiveLogin: hostCanInteractiveLogin(), isFirstRunGate, prev, nowMs: Date.now() },
    { threshold: DEAD_PROBE_THRESHOLD, cooldownMs: ESCALATION_COOLDOWN_MS },
  )

  if (decision.next.consecutiveDead === 0) {
    watchState.delete(session)
    // A healed agent's suppressed overnight alert is obsolete -- drop it so it
    // never appears in the morning summary.
    quietSuppressed.delete(session)
  } else {
    watchState.set(session, decision.next)
  }

  if (decision.sendKeys) {
    logger.warn({ label, session }, 'reauth-healer: confirmed dead token on live sub-agent -- best-effort /login send-keys')
    void sendBestEffortLogin(session)
  }
  if (decision.restartAgent) {
    logger.warn({ label, session, reason: reauth.reason }, 'reauth-healer: first-run gate on live sub-agent -- restarting it (re-seeds hasCompletedOnboarding)')
    void restartFirstRunGatedAgent(label, session)
  }
  if (decision.escalate) {
    logger.error({ label, session, reason: reauth.reason, quiet }, 'reauth-healer: dead OAuth token on live session -- escalating to owner')
    routeEscalation(
      { session, label, reason: reauth.reason ?? 'auth failure', consecutiveDead: decision.next.consecutiveDead },
      quiet,
      sendNotify,
    )
    // A genuine 401 family failure while a fleet token exists: probe that token
    // once and quarantine it if the probe proves it dead (server-side
    // revocation). Without this there is NO recovery path -- every new launch
    // re-injects the dead env token (which strictly overrides valid file
    // creds), and a manual delete would be undone by the boot sync. Cadence is
    // bounded by the escalation cooldown. Skipped for the first-run gate: the
    // credential there is typically fine.
    if (!isFirstRunGate) {
      quarantineFleetTokenIfDead()
        .then((r) => { if (r !== 'no-token') logger.warn({ label, result: r }, 'reauth-healer: fleet-token liveness check') })
        .catch((err) => logger.debug({ err }, 'reauth-healer: fleet-token liveness check failed'))
    }
  }
}

// First-run-gate heal for a SUB-agent: kill the parked session (nothing is
// in-flight -- the TUI is blocked pre-boot on the picker) and relaunch it;
// startAgentProcess runs ensureSharedClaudeOnboarded before the fresh claude
// starts, so the relaunch comes up past the gate.
async function restartFirstRunGatedAgent(name: string, session: string): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile(TMUX, ['kill-session', '-t', session], { timeout: 5000 }, () => resolve())
  })
  await sleep(1000)
  try {
    const r = startAgentProcess(name)
    if (!r.ok) logger.warn({ name, error: r.error }, 'reauth-healer: first-run-gate relaunch failed')
  } catch (err) {
    logger.warn({ err, name }, 'reauth-healer: first-run-gate relaunch threw')
  }
}

export function startReauthHealer(): NodeJS.Timeout | null {
  // Production-host only, like the other recovery loops: sending /login keys on
  // a dev box would fight the production host (and there is nothing to heal).
  if (!RESPAWN_ENABLED) {
    logger.info('reauth-healer disabled (respawn is production-only)')
    return null
  }

  function sweep(): void {
    const quiet = isQuietHour(localHour(Date.now()))
    // Main agent: escalate-only (no autonomous /login into a live always-on
    // conversation). capturePane returns null when it is down -> spell ends.
    try {
      checkSession(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, true, quiet)
    } catch (err) {
      logger.debug({ err }, 'reauth-healer: main agent check error')
    }
    for (const name of listAgentNames()) {
      const session = resolveAgentSession(name)
      if (!isAgentRunning(name)) {
        watchState.delete(session)
        quietSuppressed.delete(session)
        continue
      }
      try {
        checkSession(name, session, false, quiet)
      } catch (err) {
        logger.debug({ err, agent: name }, 'reauth-healer: agent check error')
      }
    }
    // First sweep after 06:00: one summary for the agents still dead now.
    // The summary counts as the alert, so the 30-min cadence restarts from it.
    flushQuietSummary(
      quiet,
      (session) => watchState.get(session)?.consecutiveDead ?? 0,
      sendNotify,
      (session) => {
        const st = watchState.get(session)
        if (st) watchState.set(session, { ...st, lastActionAtMs: Date.now() })
      },
    )
  }

  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, PROBE_INTERVAL_MS)
}
