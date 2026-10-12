// Pure decision logic for the kanban -> agent dispatch (option D).
//
// When a kanban card is moved to `in_progress`, the dashboard wakes the
// assigned agent by enqueuing an inter-agent message (createAgentMessage ->
// the existing message-router, which gives us retry / dedup / trust-wrapping /
// busy-receiver handling for free). This module decides WHO, if anyone, should
// be woken. Kept pure so the decision tree is unit-tested without tmux/db.
//
// Rules (mirroring the assignee semantics from PR #251):
//   - empty / unknown assignee        -> null  (no dispatch)
//   - the human owner (OWNER_NAME)     -> null  (humans never get a prompt)
//   - the bot / main agent             -> MAIN_AGENT_ID (main channels session)
//   - a sub-agent, ONLY if its session is running -> that agent's id
//     (a non-running sub-agent is a silent no-op; the card just stays in
//      in_progress rather than queuing a message for a session that isn't up)
//   - the mover IS the assignee (self-move) -> null (no echo)
//
// The self-move rule exists because an agent that picks up its own card does
// not need to be told to start what it just started: the dispatch would arrive
// as a fresh "[Kanban feladat #...]" assignment for work already in flight, and
// an agent has no way to tell that echo apart from a real, new assignment. The
// mover's identity travels as `actor` on POST /api/kanban/:id/move; when the
// caller does not send one the rule is inert and dispatch behaves as before.

export interface DispatchResolveOpts {
  ownerName: string
  botName: string
  mainAgentId: string
  agentNames: string[]
  isRunning: (name: string) => boolean
  /** Who moved the card (kanban_card_events.actor). Omitted -> no self-move check. */
  actor?: string | null
}

// Map any human-typed reference (display name, canonical id, any casing) onto
// the id the dispatcher works with, or null when it names nobody dispatchable.
// Deliberately ignores isRunning: this answers "who is this", not "can we reach
// them" -- a self-move must be recognised as such whether or not the session is up.
function canonicalAgentId(
  ref: string | null | undefined,
  opts: DispatchResolveOpts,
): string | null {
  const a = (ref ?? '').trim()
  if (!a) return null
  const lower = a.toLowerCase()
  if (a === opts.ownerName) return null
  if (lower === opts.botName.toLowerCase() || lower === opts.mainAgentId.toLowerCase()) {
    return opts.mainAgentId
  }
  return opts.agentNames.find((n) => n.toLowerCase() === lower) ?? null
}

/** Why no message went out -- the caller must tell 'nobody to wake' apart from
 *  'somebody to wake, unreachable'. Only 'session-down' is a fault: the card is
 *  in_progress for a real fleet agent that was never told. */
export type DispatchSkipReason = 'not-dispatchable' | 'self-move' | 'session-down'

export interface DispatchDecision {
  /** Who to wake, or null when no message goes out. */
  target: string | null
  /** Set exactly when target is null. */
  reason?: DispatchSkipReason
  /** The resolved agent id when the session is down -- for the alert text. */
  unreachable?: string
}

export function resolveKanbanDispatch(
  assignee: string | null | undefined,
  opts: DispatchResolveOpts,
): DispatchDecision {
  const target = canonicalAgentId(assignee, opts)
  // Empty, unknown, or the human owner: nobody is expected to be woken.
  if (!target) return { target: null, reason: 'not-dispatchable' }

  // Self-move: the agent that moved the card is the one we would wake.
  const mover = canonicalAgentId(opts.actor, opts)
  if (mover && mover === target) return { target: null, reason: 'self-move' }

  // The main agent always has a session; a sub-agent is dispatched only if its
  // session is running. A down session used to be a SILENT no-op -- the card
  // sat in in_progress with nobody working it and nothing said so.
  if (target === opts.mainAgentId) return { target }
  if (opts.isRunning(target)) return { target }
  return { target: null, reason: 'session-down', unreachable: target }
}

/** Target-only view, kept for callers that only need "who, if anyone". */
export function resolveKanbanDispatchTarget(
  assignee: string | null | undefined,
  opts: DispatchResolveOpts,
): string | null {
  return resolveKanbanDispatch(assignee, opts).target
}
