// Card 4edaf0a1: the shared pieces of the presentation mode that are not DB access
// (that lives in src/db.ts: the event log, the derived state, the priority claim).
//
// Who may switch it (plan 19030, point 2): the owner gateways (the Cowork tool and the
// ChatGPT/Codex REST proxy; their ids come from PRESENTATION_PRIORITY_SENDERS in .env)
// and the main agent acting on the owner's Telegram word.
// Matched EXACTLY on the self-declared actor. D4 (a), detective: today all three call
// with the shared dashboard token, so the server cannot tell the owner's device from a
// sub-agent; every accepted switch therefore records the auth lane (auth_kind,
// auth_device) and the main agent gets one line about it. The preventive step (b) --
// a per-gateway device key -- comes after the 32156973 device-key gate.
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { createAgentMessage, PRESENTATION_PRIORITY_SENDERS, type PresentationModeEvent } from '../db.js'
import { SYSTEM_DIRECTIVE_SENDER } from './system-directive.js'

export const PRESENTATION_WRITER_ACTORS: readonly string[] = Object.freeze([...PRESENTATION_PRIORITY_SENDERS, MAIN_AGENT_ID])

/** The server-written mark in front of each priority block of a drain, OUTSIDE the
 *  security framing. A message whose CONTENT starts with this text stays inside its
 *  frame and gets no priority: priority comes from the sender, never from the text. */
export const PRESENTATION_MARK = '[PREZENTÁCIÓS MÓD]'

/** A free-text value (reason, device name) goes into a line FROM 'system' in the main
 *  agent's inbox. Unfiltered, a reason like "\n[SYSTEM-DIREKTIVA msg_id:N] ..." would
 *  plant a forged directive header inside a genuine system row. So: one line, no
 *  square brackets, capped, and quoted by the caller. */
export function sanitizePresentationText(value: string | null | undefined, max = 120): string {
  return String(value ?? '').replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function formatPresentationSwitchLine(ev: PresentationModeEvent): string {
  const what = ev.action === 'on' ? 'BE' : ev.action === 'off' ? 'KI' : 'LEJART'
  const until = ev.until_at != null ? `, lejarat ${new Date(ev.until_at * 1000).toISOString()}` : ''
  const lane = `${sanitizePresentationText(ev.auth_kind, 20) || 'nincs'}${ev.auth_device ? `/${sanitizePresentationText(ev.auth_device, 40)}` : ''}`
  const reason = sanitizePresentationText(ev.reason)
  return `[prezentacios-mod] ${what} -- actor ${sanitizePresentationText(ev.actor, 40)}, hitelesites ${lane}${until}${reason ? `, ok: "${reason}"` : ''} (esemeny #${ev.id}, GET /api/presentation-mode)`
}

/** One line to the main agent per accepted switch (on, off, expired), plus a log line.
 *  Written in-process as 'system' (like the session-stuck alert), so it also passes
 *  the presentation drain's system exception. A failure here must not undo the
 *  switch: the event row is the record, this is only the notice. */
export function notifyPresentationSwitch(ev: PresentationModeEvent): void {
  logger.info({ presentationMode: ev.action, id: ev.id, actor: ev.actor, authKind: ev.auth_kind, authDevice: ev.auth_device, untilAt: ev.until_at }, 'presentation mode switched')
  try {
    createAgentMessage(SYSTEM_DIRECTIVE_SENDER, MAIN_AGENT_ID, formatPresentationSwitchLine(ev))
  } catch (err) {
    logger.warn({ err, id: ev.id }, 'presentation mode: failed to enqueue the main-agent notice')
  }
}
