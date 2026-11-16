// PLANROTATEDEADLOCK1115 P3 + P6: the plan rotation runs in the dashboard backend, with no agent turn.
//
// Why: the check used to run as a scheduled task of the MAIN agent. An exhausted main agent (429) cannot run a turn,
// so the very turn that would rotate it never ran. Here the dashboard process runs the same decision
// (rotateCheckOnce), sends the owner signal itself (notifyOwner: Slack target, else the channel's bot, gromzo relays)
// and calls the same rotation the route does (rotatePlan).
//
// Per action, in order (the order of rotateCheckOnce):
//   ROTATE                      signal FIRST (the main agent restarts next), then rotatePlan. If the signal fails, the
//                               rotation still happens (owner decision D1): the text is queued and retried next tick.
//   SUBAGENT_ROTATE             rotatePlan FIRST (the main agent does not restart), then the signal with the outcome.
//   NO_ALTERNATIVE / SUBAGENT_* one signal per window (the key: kind, agent, plan, trigger, the window's end).
//   FLEET_*                     relayed.
// P6: every finished tick writes backend.lastCheckAt; a separate watch alerts the owner once per stale episode when
// rotation is on and the last check is older than 30 minutes.
import { logger } from '../logger.js'
import { APP_TZ, MAIN_AGENT_ID } from '../config.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { notifyOwner } from '../notify.js'
import { rotateCheckOnce, type RotationAction } from '../claude-plan-rotate-check-run.js'
import { rotatePlan } from './routes/claude-plans.js'
import { readClaudePlans } from './claude-plans.js'
import { readClaudePlansState, writeClaudePlansState, type ClaudePlansState, type RotationBackendRecord } from './claude-plans-state.js'
import { approvalTextLang } from './agent-text-lang.js'
import { withRotationLock } from './claude-rotation-lock.js'

export const ROTATION_FIRST_DELAY_MS = 2 * 60_000
export const ROTATION_DEFAULT_EVERY_MIN = 10
export const ROTATION_STALE_AFTER_MS = 30 * 60_000
export const ROTATION_STALE_WATCH_EVERY_MS = 5 * 60_000
const NO_ALT_KEYS_KEPT = 50
/** Unsent owner signals kept for the retry; older ones are dropped and counted (Samu, #2821). */
export const PENDING_SIGNALS_KEPT = 20

type Lang = 'hu' | 'en'

export interface RotationBackendDeps {
  check: () => Promise<RotationAction[]>
  rotate: (input: { agentId: string; targetPlanId: string; continue: boolean }) => Promise<{ status: number; payload: Record<string, unknown> }>
  notify: (text: string) => Promise<boolean>
  readState: () => ClaudePlansState
  writeState: (s: ClaudePlansState) => void
  planLabel: (planId: string) => string
  rotationOn: () => boolean
  now: () => number
  lang: () => Lang
}

function settingOn(key: string): boolean {
  try { return String(getEffectiveSettingValue(key)) === '1' } catch { return false }
}

export function defaultRotationBackendDeps(): RotationBackendDeps {
  return {
    check: () => rotateCheckOnce(),
    rotate: (input) => rotatePlan(input),
    notify: (text) => notifyOwner(text),
    readState: readClaudePlansState,
    writeState: writeClaudePlansState,
    planLabel: (id) => readClaudePlans().find((p) => p.id === id)?.label ?? id,
    rotationOn: () => settingOn('CLAUDE_ROTATION_ENABLED'),
    now: () => Date.now(),
    lang: () => (approvalTextLang() === 'en' ? 'en' : 'hu'),
  }
}

/** A field of a check line, read up to the next ` key=` (a label may hold spaces; ids never do). */
export function lineField(line: string, key: string): string {
  const m = new RegExp(`(?:^| )${key}=(.*?)(?= [A-Za-z]+=|$)`).exec(line)
  return m ? m[1] : ''
}

function rotateText(a: RotationAction, lang: Lang, targetLabel: string, sub: boolean): string {
  const f = (k: string) => lineField(a.line, k)
  const agent = f('agent')
  return lang === 'en'
    ? `${sub ? `Sub-agent ${agent}: ` : ''}Claude plan switch: ${f('currentLabel')} (${f('currentPct')}%, ${f('trigger')}, resets in ${f('resetsInMin')} min) -> ${targetLabel}.${sub ? '' : ' The main session restarts now.'}`
    : `${sub ? `Al-ügynök (${agent}): ` : ''}Claude-plan váltás: ${f('currentLabel')} (${f('currentPct')}%, ${f('trigger')}, reset ${f('resetsInMin')} perc múlva) -> ${targetLabel}.${sub ? '' : ' A fő munkamenet most újraindul.'}`
}

