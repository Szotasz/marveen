import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import { listAgentNames, readAgentRemoteHost, readAgentModel, isClaudeModel, modelContextWindowK } from './agent-config.js'
import { isAgentRunning, capturePane, sendPromptToSession } from './agent-process.js'
import { resolveAgentSession } from './channel-mcp-reconnect.js'
import {
  parseIdleContextTokensK,
  decideContextCompaction,
  type ContextCompactionState,
  type ContextCompactionThresholds,
} from '../pane-state.js'

// Proactive context compaction for MiniMax-routed sub-agents (2026-07-01).
//
// See pane-state.ts (Context-compaction watcher block) for the full rationale.
// In short: Claude Code's auto-compaction is miscalibrated against MiniMax's
// custom endpoint, so a sub-agent's context can grow toward the provider's
// real cap (~512k for M3) without compacting, then the API rejects the
// oversized request and the agent wedges with no reply ("Kutasz nem
// válaszolt"). This watcher reads each MiniMax agent's idle context-size hint
// and (A) fires `/compact` before the cap, (B) alerts the owner if context
// reaches the danger ceiling (compaction not keeping up / a 429 wedge).
//
// All decision logic is the pure decideContextCompaction() in pane-state.ts
// (unit-tested); this module is only the I/O + per-session state map,
// mirroring stuck-input-watcher.ts.
//
// Scope: MiniMax agents only. The Claude-routed main agent (Alfred) has a
// correctly-calibrated native auto-compaction and must NOT be force-compacted.

const NOTIFY_SCRIPT = join(PROJECT_ROOT, 'scripts', 'notify.sh')

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const v = parseInt(raw, 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const v = parseFloat(raw)
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback
}

// Model-aware thresholds: compact/ceiling are FRACTIONS of each agent's own
// context window (from modelContextWindowK), so the watcher works for whatever
// model an agent is set to -- a 200k model compacts around 156k, a 1M model
// around 780k. Compact at 78% leaves room for the summarising call itself;
// alert-ceiling at 94% is the "compaction isn't keeping up" danger line, still
// below the real cap. Timing is model-independent. All env-tunable.
const COMPACT_PCT = envFloat('MARVEEN_CTX_COMPACT_PCT', 0.78)
const CEILING_PCT = envFloat('MARVEEN_CTX_CEILING_PCT', 0.94)
const CONFIRM_MS = envInt('MARVEEN_CTX_CONFIRM_MS', 60_000)
const COMPACT_DEDUP_MS = envInt('MARVEEN_CTX_COMPACT_DEDUP_MS', 300_000)
const ALERT_DEDUP_MS = envInt('MARVEEN_CTX_ALERT_DEDUP_MS', 1_800_000)

function thresholdsForModel(model: string): ContextCompactionThresholds {
  const windowK = modelContextWindowK(model)
  return {
    compactK: Math.round(windowK * COMPACT_PCT),
    ceilingK: Math.round(windowK * CEILING_PCT),
    confirmMs: CONFIRM_MS,
    compactDedupMs: COMPACT_DEDUP_MS,
    alertDedupMs: ALERT_DEDUP_MS,
  }
}

// Offset from the other watchers (15s/30s/45s/60s) so the capture-pane calls
// do not pile on one tick. Compaction is not latency-sensitive.
const INITIAL_DELAY_MS = 50_000
const INTERVAL_MS = 60_000

const NO_STATE: ContextCompactionState = { firstOverAt: null, lastCompactAt: null, lastAlertAt: null }

const watchState = new Map<string, ContextCompactionState>()

// Non-Claude routed agents share the harness's window-miscalibration and are
// watcher-managed; Claude-routed agents auto-compact correctly on their own.
function isManagedContextAgent(name: string): boolean {
  return !isClaudeModel(readAgentModel(name))
}

function alertOwner(label: string, session: string, tokensK: number): void {
  const msg =
    `⚠️ ${label}: a context elérte a veszélyzónát (~${tokensK}k token) és a /compact nem tartja a lépést ` +
    `(elakadás vagy 429 lehet). Nézd meg: tmux attach -t ${session}. Auto-reset szándékosan NEM fut (kontextusvesztés-védelem).`
  execFile('/bin/bash', [NOTIFY_SCRIPT, msg], { timeout: 10_000 }, (err) => {
    if (err) logger.warn({ err, label }, 'context-compaction-watcher: notify.sh escalation failed')
  })
}

function checkAgent(name: string, session: string, host: string | null): void {
  const pane = capturePane(session, host)
  const tokensK = parseIdleContextTokensK(pane)

  const thresholds = thresholdsForModel(readAgentModel(name))
  const prev = watchState.get(session) ?? NO_STATE
  const { action, next } = decideContextCompaction(tokensK, prev, Date.now(), thresholds)

  if (next.firstOverAt === null && next.lastCompactAt === null && next.lastAlertAt === null) {
    watchState.delete(session)
  } else {
    watchState.set(session, next)
  }

  if (action === 'compact') {
    logger.info(
      { agent: name, session, tokensK, compactK: thresholds.compactK },
      'context-compaction-watcher: context past threshold, firing /compact proactively',
    )
    sendPromptToSession(session, '/compact', host)
  } else if (action === 'alert') {
    logger.warn(
      { agent: name, session, tokensK, ceilingK: thresholds.ceilingK },
      'context-compaction-watcher: context at danger ceiling, escalating to owner (no auto-reset)',
    )
    alertOwner(name, session, tokensK ?? thresholds.ceilingK)
  }
}

export function startContextCompactionWatcher(): NodeJS.Timeout {
  function sweep() {
    for (const name of listAgentNames()) {
      if (!isAgentRunning(name)) {
        watchState.delete(resolveAgentSession(name))
        continue
      }
      if (!isManagedContextAgent(name)) continue
      try {
        checkAgent(name, resolveAgentSession(name), readAgentRemoteHost(name))
      } catch (err) {
        logger.debug({ err, agent: name }, 'context-compaction-watcher: agent check error')
      }
    }
  }

  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
