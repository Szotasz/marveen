import type { AlertMeta } from '../notify.js'
import { logger } from '../logger.js'

// Card 68cb6715: a sub-agent parked on a tool-permission prompt is the MAIN
// AGENT's to look at first (an inter-agent message; it may answer Escape, which
// is "no", but never yes), and it reaches the owner only when the SAME prompt
// still stands after the main agent's head start. The shape this replaces,
// measured 2026-09-26: a sub-agent sat on one prompt for 5.5 hours, the owner
// got 39 alerts, and the main agent, which could have answered it with Escape,
// was told nothing.
//
// Composed with PERMFLOOD1012 (permission-prompt-alert.ts): this module decides
// WHO is told; WHEN the owner is told is that module's reminder marks
// (PERMISSION_ALERT_MARKS), measured from the first sighting. Their first mark
// is the head start (15 min by default), so there is one clock and one setting,
// and "the owner in N min" in the main agent's message stays true for any
// configured marks. After it the owner hears at the next marks, not at every
// alert tick: the 5.5-hour prompt above is 4 owner messages, not 57.
//
// The main agent's own pane is the exception on the main-agent side: it cannot
// answer a prompt that is blocking it, so nobody is told before the owner. The
// owner hears on the same marks, not at once and not at every tick: the flood
// PERMFLOOD1012 measured (95 messages for one prompt) was a main pane.
//
// The decision is pure (no clock, no I/O); escalatePermissionPrompt below is the
// wiring, with the two sends injected. The menu pass calls it (through
// runPermissionPromptPass) on its alert ticks only (decidePaneErrorAlert's
// `alert`: ~45 s after the prompt is confirmed, then once per dedup window while
// it stands) and drops the state when the menu spell ends, so a prompt answered
// in between never reaches the owner.

export interface PermPromptEscalationState {
  /** When the main agent was told about this prompt. */
  mainNotifiedAt: number
  /** What makes the prompt THIS prompt; a different prompt starts a new round. */
  signature: string
}

export type PermPromptAction = 'notify-main' | 'notify-owner' | 'notify-both' | 'wait'

export interface PermPromptEscalationDecision {
  /** Tell the main agent now (a new round on a sub-agent's pane). */
  notifyMain: boolean
  next: PermPromptEscalationState | null
}

/**
 * Pure: is this a new round, so the main agent is told? The signature is the
 * card identity (permissionPromptIdentity, never sent anywhere), not the card
 * summary: the summary is null on every card without a reason block, and two
 * different such prompts would then read as one round.
 */
export function decidePermissionPromptEscalation(
  prev: PermPromptEscalationState | null,
  signature: string,
  now: number,
  opts: { isMainAgent: boolean },
): PermPromptEscalationDecision {
  if (opts.isMainAgent) return { notifyMain: false, next: null }
  // A new prompt, or a stored time in the future (clock skew), starts a new
  // round.
  if (prev === null || prev.signature !== signature || now < prev.mainNotifiedAt) {
    return { notifyMain: true, next: { mainNotifiedAt: now, signature } }
  }
  return { notifyMain: false, next: prev }
}

export interface PermPromptSinks {
  /** Enqueues the inter-agent message to the main agent; throws when it cannot. */
  messageMainAgent: (text: string) => void
  /** The owner alert (notifyChannel underneath). */
  alertOwner: (text: string, meta: AlertMeta) => void
}

export interface PermPromptInput {
  session: string
  /** The agent's display name, as the alerts call it. */
  label: string
  isMainAgent: boolean
  /** What the prompt asks, one line, for the main-agent message (null: nothing readable). */
  ask: string | null
  /** permissionPromptIdentity of the card. */
  signature: string
  now: number
  /** The owner alert due on this tick by the reminder marks; null between marks. */
  ownerText: string | null
  /** The owner alert for this moment, sent when the main agent cannot be told. */
  fallbackOwnerText: string
  /** The head start the main-agent message promises: the first reminder mark. */
  ownerAfterMs: number
}

// The menu pass's permission-prompt step, on one alert tick: decide, keep the
// state, and tell whom it is time to tell. A main-agent message that cannot be
// enqueued falls back to the owner at once, so the prompt is never left with
// nobody told; the round is kept, so the owner then follows the marks instead
// of hearing on every tick.
export function escalatePermissionPrompt(
  states: Map<string, PermPromptEscalationState>,
  input: PermPromptInput,
  sinks: PermPromptSinks,
): PermPromptAction {
  const esc = decidePermissionPromptEscalation(states.get(input.session) ?? null, input.signature, input.now, {
    isMainAgent: input.isMainAgent,
  })
  if (esc.next) states.set(input.session, esc.next)
  else states.delete(input.session)
  const meta: AlertMeta = { agent: input.label, kind: 'permission-prompt' }
  let toldMain = false
  if (esc.notifyMain) {
    try {
      sinks.messageMainAgent(formatPermissionPromptMainAlert(input.label, input.session, input.ask, input.ownerAfterMs))
      logger.info({ agent: input.label, kind: meta.kind, recipient: 'main-agent' }, 'permission prompt surfaced to the main agent first')
      toldMain = true
    } catch (err) {
      logger.warn({ err, agent: input.label }, 'permission prompt: main-agent message failed -- alerting the owner instead')
      sinks.alertOwner(input.ownerText ?? input.fallbackOwnerText, meta)
      return 'notify-owner'
    }
  }
  if (input.ownerText != null) {
    sinks.alertOwner(input.ownerText, meta)
    return toldMain ? 'notify-both' : 'notify-owner'
  }
  return toldMain ? 'notify-main' : 'wait'
}

// The inter-agent message the main agent gets on the first sighting. It says
// what is asked, what the main agent may do (Escape only), and when the owner
// is told -- so a silent main agent is a choice, not a missed message.
export function formatPermissionPromptMainAlert(
  agent: string,
  session: string,
  ask: string | null,
  ownerAfterMs: number,
): string {
  const min = Math.round(ownerAfterMs / 60000)
  const what = ask ? ` It asks: ${ask}` : ''
  const owner = min > 0
    ? `If the same prompt still stands in ${min} min, the owner gets the alert.`
    : 'The owner gets the alert as well.'
  return `[permission-prompt] Agent '${agent}' (tmux ${session}) is waiting on a TOOL-PERMISSION PROMPT.${what} ` +
    'You are told first: if the request must not run, answer it with Escape in the pane (Escape means NO). ' +
    'Never answer yes on its behalf -- a yes is the owner\'s. ' +
    `${owner} Pane: tmux attach -t ${session}`
}
