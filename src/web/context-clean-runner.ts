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
import {
  decideContextClean,
  normalizeSignal,
  INITIAL_STATE,
  NO_SIGNAL,
  type ContextCleanConfig,
  type ContextCleanState,
  type RestartSignal,
} from '../context-clean.js'

// Drives per-agent context-size-triggered cleans (see src/context-clean.ts for
// the why and the pure decision). Mirrors the auto-restart runner: a 60s sweep,
// offset from the others so tmux calls do not pile onto one tick. Sub-agents
// only -- the main channels session is launchd-managed and always starts a fresh
// conversation, so it has no accumulating context to clean here.
//
// Hard safety rules:
//   - EXPLICIT-READY: a fresh restart proceeds only on the agent's own signal,
//     the grace-cap, or the hard threshold -- never inferred from an idle pane.
//   - IDLE-GUARD: even when a restart is due, never cut a live turn; defer to the
//     next tick while the pane is busy.
//   - POST-RESTART COOLDOWN: after a clean, skip the agent for a window so a
//     stale context reading (or a not-yet-rotated transcript) cannot immediately
//     re-trigger a second warn.

const INITIAL_DELAY_MS = 50_000
const INTERVAL_MS = 60_000
const COOLDOWN_MS = 5 * 60_000

// agent name -> tracked state across ticks.
const states = new Map<string, ContextCleanState>()
// agent name -> when it was last context-cleaned (ms), for the cooldown guard.
const lastClean = new Map<string, number>()

// Signal-file name is derived from the agent name; guard it so a malformed name
// can never escape STORE_DIR. Agent names from listAgentNames() are already
// real directory names, but the whitelist keeps this defensive.
function signalPathFor(name: string): string | null {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return null
  return join(STORE_DIR, `restart-signal.${name}.json`)
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

function clearSignal(name: string): void {
  const p = signalPathFor(name)
  if (p && existsSync(p)) {
    try { rmSync(p) } catch (err) { logger.debug({ err, name }, 'context-clean: signal clear failed') }
  }
}

function paneIsIdle(session: string, host: string | null): boolean {
  const pane = capturePane(session, host)
  if (pane == null) return false
  return paneLooksIdle(pane)
}

// The warn prompt injected into the agent's session. It must be actionable on its
// own: the agent needs the exact signal-file path and copy-paste commands, since
// the whole point is that it can save + signal without any further hand-holding.
function buildWarnPrompt(name: string, ctx: number, cfg: ContextCleanConfig, signalPath: string): string {
  const k = (n: number) => `${Math.round(n / 1000)}K`
  return [
    `[CONTEXT-CLEAN figyelmeztetes] A session-kontextusod elerte a ${k(ctx)} tokent (kuszob ${k(cfg.softThreshold)}).`,
    `Hamarosan FRISS restart (context-clear) kovetkezik, hogy a session ne lassuljon be es ne fusson limitbe. A restart ELDOBJA a jelenlegi beszelgetest, ezert a mentes rajtad all.`,
    ``,
    `TEENDO most:`,
    `1) Ments el mindent amit meg kell orizned: memoria (/api/memories), hot task state, napi naplo (/api/daily-log). Ha akarod, futtasd a /handoff-ot.`,
    `2) Ha KESZEN allsz a restartra, jelezd EXPLICIT modon (a runner NEM az idle-bol kovetkeztet):`,
    `   echo '{"hold":false,"ready":true}' > ${signalPath}`,
    `3) Ha epp meg-nem-szakithato kritikus lepes kozepen vagy (pl. multi-step git muvelet, fajliras), keslelteshetsz:`,
    `   echo '{"hold":true,"ready":false}' > ${signalPath}`,
    `   majd amikor vegeztel, ird at ready-re a 2) paranccsal.`,
    ``,
    `Ha ${cfg.graceMinutes} percen belul nem jelzel es nincs aktiv hold, vagy ha a kontextus eleri a ${k(cfg.hardThreshold)}-t, a restart automatikusan megtortenik.`,
  ].join('\n')
}

function checkAgent(name: string, nowMs: number): void {
  // Thresholds default per model: a [1m] agent (like Dex) warms at 400k/500k, a
  // standard ~200k-window Sonnet agent much lower, so our clean pre-empts the
  // harness's own auto-compaction instead of never firing.
  const cfg = readContextCleanConfig(name, readAgentModel(name))
  if (!cfg.enabled) {
    states.delete(name)
    return
  }
  // Only running sub-agents are eligible. 'unreachable' (remote laptop briefly
  // out of reach) and 'stopped' are left alone -- same invariant as auto-restart.
  if (agentRunState(name) !== 'running') {
    states.delete(name)
    return
  }
  // Post-restart cooldown: give the fresh session time to rotate its transcript
  // so a stale reading cannot immediately re-warn.
  const cleanedAt = lastClean.get(name)
  if (cleanedAt !== undefined && nowMs - cleanedAt < COOLDOWN_MS) return

  const ctx = readContextTokensFromProjectDir(agentDir(name), readAgentClaudeConfigDir(name) ?? undefined)
  const state = states.get(name) ?? { ...INITIAL_STATE }
  const signal = readSignal(name)
  const action = decideContextClean(cfg, state, ctx, signal, nowMs)

  switch (action) {
    case 'none':
    case 'wait':
      states.set(name, state)
      return

    case 'reset':
      states.set(name, { ...INITIAL_STATE })
      clearSignal(name)
      logger.info({ name }, 'context-clean: context fell back below soft threshold, flow reset')
      return

    case 'warn': {
      const session = agentSessionName(name)
      const host = readAgentRemoteHost(name)
      const signalPath = signalPathFor(name)
      if (!signalPath) {
        logger.warn({ name }, 'context-clean: unsafe agent name, skipping warn')
        return
      }
      clearSignal(name) // clear any stale signal from a previous flow
      try {
        sendPromptToSession(session, buildWarnPrompt(name, ctx ?? 0, cfg, signalPath), host)
        states.set(name, { phase: 'warned', warnedAtMs: nowMs })
        logger.info({ name, contextTokens: ctx }, 'context-clean: warned agent, awaiting save + signal')
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
        states.set(name, { ...INITIAL_STATE })
        clearSignal(name)
        logger.info({ name }, 'context-clean: fresh restart performed')
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
