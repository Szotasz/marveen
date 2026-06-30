import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT, RESPAWN_ENABLED } from '../config.js'
import { resolveFromPath } from '../platform.js'
import { listAgentNames } from './agent-config.js'
import { isAgentRunning, capturePane } from './agent-process.js'
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
  prev: ReauthHealerState
  nowMs: number
}

export interface ReauthHealerThresholds {
  threshold: number
  cooldownMs: number
}

export interface ReauthHealerDecision {
  sendKeys: boolean   // best-effort autonomous /login (sub-agents only)
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
  const { isDeadToken, sessionAlive, isMain, canInteractiveLogin, prev, nowMs } = input

  // Clean / not-applicable: end the spell, allow a fresh alert next time.
  if (!isDeadToken || !sessionAlive) {
    return { sendKeys: false, escalate: false, next: NO_REAUTH_STATE }
  }

  const consecutiveDead = prev.consecutiveDead + 1
  const atThreshold = consecutiveDead >= t.threshold
  const cooldownElapsed = prev.lastActionAtMs == null || (nowMs - prev.lastActionAtMs) >= t.cooldownMs
  const fireNow = atThreshold && cooldownElapsed

  return {
    // Autonomous /login only where it can actually help: a sub-agent, at a host
    // that can complete the browser step. On headless it would amplify the
    // cascade (rotates the shared token), so suppress it and escalate-only.
    sendKeys: fireNow && !isMain && canInteractiveLogin,
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

function escalate(label: string, reason: string, consecutiveDead: number): void {
  // Dynamic duration: consecutiveDead probes at PROBE_INTERVAL_MS each. On a
  // re-alert (after the 30min cooldown, still dead) this grows past the initial
  // ~9min, so a hardcoded value would lie -- compute it from the probe count.
  const approxMin = Math.round((consecutiveDead * PROBE_INTERVAL_MS) / 60_000)
  const msg = `🔐 A(z) ${label} ágens halott OAuth tokent jelez (${reason}) több mint ~${approxMin} perce. Manuális browser /login kell a dashboardon (az ügynök kártyáján a "Bejelentkezés" gomb), automatikusan nem gyógyítható.`
  execFile('/bin/bash', [NOTIFY_SCRIPT, msg], { timeout: 10_000 }, (err) => {
    if (err) logger.warn({ err, label }, 'reauth-healer: notify.sh escalation failed')
  })
}

function checkSession(label: string, session: string, isMain: boolean): void {
  const pane = capturePane(session)
  const sessionAlive = pane != null
  const reauth = detectReauthNeeded(pane)
  const prev = watchState.get(session) ?? NO_REAUTH_STATE

  const decision = decideReauthAction(
    { isDeadToken: reauth.needsReauth, sessionAlive, isMain, canInteractiveLogin: hostCanInteractiveLogin(), prev, nowMs: Date.now() },
    { threshold: DEAD_PROBE_THRESHOLD, cooldownMs: ESCALATION_COOLDOWN_MS },
  )

  if (decision.next.consecutiveDead === 0) {
    watchState.delete(session)
  } else {
    watchState.set(session, decision.next)
  }

  if (decision.sendKeys) {
    logger.warn({ label, session }, 'reauth-healer: confirmed dead token on live sub-agent -- best-effort /login send-keys')
    void sendBestEffortLogin(session)
  }
  if (decision.escalate) {
    logger.error({ label, session, reason: reauth.reason }, 'reauth-healer: dead OAuth token on live session -- escalating to owner')
    escalate(label, reauth.reason ?? 'auth failure', decision.next.consecutiveDead)
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
    // Main agent: escalate-only (no autonomous /login into a live always-on
    // conversation). capturePane returns null when it is down -> spell ends.
    try {
      checkSession(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, true)
    } catch (err) {
      logger.debug({ err }, 'reauth-healer: main agent check error')
    }
    for (const name of listAgentNames()) {
      const session = resolveAgentSession(name)
      if (!isAgentRunning(name)) {
        watchState.delete(session)
        continue
      }
      try {
        checkSession(name, session, false)
      } catch (err) {
        logger.debug({ err, agent: name }, 'reauth-healer: agent check error')
      }
    }
  }

  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, PROBE_INTERVAL_MS)
}
