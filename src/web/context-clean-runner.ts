import { join } from 'node:path'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { logger } from '../logger.js'
import { STORE_DIR } from '../config.js'
import {
  listAgentNames,
  agentDir,
  readAgentClaudeConfigDir,
  readAgentRemoteHost,
  readAgentModel,
} from './agent-config.js'
import {
  agentRunState,
  agentSessionName,
  restartAgentProcess,
  capturePane,
  sendPromptToSession,
} from './agent-process.js'
import { paneLooksIdle } from '../pane-state.js'
import { readContextTokensFromProjectDir } from './active-model.js'
import { readContextCleanConfig } from './context-clean-store.js'
import { getRecentlyDoneCardsForAssignee } from '../db.js'
import {
  decideContextClean,
  normalizeSignal,
  normalizeResumeState,
  formatResumePrompt,
  parseHHMM,
  dailyDueAtMs,
  restartDue,
  INITIAL_STATE,
  NO_SIGNAL,
  type ContextCleanConfig,
  type ContextCleanState,
  type ContextCleanTrigger,
  type RestartSignal,
} from '../context-clean.js'

// Drives per-agent context cleans (see src/context-clean.ts for the why and the
// pure decision). Mirrors the auto-restart runner: a 60s sweep, offset from the
// others so tmux calls do not pile onto one tick. Sub-agents only -- the main
// channels session is launchd-managed and always starts a fresh conversation, so
// it has no accumulating context to clean here.
//
// Two trigger sources feed the same safe flow: the token threshold, and an
// optional schedule (daily time / every-N-hours) held in context-clean's OWN
// config -- deliberately NOT the legacy abrupt auto-restart loop, so the two
// watchers can never both fire a restart on one tick.
//
// Hard safety rules:
//   - EXPLICIT-READY: a fresh restart proceeds only on the agent's own signal,
//     the grace-cap, or the hard threshold -- never inferred from an idle pane.
//   - IDLE-GUARD: even when a restart is due, never cut a live turn; defer to the
//     next tick while the pane is busy.
//   - AUTO-RESUME: after the clean, the structured task-state the agent saved is
//     re-injected as its first prompt so it continues where it left off.
//   - POST-RESTART COOLDOWN: after a clean, skip the trigger logic for a window
//     so a stale context reading cannot immediately re-warn.

const INITIAL_DELAY_MS = 50_000
const INTERVAL_MS = 60_000
const COOLDOWN_MS = 5 * 60_000
// After a fresh restart the new session needs to boot before it can accept the
// resume prompt; wait at least this long (and for an idle pane) before injecting.
const BOOT_GRACE_MS = 45_000

// agent name -> tracked state across ticks.
const states = new Map<string, ContextCleanState>()
// agent name -> when it was last context-cleaned (ms), for the cooldown guard.
const lastClean = new Map<string, number>()
// agent name -> last schedule-triggered warn (ms). Also seeded on first sight (no
// warn) so a daily slot that already passed before boot does not fire at startup.
const lastScheduledWarn = new Map<string, number>()
// agent name -> high-water (whole seconds) of the newest done card already
// observed. Seeded on first sight so cards that were already done before boot do
// not fire a task-boundary clean at startup.
const lastSeenDoneSec = new Map<string, number>()
// agent name -> pending auto-resume after a restart (records when the restart
// happened so we can wait out the boot grace before injecting).
const pendingResume = new Map<string, { restartedAtMs: number }>()

// File names are derived from the agent name; guard so a malformed name can never
// escape STORE_DIR. Names from listAgentNames() are already real directory names,
// but the whitelist keeps this defensive.
function safeName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name)
}
function signalPathFor(name: string): string | null {
  return safeName(name) ? join(STORE_DIR, `restart-signal.${name}.json`) : null
}
function resumePathFor(name: string): string | null {
  return safeName(name) ? join(STORE_DIR, `resume-state.${name}.json`) : null
}

function readSignal(name: string): RestartSignal {
  const p = signalPathFor(name)
  if (!p || !existsSync(p)) return NO_SIGNAL
  try {
    return normalizeSignal(JSON.parse(readFileSync(p, 'utf-8')))
  } catch {
    return NO_SIGNAL
  }
}

function removeFile(p: string | null, name: string, what: string): void {
  if (p && existsSync(p)) {
    try { rmSync(p) } catch (err) { logger.debug({ err, name }, `context-clean: ${what} clear failed`) }
  }
}

function paneIsIdle(session: string, host: string | null): boolean {
  const pane = capturePane(session, host)
  if (pane == null) return false
  return paneLooksIdle(pane)
}

