// /context clear, /new, /clear, owner slash commands (CMD920 3.4).
//
// The same code path as the context-restart gate's soft restart: the gate's
// own quiet checks (gatherGateInputs + decideGate with the token threshold set
// to 0, everything else unchanged and fail-closed), /clear on the send lane,
// and the wake nudge; the SessionStart replay hooks carry the thread. A busy
// session is NOT cleared: a /clear typed into a running turn lands in the
// input box and parks there. The reply points to /runs instead.

import { MAIN_AGENT_ID } from '../config.js'
import { decideGate, type GateInputs, type GateConfig } from '../context-restart-gate.js'
import { gatherGateInputs, performSoftClear, mainSessionName } from './context-restart-gate-runner.js'
import { readContextTokensFromProjectDir } from './active-model.js'
import { configDirFor } from './main-transcript-root.js'
import { PROJECT_ROOT } from '../config.js'
import { formatTokens } from './system-status.js'

export type QuietVerdict = { quiet: true } | { quiet: false; reason: string }

// /clear is only safe on a genuinely quiet session: the gate's full condition
// set, minus the threshold (the owner asked for it; size is not the trigger).
// Both owner-command verdicts measure quiet on TURN lines, not on the file
// mtime: the command's own hook-blocked prompt writes bookkeeping lines to the
// transcript at the very moment the (deferred) command runs, and the mtime
// then always read "0s" (ELSOKOR922 Phase 7 A-smoke). Falls back to the mtime
// when the turn measurement is unavailable.
function turnQuietMs(inputs: GateInputs): number | null {
  return inputs.msSinceTurnActivity ?? inputs.msSinceTranscriptWrite
}

export function clearVerdict(inputs: GateInputs, cfg: GateConfig): QuietVerdict {
  const d = decideGate(
    { ...inputs, contextTokens: inputs.contextTokens ?? 0, msSinceTranscriptWrite: turnQuietMs(inputs) },
    { ...cfg, enabled: true, thresholdTokens: 0 },
    null,
  )
  return d.action === 'allow' ? { quiet: true } : { quiet: false, reason: d.reason }
}

// A model switch throws nothing away, so its turn-quiet window is short: it
// only has to cover the moment the pane reads idle between two tool calls of a
// running turn. The gate's 2-minute window (made for /clear) turned every
// /model sent within 2 minutes of a conversation into a refusal.
export const SWITCH_TURN_QUIET_MS = 20_000

// A model switch only needs the pane quiet (idle pane, quiet turn, no live
// child process, no hard-guard phase): unlike /clear it throws nothing
// away, so pending outbound work or an open question do not block it.
export function switchVerdict(inputs: GateInputs, _cfg: GateConfig): QuietVerdict {
  if (inputs.hardGuardPhase === 'await-handoff' || inputs.hardGuardPhase === 'await-ready') {
    return { quiet: false, reason: `hard-guard-armed (phase: ${inputs.hardGuardPhase})` }
  }
  if (inputs.paneState !== 'idle') return { quiet: false, reason: `pane-${inputs.paneState ?? 'not-capturable'}` }
  if (inputs.paneUsageLimited) return { quiet: false, reason: 'pane-usage-limited' }
  const quietMs = turnQuietMs(inputs)
  if (quietMs === null) return { quiet: false, reason: 'transcript-unreadable' }
  if (quietMs < SWITCH_TURN_QUIET_MS) {
    return { quiet: false, reason: `turn-active (${Math.round(quietMs / 1000)}s ago, need ${SWITCH_TURN_QUIET_MS / 1000}s)` }
  }
  if (inputs.hasChildProcesses !== false) return { quiet: false, reason: inputs.hasChildProcesses === null ? 'child-process-check-failed' : 'live-child-processes' }
  return { quiet: true }
}

export interface SessionControlDeps {
  gather: (name: string, nowMs: number) => { cfg: GateConfig; inputs: GateInputs }
  softClear: (name: string, session: string, nowMs: number, contextTokens: number | null) => Promise<void>
  session: () => string
  contextTokens: () => number | null
}

export const liveDeps: SessionControlDeps = {
  gather: (name, nowMs) => gatherGateInputs(name, nowMs),
  softClear: performSoftClear,
  session: mainSessionName,
  contextTokens: () => readContextTokensFromProjectDir(PROJECT_ROOT, configDirFor(MAIN_AGENT_ID)),
}

export interface ClearResult {
  cleared: boolean
  text: string
}

export async function contextClear(nowMs: number, deps: SessionControlDeps = liveDeps): Promise<ClearResult> {
  const { cfg, inputs } = deps.gather(MAIN_AGENT_ID, nowMs)
  const verdict = clearVerdict(inputs, cfg)
  const before = inputs.contextTokens
  if (!verdict.quiet) {
    return {
      cleared: false,
      text: `Nem töröltem: a session foglalt (${verdict.reason}). Mi fut: /runs`,
    }
  }
  await deps.softClear(MAIN_AGENT_ID, deps.session(), nowMs, before)
  const after = deps.contextTokens()
  const beforeTxt = before === null ? 'nem mérhető' : formatTokens(before)
  const afterTxt = after === null
    ? 'még nem mérhető (az új session első köre után látszik)'
    : formatTokens(after)
  return {
    cleared: true,
    text: `/clear elküldve, a session újraindult. Kontextus előtte: ${beforeTxt} · utána: ${afterTxt}. A szálat a replay-hookok viszik tovább.`,
  }
}
