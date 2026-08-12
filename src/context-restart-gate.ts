// Pure logic for the proactive context-restart gate.
//
// The ledger-replay, taskstate-replay, and daily-log-digest SessionStart hooks
// can inject a rich context snapshot into every fresh session -- but only when
// the session STARTS. This gate decides when a /clear (soft restart via the
// send lane) is appropriate so those hooks carry the agent forward cheaply,
// before the context grows deep enough that the in-TUI auto-compact has to do
// it the hard (expensive, lossy) way.
//
// The trigger is simple: context >= thresholdTokens.
// The hard part is the GATE: a /clear mid-task cuts work in flight, and that is
// exactly what we want to avoid. The gate blocks whenever ANY live-work signal
// is present. FAIL-CLOSED throughout: an unmeasurable signal blocks, not allows.
//
// Zero model tokens at runtime -- every check is a deterministic SQL query,
// file read, or pane/process snapshot. The I/O lives in
// src/web/context-restart-gate-runner.ts; this module only reasons.

export const DEFAULT_THRESHOLD_TOKENS = 400_000
export const DEFAULT_STALE_CUTOFF_MS  = 2 * 60 * 60 * 1000   // 2 h
export const DEFAULT_RETRY_INTERVAL_MS = 5 * 60 * 1000        // 5 min
export const DEFAULT_PERSISTENT_BLOCK_ALERT_MS = 2 * 60 * 60 * 1000  // 2 h

export interface GateConfig {
  /** Master toggle. Default false (opt-in per agent). */
  enabled: boolean
  /**
   * Trigger: soft-restart when the measured context token count reaches this.
   * Absolute token count, not a window fraction -- the right number depends on
   * session quality and coherence, not on the model's max-window size. 400k
   * gives the 1M-window models 600k of breathing room for the clean transition;
   * on a 200k-window model this value exceeds the full window, so the gate
   * never fires (the hard guard at 90%/97% handles those sessions instead).
   */
  thresholdTokens: number
  /**
   * After this many ms a dispatched agent_message (pending/delivered) is
   * treated as stale: it was likely abandoned and no longer blocks. We still
   * log when staleness was the only reason we opened, so the pattern is
   * visible rather than silently normalised.
   */
  staleCutoffMs: number
  /** How often the runner re-evaluates when blocked. */
  retryIntervalMs: number
  /**
   * Send bigme a block-alert when the gate has been continuously blocked for
   * this long. A permanently-blocked gate is itself a signal something is wrong.
   */
  persistentBlockAlertMs: number
}

export function normalizeGateConfig(raw: unknown): GateConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const posInt = (v: unknown, dflt: number): number =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.floor(v) : dflt
  return {
    enabled: o.enabled === true,
    thresholdTokens:         posInt(o.thresholdTokens,         DEFAULT_THRESHOLD_TOKENS),
    staleCutoffMs:           posInt(o.staleCutoffMs,           DEFAULT_STALE_CUTOFF_MS),
    retryIntervalMs:         posInt(o.retryIntervalMs,         DEFAULT_RETRY_INTERVAL_MS),
    persistentBlockAlertMs:  posInt(o.persistentBlockAlertMs,  DEFAULT_PERSISTENT_BLOCK_ALERT_MS),
  }
}

export const DEFAULT_GATE_CONFIG: GateConfig = normalizeGateConfig({})

export interface GateInputs {
  nowMs: number

  /**
   * Actual measured context token count from the transcript; null when the
   * session has no readable transcript (fresh start, no history yet).
   */
  contextTokens: number | null

  /**
   * Pane state from detectPaneState() / detectsUsageLimit().
   *
   * The TypeScript PaneState ('idle'|'busy'|'typing'|'unknown'|'error') does
   * not have a 'limited' value; pass paneUsageLimited separately for that
   * signal. null = pane not capturable (fail-closed → block).
   */
  paneState: 'idle' | 'busy' | 'typing' | 'unknown' | 'error' | null
  paneUsageLimited: boolean   // detectsUsageLimit(pane) -- usage cap banner

  /**
   * Current phase of the hard context-guard for this agent. When the hard
   * guard is actively managing the session (await-handoff, await-ready), we
   * back off completely so the two mechanisms never both touch the pane.
   */
  hardGuardPhase: string  // 'idle' | 'cooldown' | 'await-handoff' | 'await-ready'

  /**
   * Count of agent_messages FROM this agent with status IN (pending, delivered)
   * and created_at within staleCutoffMs. These represent live dispatched work
   * the agent is waiting for.
   */
  pendingOutboundCount: number
  /**
   * True if there are dispatched messages that WOULD have blocked but are
   * older than staleCutoffMs. We let those through, but log the staleness.
   */
  hasStaleOutbound: boolean

  /**
   * Whether the session's claude process has live child processes -- Task-tool
   * subagents or background Bash commands that have not yet returned.
   *
   * null = unmeasurable (pane PID unreadable, ps failed, etc.) → FAIL-CLOSED
   * (block). This is the most fragile signal; see the runner for limitations.
   */
  hasChildProcesses: boolean | null

  /** Last inbound channel message has no later outbound (unresolved turn). */
  hasOpenQuestion: boolean

  /**
   * store/agent-taskstate/<agent>.json exists with consumed=false and a
   * non-empty nextAction -- the agent has an in-flight structured task.
   */
  hasLiveTaskState: boolean
}

export type GateAction = 'allow' | 'block' | 'block-alert'

export interface GateDecision {
  action: GateAction
  reason: string
  /** Runner should log a note that stale outbound messages were ignored. */
  noteStaleOutbound?: boolean
}

