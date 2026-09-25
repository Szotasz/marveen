// Per-agent "what is it doing, and how long has it been doing it".
//
// The existing /api/agents/activity answers WHETHER an agent is working (run
// state + the last 8 raw pane lines). It cannot say WHAT the agent is on, or
// how long it has been there, and eight lines of raw tmux output are not
// readable at a glance.
//
// DELIBERATELY NO PERCENTAGE. Nothing in the system knows how big a task is, so
// a completion percentage would be invented. What IS measurable: when the work
// started, how long since the agent last did anything, and how many tool calls
// it has made since it started. This module derives exactly those and nothing
// more -- notably NOT an "awaiting approval" state, which today would have to
// be guessed from a terminal string nobody has an observed example of.
//
// The derivation is a pure function over already-collected signals so it can be
// unit-tested without a database, a tmux server, or a clock. All I/O lives in
// the route.

// EVERY threshold this view uses lives here, named, in ONE place. A threshold
// that gets copied to its second location is how the fleet ended up with three
// different alert cadences that nobody could reconcile.
export const AGENT_STATUS_THRESHOLDS = {
  // A running agent that has made no tool call and sent no message for this
  // long is reported STALLED. Only ever applied when tool data exists for that
  // agent -- see the degraded-mode note on deriveAgentStatus.
  STALLED_AFTER_SEC: 15 * 60,
  // tool_call_log is pruned at 24h (pruneToolCallLog), so "no rows" past this
  // window says nothing about the agent. The window is stated here so a future
  // change to the pruning cadence has one obvious place to stay in sync with.
  TOOL_DATA_WINDOW_SEC: 24 * 60 * 60,
  // How recent a handed-over task must be to stand in for "what the agent is
  // working on" when it holds no in_progress card. A message is only a proxy:
  // measured against the live board, three agents' newest inbound was the same
  // 447-hour-old broadcast, which the view happily rendered as current work
  // started 447 hours ago. Past this age the honest answer is that we do not
  // know, so the row says so instead of asserting something false.
  MESSAGE_WORK_CLAIM_MAX_AGE_SEC: 6 * 60 * 60,
} as const

export type AgentActivityState =
  | 'working'
  | 'idle'
  | 'stalled'
  | 'stopped'
  | 'unreachable'
  | 'unknown'

/** What the agent appears to be on. `kind: 'none'` means we genuinely do not know. */
export interface AgentWork {
  kind: 'card' | 'message' | 'none'
  text: string
  cardId: string | null
}

export interface AgentStatusSignals {
  agent: string
  isMain: boolean
  running: boolean
  /** Run/pane state as the existing activity route already labels it. */
  paneState: 'working' | 'idle' | 'stopped' | 'unknown' | 'error' | 'unreachable'
  /**
   * The permission mode string exactly as detectPermissionMode reports it,
   * passed through UNINTERPRETED.
   *
   * There is deliberately no "waiting for approval" state derived from it. The
   * approvals table has never held a row, and every agent measured on
   * 2026-08-29 reported the same 'bypass permissions' -- so there is no
   * observed example of what an approval-parked agent looks like here. Writing
   * a matcher against a string shape nobody has seen is how a detector ends up
   * confidently wrong. The raw value is surfaced so an operator can read it;
   * when the approvals table starts carrying rows, that becomes the reliable
   * source and the state can be derived then, from data rather than from the
   * shape of terminal output.
   */
  permissionMode: string | null
  /**
   * Has this agent produced ANY tool-call row inside the retention window?
   * false means we have no tool telemetry for it -- NOT that it made zero
   * calls. The two are different answers and the view must not conflate them.
   */
  toolDataAvailable: boolean
  /** Tool calls since the work started. Meaningless (and ignored) when !toolDataAvailable. */
  toolCallsSinceStart: number
  /** Epoch seconds of the most recent tool call, or null. */
  lastToolCallAt: number | null
  /** Epoch seconds the agent was last handed a task (agent_messages.delivered_at). */
  lastInboundAt: number | null
  /** Epoch seconds the agent last reported something itself (agent_messages.created_at). */
  lastOutboundAt: number | null
  /** First line of the most recent inbound task, used when no card is claimed. */
  lastInboundSubject: string | null
  /** The card the agent currently has in_progress, if any. */
  currentCard: { id: string; title: string; enteredStatusAt: number | null } | null
  nowSec: number
}

