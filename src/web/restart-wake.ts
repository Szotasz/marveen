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
//
// Review round 1 (PR #2794): (C1) whether HANDOFF.md is worth reading is
// decided HERE, when the wake is sent, from the file's mtime -- a manual restart
// asks for no handoff first, so the file is usually the leftover of an older
// context-guard restart, and "continue the work there" is the one sentence that
// can restart finished work. A fresh file is named with its time; a stale or
// missing one is not mentioned at all. (C2) The text says not to post about the
// restart to the channel: an owner who restarts on purpose with nothing running
// must not get a message after every button press. (C3) Any restart of the main
// session drops a pending main wake (hardRestartMarveenChannels calls
// cancelRestartWake first), so a guard or recovery restart inside the grace does
// not get this wake next to its own directive; the two manual routes schedule
// after that call.
import { statSync } from 'node:fs'
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
 * How old a HANDOFF.md may be, at the moment the wake is sent, to be named in
 * it. A fixed bound and not "written since the previous session started": that
 * start is not readable the same way on every install (the Linux restart is a
 * respawn-pane, which keeps the tmux session's creation time; the dashboard's
 * own stamp of the last main restart lives in memory and covers its own
 * restarts only). The price of a fixed bound: a handoff the previous session
 * already consumed less than this long ago still counts as fresh, which is why
 * the text gives the file's age and sends the agent to the kanban and the hot
 * memories for what happened since.
 */
export const MAIN_HANDOFF_FRESH_MS = 2 * 60 * 60 * 1000

/** A handoff file that is fresh enough to be named: where it is, when it was written, how old it is. */
export interface FreshHandoff {
  path: string
  mtimeMs: number
  ageMs: number
}

function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * The handoff file when it is fresh at `nowMs`, else null: a missing or
 * unreadable file, and one older than the bound, are the same answer -- the
 * wake does not mention it. A file stamped in the future (a clock that moved)
 * counts as written now.
 */
export function freshHandoff(
  path: string,
  nowMs: number,
  deps: { mtimeMs?: (path: string) => number | null; maxAgeMs?: number } = {},
): FreshHandoff | null {
  const mtimeMs = (deps.mtimeMs ?? fileMtimeMs)(path)
  if (mtimeMs === null) return null
  const ageMs = Math.max(0, nowMs - mtimeMs)
  if (ageMs > (deps.maxAgeMs ?? MAIN_HANDOFF_FRESH_MS)) return null
  return { path, mtimeMs, ageMs }
}

/** "2026-11-15T16:21Z, 12 perce": the stamp to the minute (UTC) and the age in whole minutes. */
function handoffWhen(h: FreshHandoff): string {
  const stamp = `${new Date(h.mtimeMs).toISOString().slice(0, 16)}Z`
  const minutes = Math.floor(h.ageMs / 60_000)
  return `${stamp}, ${minutes < 1 ? 'kevesebb mint egy perce' : `${minutes} perce`}`
}

/**
 * The wake text for a FRESH manual restart of the main agent. Unlike
 * restartWakePrompt it must not say the conversation is back: the new session
 * knows nothing, so it is pointed at what survives a restart on disk. Whether
 * the handoff file is part of that is the caller's decision (freshHandoff), not
 * the model's: a fresh one is named with its time, a stale or missing one
 * (null) is not mentioned at all. Either way the text forbids a channel post
 * about the restart.
 */
export function mainRestartWakePrompt(reason: string, handoff: FreshHandoff | null): string {
  const where = handoff
    ? `A ${handoff.path} atado friss (irva: ${handoffWhen(handoff)}): olvasd be, es FOLYTASD az ott leirt munkat. ` +
      'Ami az atado ota tortent, azt a kanban tablad es a hot memoriaid mutatjak: azokat is nezd meg. '
    : 'Nezd meg a kanban tabladat es a hot memoriaidat, es FOLYTASD onnan a megkezdett munkat. '
  return (
    `[RESTART-WAKE] A munkamenetedet kezzel ujrainditottak (friss inditas, ok: ${reason}): ` +
    'a korabbi beszelgetes NEM maradt meg. ' +
    where +
    'Ne kezdd elolrol, ami mar kesz, es ne delegald ujra, amit mar atadtal. ' +
    'Ha nem volt futo munkad, az is teljes erteku allapot: olyankor ne talalj ki magadnak feladatot. ' +
    'Az ujrainditasrol a csatornadra NE kuldj uzenetet.'
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
 * own); a function is evaluated when the wake is sent, not when it is
 * scheduled. A caller that does not pass it gets restartWakePrompt(reason) as
 * before.
 */
export function scheduleRestartWake(
  agent: string,
  session: string,
  reason: string,
  deps: { send?: RestartWakeSender; delayMs?: number; text?: string | (() => string) } = {},
): void {
  const previous = pending.get(agent)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    pending.delete(agent)
    const send = deps.send ?? sendAsDirective
    // A function is called now, at send time: the main wake reads the handoff's age here.
    const text = typeof deps.text === 'function' ? deps.text() : deps.text
    send(agent, session, text ?? restartWakePrompt(reason)).then(
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
 * grace still end in one wake. The handoff's freshness is read when the wake is
 * SENT (`now` / `mtimeMs` are the test seams of that read).
 */
export function scheduleMainRestartWake(
  agent: string,
  session: string,
  handoffPath: string,
  deps: {
    send?: RestartWakeSender
    delayMs?: number
    now?: () => number
    mtimeMs?: (path: string) => number | null
  } = {},
): void {
  const { now, mtimeMs, ...rest } = deps
  scheduleRestartWake(agent, session, MAIN_RESTART_WAKE_REASON, {
    ...rest,
    text: () =>
      mainRestartWakePrompt(MAIN_RESTART_WAKE_REASON, freshHandoff(handoffPath, (now ?? Date.now)(), { mtimeMs })),
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