function localMidnightMs(nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// When is the next schedule slot due, or null if no schedule is configured.
// Mirrors the auto-restart runner's computeDueAt so the two behave identically.
function scheduleDueAt(cfg: ContextCleanConfig, name: string, nowMs: number): number | null {
  if (cfg.dailyTime) {
    const mins = parseHHMM(cfg.dailyTime)
    if (mins === null) return null
    return dailyDueAtMs(localMidnightMs(nowMs), mins)
  }
  if (cfg.intervalHours) {
    const base = lastScheduledWarn.get(name) ?? nowMs
    return base + cfg.intervalHours * 3_600_000
  }
  return null
}

// The warn prompt injected into the agent's session. It must be actionable on its
// own: the agent needs the exact signal + resume-state paths and copy-paste
// commands, since the whole point is that it can save + signal without any
// further hand-holding.
function buildWarnPrompt(
  name: string, ctx: number | null, cfg: ContextCleanConfig,
  trigger: ContextCleanTrigger, signalPath: string, resumePath: string,
): string {
  const k = (n: number) => `${Math.round(n / 1000)}K`
  const why =
    trigger === 'schedule' ? `Utemezett context-clean esedekes.`
    : trigger === 'task' ? `Egy hozzad rendelt kanban kartya DONE-ba kerult (feladat-hatar) -- ne vigyuk at a kesz feladat kontextusat a kovetkezobe.`
    : `A session-kontextusod elerte a ${k(ctx ?? 0)} tokent (kuszob ${k(cfg.softThreshold)}).`
  return [
    `[CONTEXT-CLEAN figyelmeztetes] ${why}`,
    `Hamarosan FRISS restart (context-clear) kovetkezik, hogy a session ne lassuljon be es ne fusson limitbe. A restart ELDOBJA a jelenlegi beszelgetest, ezert a mentes rajtad all.`,
    ``,
    `TEENDO most:`,
    `1) Ments el mindent amit meg kell orizned: memoria (/api/memories), napi naplo (/api/daily-log).`,
    `2) Strukturalt resume-state, hogy a restart UTAN automatikusan folytasd (a runner ezt injektalja elso promptkent):`,
    `   echo '{"activeTask":"...","currentStep":"...","relevantFiles":["..."],"nextAction":"...","notes":"..."}' > ${resumePath}`,
    `3) Ha KESZEN allsz a restartra, jelezd EXPLICIT modon (a runner NEM az idle-bol kovetkeztet):`,
    `   echo '{"hold":false,"ready":true}' > ${signalPath}`,
    `4) Ha epp meg-nem-szakithato kritikus lepes kozepen vagy (pl. multi-step git muvelet, fajliras), keslelteshetsz:`,
    `   echo '{"hold":true,"ready":false}' > ${signalPath}`,
    `   majd amikor vegeztel, ird at ready-re a 3) paranccsal.`,
    ``,
    `Ha ${cfg.graceMinutes} percen belul nem jelzel es nincs aktiv hold, a restart automatikusan megtortenik${trigger === 'token' ? `, vagy ha a kontextus eleri a ${k(cfg.hardThreshold)}-t` : ''}.`,
  ].join('\n')
}

// After a fresh restart, inject the saved structured task-state so the agent
// resumes on its own. No-op (beyond clearing the pending flag) if the agent never
// wrote a resume file or it carries no usable content.
function tryInjectResume(name: string, session: string, host: string | null): void {
  const p = resumePathFor(name)
  let rs = null
  if (p && existsSync(p)) {
    try { rs = normalizeResumeState(JSON.parse(readFileSync(p, 'utf-8'))) } catch { rs = null }
  }
  if (rs) {
    try {
      sendPromptToSession(session, formatResumePrompt(rs), host)
      logger.info({ name, activeTask: rs.activeTask }, 'context-clean: auto-resume injected after restart')
    } catch (err) {
      logger.warn({ err, name }, 'context-clean: resume injection failed')
    }
  }
  removeFile(p, name, 'resume-state')
  pendingResume.delete(name)
}

function checkAgent(name: string, nowMs: number): void {
  const cfg = readContextCleanConfig(name, readAgentModel(name))
  if (!cfg.enabled) {
    states.delete(name)
    lastScheduledWarn.delete(name)
    lastSeenDoneSec.delete(name)
    pendingResume.delete(name)
    return
  }

  // A pending auto-resume takes priority and survives the brief not-running gap
  // while the fresh session boots. Once the agent is back and settled, inject.
  const resume = pendingResume.get(name)
  if (resume) {
    if (agentRunState(name) !== 'running') return           // still booting
    if (nowMs - resume.restartedAtMs < BOOT_GRACE_MS) return // give it time to boot
    const session = agentSessionName(name)
    const host = readAgentRemoteHost(name)
    if (!paneIsIdle(session, host)) return                  // wait for a settled prompt
    tryInjectResume(name, session, host)
    return
  }

  // Only running sub-agents are eligible. 'unreachable' (remote laptop briefly
  // out of reach) and 'stopped' are left alone -- same invariant as auto-restart.
  if (agentRunState(name) !== 'running') {
    states.delete(name)
    return
  }

  // Seed the schedule + task-boundary high-water on first sight so a daily slot
  // or a card that was already done before boot does not fire now (mirrors
  // auto-restart's seed-on-first-sight).
  if (!lastScheduledWarn.has(name)) lastScheduledWarn.set(name, nowMs)
  const nowSec = Math.floor(nowMs / 1000)
  if (!lastSeenDoneSec.has(name)) lastSeenDoneSec.set(name, nowSec)

  const state = states.get(name) ?? { ...INITIAL_STATE }

  // Observe assigned cards that reached done since we last looked, then ALWAYS
  // advance the high-water so each done card is consumed exactly once -- even
  // while warned or in cooldown, so a card that finished mid-flow can never
  // re-fire a redundant clean right after the current one.
  let taskBoundaryObserved = false
  try {
    const done = getRecentlyDoneCardsForAssignee(name, lastSeenDoneSec.get(name) ?? nowSec)
    if (done.length > 0) {
      taskBoundaryObserved = true
      logger.info({ name, cards: done.map(c => c.id) }, 'context-clean: task-boundary (assigned card(s) done)')
    }
  } catch (err) {
    logger.debug({ err, name }, 'context-clean: done-card query failed')
  }
  lastSeenDoneSec.set(name, nowSec)

  // Post-restart cooldown: give the fresh session time to rotate its transcript
  // so a stale reading cannot immediately re-warn. (The high-water above is
  // already advanced, so a card done during cooldown is consumed, not re-fired.)
  const cleanedAt = lastClean.get(name)
  if (cleanedAt !== undefined && nowMs - cleanedAt < COOLDOWN_MS) return

  const ctx = readContextTokensFromProjectDir(agentDir(name), readAgentClaudeConfigDir(name) ?? undefined)
  const signal = readSignal(name)

  // Non-token triggers only matter from the idle phase (a warn already in flight
  // must not be re-armed by a passing slot or a card completing mid-flow).
  let scheduleDue = false
  const taskBoundaryDue = state.phase === 'idle' && taskBoundaryObserved
  if (state.phase === 'idle') {
    const dueAt = scheduleDueAt(cfg, name, nowMs)
    if (dueAt !== null) scheduleDue = restartDue(lastScheduledWarn.get(name) ?? null, nowMs, dueAt)
  }

  const action = decideContextClean(cfg, state, ctx, signal, nowMs, scheduleDue || taskBoundaryDue)

  switch (action) {
    case 'none':
    case 'wait':
      states.set(name, state)
      return

    case 'reset':
      states.set(name, { ...INITIAL_STATE })
      removeFile(signalPathFor(name), name, 'signal')
      logger.info({ name }, 'context-clean: context fell back below soft threshold, flow reset')
      return

    case 'warn': {
      const session = agentSessionName(name)
      const host = readAgentRemoteHost(name)
      const signalPath = signalPathFor(name)
      const resumePath = resumePathFor(name)
      if (!signalPath || !resumePath) {
        logger.warn({ name }, 'context-clean: unsafe agent name, skipping warn')
        return
      }
      // Clear any stale signal / resume from a previous flow before this one.
      removeFile(signalPath, name, 'signal')
      removeFile(resumePath, name, 'resume-state')
      // Precedence when several fired on the same tick: token > task > schedule.
      const trigger: ContextCleanTrigger =
        (ctx !== null && ctx >= cfg.softThreshold) ? 'token'
        : taskBoundaryDue ? 'task'
        : 'schedule'
      if (trigger === 'schedule') lastScheduledWarn.set(name, nowMs)
      try {
        sendPromptToSession(session, buildWarnPrompt(name, ctx, cfg, trigger, signalPath, resumePath), host)
        states.set(name, { phase: 'warned', warnedAtMs: nowMs, trigger })
        logger.info({ name, contextTokens: ctx, trigger }, 'context-clean: warned agent, awaiting save + signal')
      } catch (err) {
        logger.warn({ err, name }, 'context-clean: warn injection failed, will retry next tick')
        // Leave state idle so the next tick re-attempts the warn.
      }
      return
    }

    case 'restart': {
      const session = agentSessionName(name)
      const host = readAgentRemoteHost(name)
      // IDLE-GUARD: never cut a live turn. Stay 'warned' and retry next tick.
      if (!paneIsIdle(session, host)) {
        logger.info({ name, session }, 'context-clean: restart due but pane is busy, deferring to next tick')
        states.set(name, state)
        return
      }
      try {
        restartAgentProcess(name, { fresh: true })
        lastClean.set(name, nowMs)
        // Queue the auto-resume; the saved resume-state file (if any) survives the
        // restart on disk and gets injected once the fresh session boots.
        pendingResume.set(name, { restartedAtMs: nowMs })
        states.set(name, { ...INITIAL_STATE })
        removeFile(signalPathFor(name), name, 'signal')
        logger.info({ name }, 'context-clean: fresh restart performed, auto-resume queued')
      } catch (err) {
        logger.warn({ err, name }, 'context-clean: restart failed, will retry next tick')
        states.set(name, state)
      }
      return
    }
  }
}

export function startContextCleanRunner(): NodeJS.Timeout {
  function sweep() {
    const now = Date.now()
    for (const name of listAgentNames()) {
      try { checkAgent(name, now) } catch (err) { logger.debug({ err, agent: name }, 'context-clean: agent check error') }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
