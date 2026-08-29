import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, SERVICE_ID } from '../config.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import {
  agentRunState,
  agentSessionName,
  restartAgentProcess,
  capturePane,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { respawnMainSessionFresh } from './channel-monitor.js'
import { paneLooksIdle } from '../pane-state.js'
import { readAutoRestartConfig } from './auto-restart-store.js'
import { restartDue, dailyDueAtMs, parseHHMM, mainRestartMechanism, restartBlockedBy, deferralOverride, type AutoRestartConfig } from '../auto-restart.js'
import { hasOpenInboundQuestion } from '../db.js'

// Drives per-agent scheduled restarts (see src/auto-restart.ts for the why and
// the pure due-logic). Mirrors the other watcher loops: a 60s sweep, started
// after the others to avoid piling tmux calls onto one tick.
//
// Two hard safety rules:
//   - IDLE-GUARD: never restart a session mid-turn (a busy pane), including the
//     main channels session -- that would cut off a live conversation. We defer
//     to the next tick until the pane is idle.
//   - SEED-ON-FIRST-SIGHT: on the first sweep we record "last restart = now" for
//     each enabled agent without acting, so a daily time that already passed
//     before the dashboard started does not trigger a spurious restart on boot.

const INITIAL_DELAY_MS = 40_000
const INTERVAL_MS = 60_000

// agent name -> last auto-restart time (ms). Also seeded on first sight (no
// restart) so a past-due daily slot does not fire at startup. In-memory: a
// dashboard restart re-seeds, at worst skipping one slot -- never double-fires.
const lastRestart = new Map<string, number>()

// agent name -> the current open-question deferral streak: when the condition
// was first seen (ms) and how many due restarts it has deferred so far.
// Cleared when the question is answered or a restart runs. In-memory like
// lastRestart: a dashboard restart resets the streak, at worst deferring one
// extra window -- never overriding early.
const openQuestionDeferrals = new Map<string, { sinceMs: number; count: number }>()