function noAltText(a: RotationAction, lang: Lang, sub: boolean): string {
  const f = (k: string) => lineField(a.line, k)
  return lang === 'en'
    ? `${sub ? `Sub-agent ${f('agent')}: ` : ''}the Claude plan ${f('currentLabel')} is at ${f('currentPct')}% (${f('trigger')}, resets in ${f('resetsInMin')} min), and there is no registered plan to switch to.`
    : `${sub ? `Al-ügynök (${f('agent')}): ` : ''}a(z) ${f('currentLabel')} Claude-plan ${f('currentPct')}%-on áll (${f('trigger')}, reset ${f('resetsInMin')} perc múlva), és nincs regisztrált plan, amire váltani lehetne.`
}

function fleetText(a: RotationAction, lang: Lang): string {
  const failed = lineField(a.line, 'failed')
  const head = lang === 'en' ? `Claude plan fleet step: ${a.line}` : `Claude-plan flotta-lépés: ${a.line}`
  if (!failed || failed === '-' || failed === 'none') return head
  return lang === 'en'
    ? `${head}\nNot restarted, needs a look: ${failed}`
    : `${head}\nNem indult újra, beavatkozás kell: ${failed}`
}

function failText(lang: Lang, agentId: string, status: number, payload: Record<string, unknown>): string {
  const err = typeof payload.error === 'string' ? payload.error : JSON.stringify(payload)
  return lang === 'en'
    ? `Claude plan switch for ${agentId} FAILED (HTTP ${status}): ${err}`
    : `A(z) ${agentId} Claude-plan váltása NEM sikerült (HTTP ${status}): ${err}`
}

function droppedText(lang: Lang, n: number): string {
  return lang === 'en'
    ? `${n} earlier Claude plan rotation signal(s) could not be delivered and were dropped (only the last ${PENDING_SIGNALS_KEPT} are kept).`
    : `A Claude-plan rotáció ${n} korábbi jelzése nem ért célba, és kiesett a sorból (csak az utolsó ${PENDING_SIGNALS_KEPT} marad meg).`
}

/** HH:MM in the box's zone (SCHEDULER_TZ), for the original time of a queued signal. */
export function clockHHMM(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
}

/** The NO_ALTERNATIVE dedupe key: kind, agent, plan label, trigger, and the window's end rounded to 30 minutes. */
export function noAlternativeKey(a: RotationAction, nowMs: number): string {
  const f = (k: string) => lineField(a.line, k)
  const endMin = Math.round(nowMs / 60_000 + Number(f('resetsInMin') || 0))
  return [a.kind, f('agent'), f('currentLabel'), f('trigger'), Math.round(endMin / 30)].join('|')
}

export interface RotationTickSummary {
  actions: string[]
  rotated: string[]
  signalsSent: number
  signalsQueued: number
}

/** One tick: the queued signals first, then the check and its actions. Holds the rotation lock throughout. */
export function runRotationTick(deps: RotationBackendDeps = defaultRotationBackendDeps()): Promise<RotationTickSummary> {
  return withRotationLock(() => tickBody(deps))
}

