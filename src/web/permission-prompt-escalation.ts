import type { PermissionPromptSummary } from '../pane-state.js'
import type { AlertMeta } from '../notify.js'
import { logger } from '../logger.js'

// Card 68cb6715: a sub-agent parked on a tool-permission prompt is the MAIN
// AGENT's to look at first (an inter-agent message; it may answer Escape, which
// is "no", but never yes), and it reaches the owner only when the SAME prompt
// still stands PERM_PROMPT_OWNER_AFTER_MS after the main agent was told. From
// then on the owner alert repeats at the menu pass's own cadence, as before.
// The shape this replaces, measured 2026-09-26: a sub-agent sat on one prompt
// for 5.5 hours, the owner got 39 alerts, and the main agent, which could have
// answered it with Escape, was told nothing.
//
// The main agent's own pane is the exception: it cannot answer a prompt that
// is blocking it, so that one goes to the owner straight away, unchanged.
//
// The decision is pure (no clock, no I/O); escalatePermissionPrompt below is the
// wiring, with the two sends injected. The menu pass calls it on its alert
// ticks only (decidePaneErrorAlert's `alert`: ~45 s after the prompt is
// confirmed, then once per dedup window while it stands) and drops the state
// when the menu spell ends, so a prompt answered in between never reaches the
// owner.

export const PERM_PROMPT_OWNER_AFTER_MS = 15 * 60 * 1000

export interface PermPromptEscalationState {
  /** When the main agent was told about this prompt. */
  mainNotifiedAt: number
  /** What the prompt asks; a different prompt starts a new round. */
  signature: string
}

export type PermPromptAction = 'notify-main' | 'notify-owner' | 'wait'

export interface PermPromptEscalationDecision {
  action: PermPromptAction
  next: PermPromptEscalationState | null
}

// The question a prompt asks is what makes it "the same prompt". An
// unrecognised card shape yields '' -- stable, so it still escalates.
export function permissionPromptSignature(ask: PermissionPromptSummary | null): string {
  return ask ? `${ask.title}\n${ask.reason}` : ''
}

export function decidePermissionPromptEscalation(
  prev: PermPromptEscalationState | null,
  signature: string,
  now: number,
  opts: { isMainAgent: boolean; ownerAfterMs?: number },
): PermPromptEscalationDecision {
  if (opts.isMainAgent) return { action: 'notify-owner', next: null }
  const ownerAfterMs = opts.ownerAfterMs ?? PERM_PROMPT_OWNER_AFTER_MS
  // A new prompt, or a stored time in the future (clock skew), starts a new
  // round: a skewed stamp must not hold the owner alert back forever.
  if (prev === null || prev.signature !== signature || now < prev.mainNotifiedAt) {
    return { action: 'notify-main', next: { mainNotifiedAt: now, signature } }
  }
  if (now - prev.mainNotifiedAt >= ownerAfterMs) return { action: 'notify-owner', next: prev }
  return { action: 'wait', next: prev }
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
  ask: PermissionPromptSummary | null
  now: number
  /** The owner alert text (the menu pass keeps its wording). */
  ownerText: string
}

// The menu pass's permission-prompt step, on one alert tick: decide, keep the
// state, and tell whom it is time to tell. A main-agent message that cannot be
// enqueued falls back to the owner at once (and the round restarts on the next
// tick), so the prompt is never left with nobody told.
export function escalatePermissionPrompt(
  states: Map<string, PermPromptEscalationState>,
  input: PermPromptInput,
  sinks: PermPromptSinks,
): PermPromptAction {
  const esc = decidePermissionPromptEscalation(states.get(input.session) ?? null, permissionPromptSignature(input.ask), input.now, {
    isMainAgent: input.isMainAgent,
  })
  if (esc.next) states.set(input.session, esc.next)
  else states.delete(input.session)
  const meta: AlertMeta = { agent: input.label, kind: 'permission-prompt' }
  if (esc.action === 'notify-main') {
    try {
      sinks.messageMainAgent(formatPermissionPromptMainAlert(input.label, input.session, input.ask))
      logger.info({ agent: input.label, kind: meta.kind, recipient: 'main-agent' }, 'permission prompt surfaced to the main agent first')
    } catch (err) {
      logger.warn({ err, agent: input.label }, 'permission prompt: main-agent message failed -- alerting the owner instead')
      states.delete(input.session)
      sinks.alertOwner(input.ownerText, meta)
    }
  } else if (esc.action === 'notify-owner') {
    sinks.alertOwner(input.ownerText, meta)
  }
  return esc.action
}

// The inter-agent message the main agent gets on the first sighting. It says
// what is asked, what the main agent may do (Escape only), and when the owner
// is told -- so a silent main agent is a choice, not a missed message.
export function formatPermissionPromptMainAlert(
  agent: string,
  session: string,
  ask: PermissionPromptSummary | null,
  ownerAfterMs: number = PERM_PROMPT_OWNER_AFTER_MS,
): string {
  const min = Math.round(ownerAfterMs / 60000)
  const what = ask ? ` It asks: ${ask.title} -- ${ask.reason}` : ''
  return `[permission-prompt] Agent '${agent}' (tmux ${session}) is waiting on a TOOL-PERMISSION PROMPT.${what} ` +
    'You are told first: if the request must not run, answer it with Escape in the pane (Escape means NO). ' +
    'Never answer yes on its behalf -- a yes is the owner\'s. ' +
    `If the same prompt still stands in ${min} min, the owner gets the alert. Pane: tmux attach -t ${session}`
}
