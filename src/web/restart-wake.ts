// RESTARTWAKE927 (df5beec4; decision (b'), 2026-09-27).
//
// A `--continue` restart that interrupts work leaves the agent at an empty
// prompt: the conversation is back, the running turn is gone, and nothing
// types into the pane until someone writes to the agent. Measured 2026-09-25
// 10:13Z: 16 sub-agents restarted through POST /api/agents/<name>/restart sat
// idle on their open cards until an owner noticed. The same shape follows the
// plan switches and the model-fallback demotion, which restart a busy pane.
//
// The wake lives in ONE place, restartAgentProcess, behind a per-caller switch
// that defaults OFF, so a caller that is not listed keeps today's behaviour:
//   ON:  the /restart route's --continue branch (a {"wake": false} body turns it
//        off), the sub-agent plan switch, the fleet plan switch, the
//        model-fallback demotion;
//   OFF: the auto-restart (it only restarts an idle pane) and every fresh
//        restart (the context guard injects its own resume directive).
// One restart owes at most one wake: a newer restart re-arms the timer instead
// of stacking a second wake, and a fresh restart cancels a pending one. The
// wake is a system directive (GUARDHITELES903): it asks the agent to act, so it
// travels with a verifiable queue anchor, and it waits for an idle pane and
// gives up on a busy one -- a pane that is already working was woken by
// someone else. No caller in this repository sends {"wake": false} today; the
// switch is there for an external script that restarts an agent and then types
// its own instruction, so it does not get a second one ~25 s later.
//
// MAINRESTARTWAKE1115: the MANUAL restart of the main agent is the one fresh
// restart that had no directive of its own. POST /api/marveen/restart (and the
// main branch of POST /api/agents/<name>/restart) respawn the channels session
// with no --continue and typed nothing into it, so the fresh session sat at an
// empty prompt until some other input arrived. Measured 2026-11-14: a manual
// restart at 23:09:33 stayed idle until the first scheduled task fired at
// 23:15:12. Those two routes now owe the main agent one wake with its own text
// (mainRestartWakePrompt: the conversation is NOT back, so it points at
// HANDOFF.md and the kanban instead of "your last steps"). Every other caller
// of hardRestartMarveenChannels() stays without one: the context guard and the
// restart gate inject their own directive, and the recovery paths (reauth,
// inbound probe, stuck input, onboarding, rotation) restart a session that had
// nothing to resume. The pending wake is an in-memory timer: a dashboard
// restart inside the boot grace loses it, and the session then waits for its
// next input exactly as it did before this change.
import { logger } from '../logger.js'

/** Grace for the restarted session's boot + SessionStart hooks, as the restart gate's WAKE_DELAY_MS. */
export const RESTART_WAKE_DELAY_MS = 25_000

export interface RestartWakeRequest {
  /** Which caller restarted the agent; it goes into the wake text and the log. */
  reason: string
}

export type RestartWakeOutcome = 'sent' | 'aborted-busy' | 'skipped-locked'

export type RestartWakeSender = (agent: string, session: string, text: string) => Promise<RestartWakeOutcome>

/** The wake text. Short on purpose: the conversation itself is back, this only restarts the turn. */
export function restartWakePrompt(reason: string): string {
  return (
    `[RESTART-WAKE] A munkamenetedet a rendszer ujrainditotta (--continue, ok: ${reason}): ` +
    'a korabbi beszelgetes megmaradt, de a futo kor megszakadt. ' +
    'Nezd meg az utolso lepeseidet es a kanban tabladat, es FOLYTASD onnan, ahol abbamaradt. ' +
    'Ne kezdd elolrol, ami mar kesz, es ne delegald ujra, amit mar atadtal. ' +
    'Ha nem volt futo munkad, az is teljes erteku allapot: olyankor ne talalj ki magadnak feladatot.'
  )
}

/**
 * The /restart route's body -> restartAgentProcess options. The wake is ON for
 * a --continue restart unless the body says exactly {"wake": false}; a fresh
 * restart never wakes. An unreadable body keeps the defaults, as the route did
 * for `fresh` before.
 */
export function restartOptsFromBody(raw: string): { fresh: boolean; wake?: RestartWakeRequest } {
  let body: unknown = {}
  try {
    body = JSON.parse(raw || '{}')
  } catch {
    body = {}
  }
  const b = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const fresh = b.fresh === true
  if (fresh || b.wake === false) return { fresh }
  return { fresh, wake: { reason: 'api-restart' } }
}

/** What the manual main restart puts into the wake text and the log as the caller. */
export const MAIN_RESTART_WAKE_REASON = 'manual-main-restart'