export interface AgentStatusRow {
  agent: string
  isMain: boolean
  running: boolean
  state: AgentActivityState
  work: AgentWork
  /** Seconds since the current work started, or null when unknown. */
  sinceSec: number | null
  /** Seconds since the agent itself last did anything observable, or null. */
  lastSignalAgeSec: number | null
  lastSignalSource: 'tool' | 'message' | null
  /** Permission mode as reported, uninterpreted. See AgentStatusSignals.permissionMode. */
  permissionMode: string | null
  /**
   * Tool calls since the work started, or null when there is no tool telemetry
   * for this agent. null renders as "-", never as 0: an agent shown making
   * "0 tool calls" reads as stalled, and reporting a healthy agent as dead is
   * worse than reporting nothing.
   */
  toolCalls: number | null
  /**
   * True when this row is missing tool telemetry. Expected, not broken: until
   * the tool-call hook is registered for every agent, most of the fleet has no
   * rows at all. The renderer should say "no data", and no flag may be derived
   * from the absence.
   */
  degraded: boolean
}

function ageOrNull(now: number, at: number | null): number | null {
  if (at === null) return null
  const age = now - at
  return age < 0 ? 0 : age
}

/**
 * Derive one agent's status row from its collected signals.
 *
 * DEGRADED MODE. When `toolDataAvailable` is false the row is built from the
 * message signals alone: `toolCalls` is null and the STALLED state can never be
 * reached. Without tool telemetry there is no way to tell an agent deep in a
 * long single step from one that has died, and guessing in that situation is
 * exactly how a monitoring view ends up declaring healthy agents dead. So it
 * reports what it knows and stays quiet about what it does not.
 */
export function deriveAgentStatus(s: AgentStatusSignals): AgentStatusRow {
  // A stale handed-over task is not current work. An in_progress card is a
  // claim the agent made about itself and needs no expiry; an inbound message
  // is only a proxy, so it expires.
  const inboundAge = ageOrNull(s.nowSec, s.lastInboundAt)
  const inboundIsFresh =
    inboundAge !== null && inboundAge <= AGENT_STATUS_THRESHOLDS.MESSAGE_WORK_CLAIM_MAX_AGE_SEC

  const work: AgentWork = s.currentCard
    ? { kind: 'card', text: s.currentCard.title, cardId: s.currentCard.id }
    : inboundIsFresh && s.lastInboundSubject
      ? { kind: 'message', text: s.lastInboundSubject, cardId: null }
      : { kind: 'none', text: '', cardId: null }

  // When the work started: the card's entry into its current status is the
  // precise answer; a RECENT handed-over task is the fallback. Both can be
  // absent, and null is a better answer than a made-up one.
  const startedAt = s.currentCard?.enteredStatusAt ?? (inboundIsFresh ? s.lastInboundAt : null)

  // The agent's OWN last sign of life. An inbound message is someone else
  // talking TO it and says nothing about whether it is alive, so it is not a
  // signal here.
  const toolAt = s.toolDataAvailable ? s.lastToolCallAt : null
  const ownSignalAt =
    toolAt !== null && s.lastOutboundAt !== null
      ? Math.max(toolAt, s.lastOutboundAt)
      : (toolAt ?? s.lastOutboundAt)
  const lastSignalSource: 'tool' | 'message' | null =
    ownSignalAt === null ? null : ownSignalAt === toolAt ? 'tool' : 'message'

  const lastSignalAgeSec = ageOrNull(s.nowSec, ownSignalAt)

  // Telemetry counts only if it COVERS the current work. Having some rows in
  // the 24h window is not enough: an agent whose hook was removed keeps its old
  // rows, and the view would then report "0 tool calls" for an agent that is
  // demonstrably busy -- the same false-death reading as showing 0 for an
  // uninstrumented agent, arriving by a different route. Measured on the live
  // fleet: an actively working agent with five stale rows rendered as 0.
  // Erring toward "no data" is the safe direction; a genuinely instrumented
  // agent produces a covering row within seconds of starting work.
  const telemetryCoversWork =
    s.toolDataAvailable &&
    s.lastToolCallAt !== null &&
    (startedAt === null || s.lastToolCallAt >= startedAt)
  const degraded = !telemetryCoversWork

  let state: AgentActivityState
  if (!s.running) state = 'stopped'
  else if (s.paneState === 'unreachable') state = 'unreachable'
  else if (
    // STALLED requires tool telemetry. See the degraded-mode note above.
    !degraded &&
    s.paneState === 'working' &&
    lastSignalAgeSec !== null &&
    lastSignalAgeSec >= AGENT_STATUS_THRESHOLDS.STALLED_AFTER_SEC
  ) state = 'stalled'
  else if (s.paneState === 'working') state = 'working'
  else if (s.paneState === 'idle') state = 'idle'
  else state = 'unknown'

  return {
    agent: s.agent,
    isMain: s.isMain,
    running: s.running,
    state,
    work,
    sinceSec: ageOrNull(s.nowSec, startedAt),
    lastSignalAgeSec,
    lastSignalSource,
    permissionMode: s.permissionMode,
    toolCalls: degraded ? null : s.toolCallsSinceStart,
    degraded,
  }
}