function localMidnightMs(nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function computeDueAt(cfg: AutoRestartConfig, name: string, nowMs: number): number | null {
  if (cfg.dailyTime) {
    const mins = parseHHMM(cfg.dailyTime)
    if (mins === null) return null
    return dailyDueAtMs(localMidnightMs(nowMs), mins)
  }
  if (cfg.intervalHours) {
    const base = lastRestart.get(name) ?? nowMs
    return base + cfg.intervalHours * 3_600_000
  }
  return null
}

function sessionFor(name: string): string {
  return name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
}

function paneIsIdle(session: string, host: string | null): boolean {
  const pane = capturePane(session, host)
  if (pane == null) return false
  return paneLooksIdle(pane)
}

// The main channels session always comes back as a FRESH conversation, so
// cfg.mode ('continue') never applies to it -- see buildMainSessionRespawnCmd's
// continueSession: false below and the launchd kickstart on macOS.
//
// Two platforms, two mechanisms. Splitting on the launchctl BINARY rather than
// process.platform is deliberate: the failure we hit was not "wrong OS" but
// "the binary this code unconditionally exec'd does not exist here", and the
// binary check is what actually predicts whether the call can work.
//
// Why this mattered: on Linux the launchctl leg threw ENOENT on every due slot.
// performRestart's throw left lastRestart unset, so the runner retried ~every
// tick, forever -- 248 WARN lines in one morning (2026-07-26) and, more to the
// point, the main agent's nightly restart had NEVER run on this host. The
// symptom was invisible: a log line nobody reads, while the dashboard showed
// auto-restart as enabled and correctly scheduled.
function restartMainChannelsSession(): void {
  if (mainRestartMechanism(existsSync('/bin/launchctl')) === 'launchd') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : ''
    // Label keys off SERVICE_ID (defaults to MAIN_AGENT_ID) so it matches the
    // launchd label the installer wrote. KeepAlive brings it straight back.
    execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.${SERVICE_ID}.channels`], { timeout: 10_000 })
    return
  }
  // Linux (and any host without launchd): reuse the SAME respawn path the
  // channel-deafness recovery uses, rather than a second hand-rolled tmux
  // command. That helper already carries the MCP startup env, the extra
  // channel plugins, the isolated config dir, the fleet token and the two
  // orphan reaps -- a bespoke command here would silently drift from it.
  respawnMainSessionFresh()
}

async function performRestart(name: string, cfg: AutoRestartConfig): Promise<void> {
  if (name === MAIN_AGENT_ID) {
    restartMainChannelsSession()
  } else {
    await restartAgentProcess(name, { fresh: cfg.mode === 'fresh' })
  }
}

async function checkAgent(name: string, nowMs: number): Promise<void> {
  const cfg = readAutoRestartConfig(name)
  if (!cfg.enabled) {
    lastRestart.delete(name) // re-seed cleanly if re-enabled later
    return
  }
  // Sub-agents must be up to be restarted; the main session is launchd-managed
  // (always considered present). Branch explicitly on the tri-state run state:
  // ONLY 'running' is eligible. 'unreachable' (remote laptop briefly out of
  // reach) is never auto-restarted -- the agent is almost certainly still alive
  // on the laptop, and restarting would be wrong AND risk a duplicate session
  // (the core SSH-independence invariant). 'stopped' is also left alone (auto-
  // restart cycles running sessions on a schedule; it does not resurrect dead
  // ones, matching the prior local behavior).
  if (name !== MAIN_AGENT_ID && agentRunState(name) !== 'running') return

  // Seed on first sight so a daily slot that already elapsed before boot does
  // not fire now.
  if (!lastRestart.has(name)) {
    lastRestart.set(name, nowMs)
    return
  }

  const dueAt = computeDueAt(cfg, name, nowMs)
  if (dueAt === null) return
  if (!restartDue(lastRestart.get(name) ?? null, nowMs, dueAt)) return

  const session = sessionFor(name)
  const host = name === MAIN_AGENT_ID ? null : readAgentRemoteHost(name)
  // An agent waiting on the owner's answer is idle precisely then -- so the
  // idle-guard alone lets a due restart swallow the pending exchange. The
  // ledger's open-question signal covers that case; a ledger read failure
  // counts as no-question (same fail-open as the context-restart gate) so a
  // broken ledger cannot pin restarts forever.
  const openQuestion = (() => {
    try { return hasOpenInboundQuestion(name) }
    catch { return false }
  })()
  // Track how long the open question has been deferring this agent. The signal
  // itself is clockless (an unanswered question stays open forever), so the
  // streak is what bounds the deferral.
  if (openQuestion) {
    if (!openQuestionDeferrals.has(name)) openQuestionDeferrals.set(name, { sinceMs: nowMs, count: 0 })
  } else {
    openQuestionDeferrals.delete(name)
  }
  const blocked = restartBlockedBy({ paneIdle: paneIsIdle(session, host), openQuestion })
  if (blocked) {
    const streak = openQuestionDeferrals.get(name) ?? null
    const capMs = cfg.openQuestionDeferralCapHours * 60 * 60 * 1000
    if (!deferralOverride(blocked, streak?.sinceMs ?? null, nowMs, capMs)) {
      if (streak !== null) streak.count += 1
      logger.info({ name, session, blocked,
        deferredCount: streak?.count ?? null,
        deferredForMs: streak === null ? null : nowMs - streak.sinceMs },
        'auto-restart: due but deferred to next tick')
      return
    }
    // The deferral must have an end AND a voice: past the cap the restart
    // proceeds, and the override is logged at warn so a permanently
    // unanswered question is distinguishable from normal operation.
    logger.warn({ name, session,
      deferredCount: (streak as { count: number }).count,
      deferredForMs: nowMs - (streak as { sinceMs: number }).sinceMs,
      capHours: cfg.openQuestionDeferralCapHours },
      'auto-restart: open-question deferral exceeded cap, restarting anyway')
  }

  try {
    await performRestart(name, cfg)
    lastRestart.set(name, nowMs)
    // A restart does not answer the question -- reset the streak so the next
    // due slot gets a full deferral window again instead of overriding at once.
    openQuestionDeferrals.delete(name)
    logger.info({ name, mode: name === MAIN_AGENT_ID ? 'fresh(main)' : cfg.mode }, 'auto-restart: restarted session')
  } catch (err) {
    logger.warn({ err, name }, 'auto-restart: restart failed')
  }
}

export function startAutoRestartRunner(): NodeJS.Timeout {
  let tickRunning = false
  async function sweep() {
    // Re-entrancy guard: checkAgent/performRestart now await a real
    // restartAgentProcess (no longer a blocking execSync('sleep N')), so a
    // sweep with a restart in flight can still be running when the next
    // interval fires. Skip an overlapping tick; the next tick re-evaluates
    // every agent, so nothing is missed.
    if (tickRunning) {
      logger.debug('auto-restart: previous sweep still running, skipping this tick')
      return
    }
    tickRunning = true
    try {
      const now = Date.now()
      try { await checkAgent(MAIN_AGENT_ID, now) } catch (err) { logger.debug({ err }, 'auto-restart: main check error') }
      for (const name of listAgentNames()) {
        try { await checkAgent(name, now) } catch (err) { logger.debug({ err, agent: name }, 'auto-restart: agent check error') }
      }
    } finally {
      tickRunning = false
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