/**
 * The wake text for a FRESH manual restart of the main agent. Unlike
 * restartWakePrompt it must not say the conversation is back: the new session
 * knows nothing, so it is pointed at what survives a restart on disk. Nobody
 * asked for a handoff before a manual restart, so the file may be a leftover
 * of an older context-guard restart: the text says to check its date first.
 */
export function mainRestartWakePrompt(reason: string, handoffPath: string): string {
  return (
    `[RESTART-WAKE] A munkamenetedet kezzel ujrainditottak (friss inditas, ok: ${reason}): ` +
    'a korabbi beszelgetes NEM maradt meg. ' +
    `Ha letezik a ${handoffPath} fajl, nezd meg a datumat: ha friss, olvasd be, es FOLYTASD az ott leirt munkat; ` +
    'egy regi atado nem a mostani allapot, azt ne kovesd. ' +
    'Nezd meg a kanban tabladat es a hot memoriaidat is. ' +
    'Ne kezdd elolrol, ami mar kesz, es ne delegald ujra, amit mar atadtal. ' +
    'Ha nem volt futo munkad, az is teljes erteku allapot: olyankor ne talalj ki magadnak feladatot.'
  )
}

/**
 * The manual main restart's body -> wake or not. ON unless the body says
 * exactly {"wake": false}, as restartOptsFromBody does for the sub-agents: the
 * dashboard button sends no body and must wake, and a script that restarts the
 * main agent and then types its own first prompt can switch it off. Reads the
 * same body the force flag is read from; an unreadable one keeps the default.
 */
export function wantsMainRestartWake(body: Buffer | string): boolean {
  let parsed: unknown = {}
  try {
    const text = typeof body === 'string' ? body : body.toString('utf-8')
    parsed = JSON.parse(text.trim() === '' ? '{}' : text)
  } catch {
    parsed = {}
  }
  return !(parsed !== null && typeof parsed === 'object' && (parsed as Record<string, unknown>).wake === false)
}

const pending = new Map<string, ReturnType<typeof setTimeout>>()

async function sendAsDirective(agent: string, session: string, text: string): Promise<RestartWakeOutcome> {
  // Imported here, not at the top: system-directive imports agent-process,
  // which imports this module.
  const { sendSystemDirective } = await import('./system-directive.js')
  return sendSystemDirective(agent, session, text, null, { waitForIdle: true, onBusyTimeout: 'abort' })
}

/**
 * Owe the agent one wake, delivered after the boot grace. A pending wake for
 * the same agent is replaced, so the wake lands once, after the LAST restart.
 * `deps.text` replaces the --continue text (the fresh main restart has its
 * own); a caller that does not pass it gets restartWakePrompt(reason) as before.
 */
export function scheduleRestartWake(
  agent: string,
  session: string,
  reason: string,
  deps: { send?: RestartWakeSender; delayMs?: number; text?: string } = {},
): void {
  const previous = pending.get(agent)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    pending.delete(agent)
    const send = deps.send ?? sendAsDirective
    send(agent, session, deps.text ?? restartWakePrompt(reason)).then(
      (outcome) => {
        if (outcome === 'sent') logger.info({ agent, reason }, 'restart-wake: delivered')
        else logger.info({ agent, reason, outcome }, 'restart-wake: not delivered, the pane was not idle')
      },
      (err: unknown) => logger.warn({ err, agent, reason }, 'restart-wake: delivery failed'),
    )
  }, deps.delayMs ?? RESTART_WAKE_DELAY_MS)
  timer.unref?.()
  pending.set(agent, timer)
}

/**
 * Owe the main agent the fresh-restart wake. Called by the two manual restart
 * routes only, after hardRestartMarveenChannels() answered ok. Same timer map
 * as the sub-agents (keyed by the agent id), so two manual restarts inside the
 * grace still end in one wake.
 */
export function scheduleMainRestartWake(
  agent: string,
  session: string,
  handoffPath: string,
  deps: { send?: RestartWakeSender; delayMs?: number } = {},
): void {
  scheduleRestartWake(agent, session, MAIN_RESTART_WAKE_REASON, {
    ...deps,
    text: mainRestartWakePrompt(MAIN_RESTART_WAKE_REASON, handoffPath),
  })
}

/** Drop a pending wake (a fresh restart brings its own directive). True when one was pending. */
export function cancelRestartWake(agent: string): boolean {
  const timer = pending.get(agent)
  if (!timer) return false
  clearTimeout(timer)
  pending.delete(agent)
  return true
}

export function hasPendingRestartWake(agent: string): boolean {
  return pending.has(agent)
}

/** Test seam. */
export function __resetRestartWake(): void {
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
}
