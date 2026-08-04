import { statSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { hardRestartMarveenChannels, lastMainRespawnAt, MARVEEN_POST_RESPAWN_GRACE_MS } from './channel-monitor.js'
import { shouldDeferForRecentRespawn } from './stuck-tool-call-watcher.js'
import { listAgentNames, listAllAgentNames, agentDir, readAgentModel, readAgentClaudeConfigDir, readAgentRemoteHost } from './agent-config.js'
import {
  agentRunState,
  agentSessionName,
  restartAgentProcess,
  capturePane,
  sendPromptToSession,
  isSessionReadyForPrompt,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { detectPaneState, paneShowsContextSaturation } from '../pane-state.js'
import { readContextTokensFromProjectDir, readActiveModelFromProjectDir } from './active-model.js'
import { readContextGuardConfig } from './context-guard-store.js'
import { createAgentMessage } from '../db.js'
import {
  decideGuard,
  contextLimitForModel,
  calibrateLimit,
  INITIAL_GUARD_STATE,
  type GuardState,
  type GuardInputs,
} from '../context-guard.js'

// Fleet context guard (kanban #81): acts BEFORE a session drowns in its own
// context. Sweep every agent (main included) every five minutes; at actPct ask the
// agent to write HANDOFF.md, then fresh-restart it and inject a resume prompt
// pointing at the handoff. The always-on saturation net additionally rescues a
// pane already showing "100% context used" -- unreachable by prompt dispatch,
// so nothing else can recover it (samu stall, 2026-07-18). See
// src/context-guard.ts for the why and the pure state machine; this module is
// only the I/O, mirroring auto-restart-runner.
//
// Remote-host agents are skipped: their transcripts live on the remote machine,
// so the context size cannot be measured here (v1 limitation, logged once).

const INITIAL_DELAY_MS = 270_000
const INTERVAL_MS = 300_000

// agent name -> guard state. In-memory: a dashboard restart re-arms every
// agent at 'idle', which is safe -- the worst case is a repeated handoff
// request, and cooldown prevents restart loops within a run.
const guardStates = new Map<string, GuardState>()
const remoteSkipLogged = new Set<string>()

// Per-agent observed-context high-water mark, persisted across dashboard
// restarts. calibrateLimit alone is memoryless: the moment the guard
// restarts an agent, the fresh session's observation shrinks back below the
// tier step-up point, the denominator falls back to the base guess, and a
// miscalibrated agent gets restarted at the same false "over-full" reading
// every cycle -- the evidence that would have corrected the limit is
// destroyed by the very restart it triggered. Persisting the per-(agent,
// model) maximum breaks that loop: once a session has proven the window is
// bigger, the proof survives restarts. Keyed by model so a real model
// downgrade (e.g. fable-5 -> haiku) does not inherit a 1M denominator.
const HIGHWATER_PATH = join(PROJECT_ROOT, 'store', 'context-guard-highwater.json')
type HighwaterMap = Record<string, { model: string; tokens: number }>

function readHighwater(): HighwaterMap {
  try {
    const parsed = JSON.parse(readFileSync(HIGHWATER_PATH, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed as HighwaterMap : {}
  } catch { return {} }
}

let highwater: HighwaterMap | null = null

function observedHighwater(name: string, model: string, observedNow: number): number {
  if (highwater === null) highwater = readHighwater()
  const entry = highwater[name]
  const prior = entry && entry.model === model ? entry.tokens : 0
  if (observedNow > prior) {
    highwater[name] = { model, tokens: observedNow }
    try { writeFileSync(HIGHWATER_PATH, JSON.stringify(highwater, null, 2)) }
    catch (err) { logger.warn({ err }, 'context-guard: highwater persist failed') }
  }
  return Math.max(observedNow, prior)
}

function sessionFor(name: string): string {
  return name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
}

function workingDirFor(name: string): string {
  return name === MAIN_AGENT_ID ? PROJECT_ROOT : agentDir(name)
}

function handoffPathFor(name: string): string {
  return join(workingDirFor(name), 'HANDOFF.md')
}

function handoffMtime(name: string): number | null {
  try { return statSync(handoffPathFor(name)).mtimeMs } catch { return null }
}

export function handoffPrompt(pctRound: number, handoffPath: string): string {
  return (
    `[CONTEXT-GUARD] A munkakontextusod ~${pctRound}%-on van -- kritikus. ` +
    `NE folytasd a feladatot. EGYETLEN dolgod ebben a körben: írj HANDOFF.md-t a /handoff skill struktúrája szerint ide: ${handoffPath} ` +
    `(purpose: a folyamatban lévő feladat folytatása friss kontextusban; Goal / Current Progress / What Worked / What Didn't Work / Next Steps szekciók, ` +
    `konkrét fájl-útvonalakkal és kanban kártya-azonosítókkal). Ha nincs aktív feladatod, írd bele hogy nincs. ` +
    `Utána ÁLLJ MEG -- a rendszer friss kontextussal újraindít és a HANDOFF.md-ből folytatod.`
  )
}

export function resumePrompt(name: string, handoffPath: string, hadHandoff: boolean): string {
  const base =
    `[CONTEXT-GUARD] Friss kontextussal indultál, mert az előző session kontextusa megtelt (auto-handoff). `
  const source = hadHandoff
    ? `Első lépés: olvasd be ${handoffPath} -- ez az előző session átadója. `
    : `HANDOFF.md nem készült el időben, ezért az élő forrásokból dolgozz. `
  return (
    base + source +
    `Utána ellenőrizd a kanban tábládat (in_progress kártyák, assignee=${name}) és a hot memóriáidat, ` +
    `és FOLYTASD a megkezdett munkát magadtól. Ne kezdd elölről ami a handoff szerint már kész. ` +
    `Röviden jelezz a csatornádon, hogy friss kontextussal folytatod.`
  )
}

function measurePct(name: string, cfgLimit: number | null): number | null {
  const workingDir = workingDirFor(name)
  const configDir = name === MAIN_AGENT_ID ? undefined : (readAgentClaudeConfigDir(name) ?? undefined)
  const tokens = readContextTokensFromProjectDir(workingDir, configDir)
  if (tokens === null || tokens <= 0) return null
  let limit: number
  if (cfgLimit) {
    limit = cfgLimit
  } else {
    const model = (name === MAIN_AGENT_ID
      ? readActiveModelFromProjectDir(PROJECT_ROOT)
      : readAgentModel(name)) ?? ''
    // Calibrate against the persisted per-(agent, model) maximum, not just
    // the live reading: a fresh post-restart session must not un-learn a
    // window the previous session already proved (see HighwaterMap above).
    limit = calibrateLimit(observedHighwater(name, model, tokens), contextLimitForModel(model))
  }
  return tokens / limit
}

function performRestart(name: string): void {
  if (name === MAIN_AGENT_ID) {
    // Platform-correct main-session restart. This was a hardcoded
    // `/bin/launchctl kickstart`, which exists only on macOS: on Linux every
    // rescue died instantly with `spawnSync /bin/launchctl ENOENT`, caught by
    // checkAgent's catch and buried in a single WARN. Measured on 2026-07-26:
    // the main agent sat at 100% context from 09:47, the saturation net -- the
    // only mechanism that can rescue a pane prompt dispatch refuses -- fired
    // four times and failed every time, and main was unreachable for ~2h until
    // a hand restart.
    //
    // hardRestartMarveenChannels() is the existing helper the channel-monitor
    // down-cascade already uses: it keeps the launchd path for macOS installs
    // (and warns + falls back to a pane respawn if the plist is absent), uses
    // respawn-pane-FRESH on Linux -- fresh is exactly what the guard wants --
    // and writes the shared respawn stamp so the other respawners defer to us.
    const res = hardRestartMarveenChannels()
    if (!res.ok) throw new Error(res.error ?? 'main channels hard restart failed')
  } else {
    restartAgentProcess(name, { fresh: true })
  }
}

async function checkAgent(name: string, nowMs: number): Promise<void> {
  const cfg = readContextGuardConfig(name)
  const state = guardStates.get(name) ?? INITIAL_GUARD_STATE

  // Fully disarmed only when BOTH the proactive tiers and the always-on
  // saturation net are off; the net alone keeps the sweep alive so a
  // 100%-context pane (which dispatch refuses to prompt) still gets rescued.
  if (!cfg.enabled && !cfg.saturationRestart) {
    guardStates.delete(name)
    return
  }

  // v1: local agents only -- a remote host's transcripts are unreadable here.
  if (name !== MAIN_AGENT_ID && readAgentRemoteHost(name)) {
    if (!remoteSkipLogged.has(name)) {
      remoteSkipLogged.add(name)
      logger.info({ name }, 'context-guard: remote-host agent, skipping (transcripts not local)')
    }
    return
  }

  const session = sessionFor(name)
  const running = name === MAIN_AGENT_ID
    ? capturePane(session) !== null
    : agentRunState(name) === 'running'

  // Only pay for the tmux/transcript probes a decision can actually use.
  const needPct = state.phase === 'idle' || state.phase === 'await-handoff'
  const pane = running && needPct ? capturePane(session) : null
  const sessionReady = running && state.phase === 'await-ready'
    ? await isSessionReadyForPrompt(session)
    : false
  // One classification, two distinct signals: 'idle' (safe to restart) and
  // 'busy' (positively mid-turn -- restarts defer). A pane that is neither
  // (error banner, modal, unknown surface) is treated as NOT busy, so a
  // wedged pane still gets the restart that is its only way out.
  const paneState = pane !== null ? detectPaneState(pane) : 'unknown'
  const inputs: GuardInputs = {
    nowMs,
    running,
    // The saturation net decides from the pane alone; only the proactive
    // tiers need the (transcript-reading) pct probe.
    pct: running && needPct && cfg.enabled ? measurePct(name, cfg.limitTokens) : null,
    paneIdle: paneState === 'idle',
    paneBusy: paneState === 'busy',
    sessionReady,
    handoffMtime: needPct ? handoffMtime(name) : null,
    paneSaturated: pane !== null ? paneShowsContextSaturation(pane) : false,
  }

  const decision = decideGuard(state, inputs, cfg)

  // Post-respawn grace for the main session. Making the Linux restart path work
  // (above) also makes it repeatable: measured on 2026-07-26, the saturation net
  // fresh-restarted main five times in one morning, so the agent lost its
  // conversation roughly every half hour. Two causes of a redundant restart,
  // both covered by the same stamp: a session that is still BOOTING can read as
  // saturated/idle again on the next sweep, and ANOTHER respawner (the
  // channel-monitor down-cascade, the auto-restart runner, channel-watchdog.sh)
  // may have just restarted main for its own reasons.
  //
  // Same mechanism every other respawner already shares -- lastMainRespawnAt()
  // plus MARVEEN_POST_RESPAWN_GRACE_MS -- so there is no new tunable and no new
  // number; see the identical gate in stuck-tool-call-watcher.ts. Main only: the
  // stamp describes the main channels session, and a sub-agent restart is
  // cheap and independently coordinated.
  //
  // The state must NOT advance here. decideGuard() has already produced
  // nextState = await-ready; committing that while skipping the restart would
  // leave the machine believing main was restarted, and the next sweep would
  // inject a "continue from your handoff" resume prompt into the SAME saturated
  // pane -- the guard would consume its own recovery and never retry. Keeping
  // the previous state means the next sweep re-decides, and the restart happens
  // once the grace has elapsed.
  if (decision.action === 'restart' && name === MAIN_AGENT_ID) {
    const lastRespawn = lastMainRespawnAt()
    if (shouldDeferForRecentRespawn(lastRespawn, nowMs)) {
      logger.info(
        { name, sinceRespawnMs: lastRespawn ? nowMs - lastRespawn : null, graceMs: MARVEEN_POST_RESPAWN_GRACE_MS },
        'context-guard: recent main respawn within grace, deferring restart (avoid restart loop / boot churn)',
      )
      guardStates.set(name, state)
      return
    }
  }

  guardStates.set(name, decision.nextState)
  if (decision.action === 'none') return

  const pctRound = inputs.pct !== null ? Math.round(inputs.pct * 100) : null
  logger.info({ name, action: decision.action, reason: decision.reason, pct: pctRound }, 'context-guard: acting')

  try {
    switch (decision.action) {
      case 'request-handoff':
        await sendPromptToSession(session, handoffPrompt(pctRound ?? 0, handoffPathFor(name)))
        break
      case 'restart': {
        // A forced restart must never be silent: the supervisor has to know
        // that prompts delivered to the OLD session (queued steering input,
        // parked text, the handoff request itself) may have died with it
        // (2026-07-27: two dispatched instructions lost this way). Snapshot
        // the pane first for post-mortem, then restart, then report on the
        // inter-agent queue -- the channel supervisors actually read.
        let snapshotPath: string | null = null
        try {
          const finalPane = pane ?? capturePane(session)
          if (finalPane) {
            snapshotPath = join(PROJECT_ROOT, 'store', `context-guard-last-pane-${name}.txt`)
            writeFileSync(snapshotPath, finalPane)
          }
        } catch (err) {
          logger.warn({ err, name }, 'context-guard: pre-restart pane snapshot failed')
        }
        performRestart(name)
        try {
          createAgentMessage(
            name,
            MAIN_AGENT_ID,
            `[CONTEXT-GUARD] Ujrainditottam a(z) "${name}" agentet -- ok: ${decision.reason}` +
            (pctRound !== null ? ` (kontextus ~${pctRound}%)` : '') +
            `. A regi sessionbe az utolso percekben kuldott uzenetek/utasitasok ELVESZHETTEK -- ellenorizd es kuldd ujra oket.` +
            (snapshotPath ? ` Pane-snapshot a restart elotti allapotrol: ${snapshotPath}` : ''),
            'context-guard restart notice',
          )
        } catch (err) {
          logger.warn({ err, name }, 'context-guard: restart notice message failed')
        }
        break
      }
      case 'inject-resume': {
        const hadHandoff = inputs.handoffMtime !== null || handoffMtime(name) !== null
        await sendPromptToSession(session, resumePrompt(name, handoffPathFor(name), hadHandoff))
        break
      }
    }
  } catch (err) {
    logger.warn({ err, name, action: decision.action }, 'context-guard: action failed')
  }
}

/** Live status for the dashboard/API. */
export function getContextGuardStatus(): Array<{
  agent: string
  phase: string
  pct: number | null
  enabled: boolean
  saturationRestart: boolean
}> {
  const names = [MAIN_AGENT_ID, ...listAgentNames()]
  return names.map((name) => {
    const cfg = readContextGuardConfig(name)
    const remote = name !== MAIN_AGENT_ID && !!readAgentRemoteHost(name)
    return {
      agent: name,
      phase: guardStates.get(name)?.phase ?? 'idle',
      pct: cfg.enabled && !remote ? measurePct(name, cfg.limitTokens) : null,
      enabled: cfg.enabled,
      saturationRestart: cfg.saturationRestart,
    }
  })
}

/**
 * Who the saturation net sweeps: the main agent plus EVERY agent directory,
 * dashboard-hidden technical workers included.
 *
 * Deliberately listAllAgentNames(), not listAgentNames(). A hidden worker is
 * hidden from the OPERATOR, not from the fleet's life support: it runs a real
 * Claude session that can wedge at 100% context exactly like a visible agent,
 * and when it does, this sweep is the only thing that can free it. The hourly
 * heartbeat proved it on 2026-08-04 -- agents/heartbeat wedged, was invisible
 * to this sweep, and the schedule runner's (correct) "defer instead of
 * injecting into a wedged session" turned into an unbounded wait.
 *
 * Exported so the regression test can assert the SET rather than reach into a
 * timer: narrowing this back to listAgentNames() must fail a test, not a
 * production heartbeat.
 *
 * Deduplicated, main first. On an install where agents/<MAIN_AGENT_ID> exists
 * as a real directory (ours does) the main agent appears twice -- once
 * explicitly, once from the listing -- and checkAgent would run its whole
 * decision on it twice per sweep. That is exactly the agent where a doubled
 * decision is least welcome, so the canonical "who do we sweep" answer is a
 * set, not a concatenation.
 */
export function guardSweepAgentNames(): string[] {
  return [...new Set([MAIN_AGENT_ID, ...listAllAgentNames()])]
}

export function startContextGuardRunner(): NodeJS.Timeout {
  async function sweep() {
    const now = Date.now()
    for (const name of guardSweepAgentNames()) {
      try { await checkAgent(name, now) } catch (err) { logger.debug({ err, agent: name }, 'context-guard: agent check error') }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