async function tickBody(deps: RotationBackendDeps): Promise<RotationTickSummary> {
  const lang = deps.lang()
  const summary: RotationTickSummary = { actions: [], rotated: [], signalsSent: 0, signalsQueued: 0 }
  const queued: string[] = []
  const notify = async (text: string): Promise<boolean> => {
    try { return await deps.notify(text) } catch { return false }
  }
  // A signal queued for a retry keeps the time it was first meant for, so a late "restarts now" says when.
  const send = async (text: string, retry = false): Promise<void> => {
    if (await notify(text)) { summary.signalsSent++; return }
    queued.push(retry ? text : `[${clockHHMM(deps.now())}] ${text}`)
    summary.signalsQueued++
    logger.warn('claude rotation backend: owner signal not delivered, queued for the next tick')
  }

  // Signals a previous tick could not deliver: first how many fell off the queue, then the rest, oldest first.
  const before = deps.readState().backend
  let dropped = before?.pendingDropped ?? 0
  if (dropped > 0 && await notify(droppedText(lang, dropped))) { summary.signalsSent++; dropped = 0 }
  for (const text of before?.pendingSignals ?? []) await send(text, true)

  const noAltSent = new Set(deps.readState().backend?.noAlternativeSent ?? [])
  const noAltAdded: string[] = []
  const actions = await deps.check()
  for (const a of actions) {
    summary.actions.push(a.kind)
    const agentId = lineField(a.line, 'agent') || MAIN_AGENT_ID
    const target = lineField(a.line, 'target')
    if (a.kind === 'ROTATE') {
      await send(rotateText(a, lang, deps.planLabel(target), false))
      const r = await deps.rotate({ agentId, targetPlanId: target, continue: false })
      if (r.status === 200) summary.rotated.push(agentId)
      else await send(failText(lang, agentId, r.status, r.payload))
      logger.info({ agentId, targetPlanId: target, status: r.status }, 'claude rotation backend: main agent rotation')
    } else if (a.kind === 'SUBAGENT_ROTATE') {
      const r = await deps.rotate({ agentId, targetPlanId: target, continue: false })
      if (r.status === 200) {
        summary.rotated.push(agentId)
        const auth = typeof r.payload.launchAuth === 'string' ? ` (launchAuth=${r.payload.launchAuth})` : ''
        await send(rotateText(a, lang, deps.planLabel(target), true) + auth)
      } else await send(failText(lang, agentId, r.status, r.payload))
      logger.info({ agentId, targetPlanId: target, status: r.status }, 'claude rotation backend: sub-agent rotation')
    } else if (a.kind === 'NO_ALTERNATIVE' || a.kind === 'SUBAGENT_NO_ALTERNATIVE') {
      const key = noAlternativeKey(a, deps.now())
      if (!noAltSent.has(key)) {
        await send(noAltText(a, lang, a.kind === 'SUBAGENT_NO_ALTERNATIVE'))
        noAltSent.add(key)
        noAltAdded.push(key)
      }
    } else if (a.kind.startsWith('FLEET_')) {
      await send(fleetText(a, lang))
    } else {
      logger.warn({ kind: a.kind }, 'claude rotation backend: an action kind it does not know, not acted on')
    }
  }

  // Bookkeeping on a FRESH read: the check and the rotation wrote the side-car meanwhile.
  const s = deps.readState()
  const prev: RotationBackendRecord = s.backend ?? {}
  const keys = [...(prev.noAlternativeSent ?? []), ...noAltAdded].slice(-NO_ALT_KEYS_KEPT)
  const over = Math.max(0, queued.length - PENDING_SIGNALS_KEPT)
  if (over > 0) { dropped += over; logger.warn({ dropped: over }, 'claude rotation backend: unsent owner signals dropped, the queue is full') }
  const kept = queued.slice(over)
  deps.writeState({
    ...s,
    backend: {
      ...prev,
      lastCheckAt: deps.now(),
      ...(kept.length ? { pendingSignals: kept } : { pendingSignals: undefined }),
      pendingDropped: dropped > 0 ? dropped : undefined,
      ...(keys.length ? { noAlternativeSent: keys } : {}),
    },
  })
  return summary
}

/** P6: the text of the stale-check alert, or null when nothing is stale (or it was already said for this episode). */
export function staleCheckAlert(input: {
  rotationOn: boolean
  backend: RotationBackendRecord | undefined
  startedAt: number
  nowMs: number
  lang: Lang
}): string | null {
  const { rotationOn, backend, startedAt, nowMs, lang } = input
  if (!rotationOn) return null
  const last = backend?.lastCheckAt ?? startedAt
  if (nowMs - last <= ROTATION_STALE_AFTER_MS) return null
  if (backend?.staleAlertAt !== undefined && backend.staleAlertAt >= last) return null
  const min = Math.round((nowMs - last) / 60_000)
  return lang === 'en'
    ? `The Claude plan rotation check has not run for ${min} minutes (rotation is on). An exhausted plan would not be switched until it runs again.`
    : `A Claude-plan rotáció ellenőrzése ${min} perce nem futott le (a rotáció be van kapcsolva). Egy kimerült plant addig nem vált le.`
}

export function rotationCheckEveryMs(): number {
  let min = ROTATION_DEFAULT_EVERY_MIN
  try {
    const v = Number(getEffectiveSettingValue('CLAUDE_ROTATION_CHECK_EVERY_MIN'))
    if (Number.isInteger(v) && v >= 1) min = v
  } catch { /* the default */ }
  return min * 60_000
}

/** Started by web.ts with the background services; first tick 2 minutes after start, then every N minutes. */
export function startRotationBackend(deps: RotationBackendDeps = defaultRotationBackendDeps()): { stop: () => void } {
  const startedAt = deps.now()
  let running = false
  const tick = (): void => {
    if (running) return
    running = true
    void runRotationTick(deps)
      .catch((err) => logger.error({ err: err instanceof Error ? err.name : 'error' }, 'claude rotation backend: tick failed'))
      .finally(() => { running = false })
  }
  const watch = (): void => {
    try {
      const state = deps.readState()
      const text = staleCheckAlert({ rotationOn: deps.rotationOn(), backend: state.backend, startedAt, nowMs: deps.now(), lang: deps.lang() })
      if (!text) return
      void deps.notify(text).catch(() => false)
      deps.writeState({ ...state, backend: { ...(state.backend ?? {}), staleAlertAt: deps.now() } })
      logger.warn('claude rotation backend: the check is stale, owner alerted')
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.name : 'error' }, 'claude rotation backend: stale watch failed')
    }
  }
  const first = setTimeout(tick, ROTATION_FIRST_DELAY_MS)
  const every = setInterval(tick, rotationCheckEveryMs())
  const stale = setInterval(watch, ROTATION_STALE_WATCH_EVERY_MS)
  first.unref(); every.unref(); stale.unref()
  return { stop: () => { clearTimeout(first); clearInterval(every); clearInterval(stale) } }
}