/**
 * One gate evaluation for one agent. Pure: the runner gathers all inputs and
 * executes the returned action.
 *
 * @param firstBlockedAt  Epoch ms when continuous blocking started for this
 *                        agent, or null if not currently in a blocking streak.
 *                        Used to escalate to 'block-alert' after the persistent
 *                        block threshold.
 */
export function decideGate(
  inputs: GateInputs,
  cfg: GateConfig,
  firstBlockedAt: number | null,
): GateDecision {
  if (!cfg.enabled) {
    // Disabled: return block (not alert) -- the gate being off is expected.
    return { action: 'block', reason: 'gate-disabled' }
  }

  // Trigger check first: no point evaluating the gate conditions if we are
  // still below the threshold.
  if (inputs.contextTokens === null) {
    // Fail-closed for the ACTION (never /clear on an unmeasured session), but
    // deliberately NOT alertable: the alert text tells the owner the agent
    // "reached the threshold and the gate will not open", and that is exactly
    // the claim an unmeasured reading cannot support. A fresh session reads as
    // null for the first minute or so (the transcript carries no `usage` until
    // the first assistant turn closes), so escalating here reports a phantom
    // stall on every boot.
    return { action: 'block', reason: 'context-tokens-unmeasurable (fail-closed)' }
  }
  if (inputs.contextTokens < cfg.thresholdTokens) {
    return { action: 'block', reason: `below-threshold (${inputs.contextTokens} < ${cfg.thresholdTokens})` }
  }

  // Interlock: hard guard is actively managing this session. Stand aside so
  // the two mechanisms never simultaneously touch the pane.
  if (inputs.hardGuardPhase === 'await-handoff' || inputs.hardGuardPhase === 'await-ready') {
    return block(firstBlockedAt, inputs.nowMs, cfg, `hard-guard-armed (phase: ${inputs.hardGuardPhase})`)
  }

  // ---- Gate conditions (FAIL-CLOSED) ----------------------------------------

  // Pane guard: anything that is not a confirmed idle state blocks.
  if (inputs.paneState === null) {
    return block(firstBlockedAt, inputs.nowMs, cfg, 'pane-not-capturable (fail-closed)')
  }
  if (inputs.paneState === 'busy' || inputs.paneState === 'typing') {
    return block(firstBlockedAt, inputs.nowMs, cfg, `pane-${inputs.paneState} (mid-turn, not safe)`)
  }
  if (inputs.paneUsageLimited) {
    // Session hit usage cap. /clear cannot be processed anyway, and the pane
    // is not truly idle. The stuck-modal-guard (PR #937) owns remediation here.
    return block(firstBlockedAt, inputs.nowMs, cfg, 'pane-usage-limited (quota cap, stuck-modal-guard owns this)')
  }
  if (inputs.paneState === 'unknown' || inputs.paneState === 'error') {
    return block(firstBlockedAt, inputs.nowMs, cfg, `pane-${inputs.paneState} (fail-closed)`)
  }
  // paneState === 'idle' from here.

  // Child process guard: live children of the claude process = Task-tool
  // subagent or background Bash still running.
  // null = unmeasurable → fail-closed.
  if (inputs.hasChildProcesses === null) {
    return block(firstBlockedAt, inputs.nowMs, cfg, 'child-process-check-failed (fail-closed)')
  }
  if (inputs.hasChildProcesses) {
    return block(firstBlockedAt, inputs.nowMs, cfg, 'live-child-processes (Task-tool or background Bash)')
  }

  // Dispatched external work: agent_messages this agent sent that have not
  // yet received a result.
  if (inputs.pendingOutboundCount > 0) {
    return block(firstBlockedAt, inputs.nowMs, cfg,
      `pending-outbound-messages (${inputs.pendingOutboundCount} within ${Math.round(cfg.staleCutoffMs / 3_600_000)}h cutoff)`)
  }

  // Inbound channel question with no reply yet.
  if (inputs.hasOpenQuestion) {
    return block(firstBlockedAt, inputs.nowMs, cfg, 'open-question-in-ledger (unanswered inbound)')
  }

  // Structured in-flight task state.
  if (inputs.hasLiveTaskState) {
    return block(firstBlockedAt, inputs.nowMs, cfg, 'live-task-state (nextAction set, not consumed)')
  }

  // All gate conditions clear.
  return {
    action: 'allow',
    reason: `context ${inputs.contextTokens} >= ${cfg.thresholdTokens}, all gate conditions clear`,
    noteStaleOutbound: inputs.hasStaleOutbound,
  }
}

function block(
  firstBlockedAt: number | null,
  nowMs: number,
  cfg: GateConfig,
  reason: string,
): GateDecision {
  const elapsed = firstBlockedAt !== null ? nowMs - firstBlockedAt : 0
  const action: GateAction = elapsed >= cfg.persistentBlockAlertMs ? 'block-alert' : 'block'
  return { action, reason }
}

/**
 * Advance the blocking-streak clock after a 'block' decision.
 *
 * The clock measures ONE thing: how long this agent has sat AT OR ABOVE the
 * threshold with the gate refusing to open. That is the only situation worth
 * alerting about, so:
 *
 *   - measured below the threshold -> not waiting for the gate at all: CLEAR.
 *   - measured at/above the threshold -> start the clock if it is not running.
 *   - unmeasurable (null) -> leave the clock as it is; we cannot tell which
 *     side of the threshold we are on, and a fresh session reads null for
 *     about a minute after every boot.
 *
 * Before this existed the clock stopped only on a successful /clear, so a
 * legitimate streak outlived the session that caused it -- across restarts and
 * even a host freeze.
 */
export function nextBlockClock(
  firstBlockedAt: number | null,
  contextTokens: number | null,
  thresholdTokens: number,
  nowMs: number,
): number | null {
  if (contextTokens === null) return firstBlockedAt
  if (contextTokens < thresholdTokens) return null
  return firstBlockedAt ?? nowMs
}
