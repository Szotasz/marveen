// /model writes, owner slash commands (CMD920 3.3).
//
//   /model [set] <choice>            -> the choice's default hold (2 h), then back
//   /model [set] <choice> 4h|30m     -> custom hold
//   /model [set] <choice> keep       -> permanent: the app .env MAIN_AGENT_MODEL line
//   /model back                      -> back to the base model now
//   /model effort <level>            -> /effort on the session (cannot be measured)
//
// The default is a TEMPORARY switch: it never writes .env, so a respawn in
// between lands on the base model -- the safe direction. The hold lives in
// store/main-model-hold.json and is swept on the context-restart gate's main
// sweep: expiry -> quiet check -> /model <base> -> state removed -> owner
// notified on the main bot, over the Bot API without a main-session turn
// (a silent revert would confuse). Busy -> wait,
// and a block longer than 30 min is reported once. If the measured model is
// already the base (a respawn happened), the state is only removed.
//
// The choice list is explicit config (store/model-choices.json), not
// discovery: there is no closed model list in the code, and an unsupported
// model fails only when called. Without the file the only choice is the
// configured model, and the reply says so.

import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { logger } from '../logger.js'
import { PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID } from '../config.js'
import { updateEnvFile } from '../env.js'
import { isValidModelId } from '../model-id.js'
import { contextLimitForModel } from '../context-guard.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { readActiveModelFromProjectDir } from './active-model.js'
import { configDirFor } from './main-transcript-root.js'
import { readConfiguredMainModel } from './channel-monitor.js'
import { gatherGateInputs, sendSlashCommand, mainSessionName } from './context-restart-gate-runner.js'
import { capturePane } from './agent-process.js'
import { switchVerdict, SWITCH_TURN_QUIET_MS, type QuietVerdict } from './session-control.js'
import { notifyChannel } from '../notify.js'
import { registerCommand } from './commands.js'
import { queuePendingWrite, readPendingWrite, runPendingWrite, clearPendingWrite, PENDING_WRITE_FILE, PENDING_WRITE_TTL_MS } from './pending-write.js'
import { formatDayClock, formatSpan, modelsDiffer, formatTokens } from './system-status.js'

export const DEFAULT_HOLD_MINUTES = 120
export const BLOCK_ALERT_MS = 30 * 60_000
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const MODEL_CHOICES_FILE = join(STORE_DIR, 'model-choices.json')
export const MODEL_HOLD_FILE = join(STORE_DIR, 'main-model-hold.json')
/** The last /model this module sent to the session: { model, at } (epoch ms). */
export const MODEL_LAST_SENT_FILE = join(STORE_DIR, 'main-model-last-sent.json')

/** acked: the CLI printed its "Set model to" line for this send. */
export interface LastSent { model: string; at: number; acked: boolean }

export function readLastSent(file: string): LastSent | null {
  try {
    const p = JSON.parse(readFileSync(file, 'utf-8')) as Partial<LastSent>
    return typeof p.model === 'string' && typeof p.at === 'number' && Number.isFinite(p.at)
      ? { model: p.model, at: p.at, acked: p.acked === true }
      : null
  } catch { return null }
}

function writeLastSent(file: string, model: string, at: number, acked: boolean): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    atomicWriteFileSync(file, JSON.stringify({ model, at, acked }) + '\n')
  } catch (err) {
    logger.warn({ err, file }, 'main-model: last-sent marker not written')
  }
}

// Claude Code answers a /model with a "Set model to ..." line in the pane
// (measured: "Set model to claude-opus-5[1m]" and, on another build,
// "Set model to `Opus 5 (1M context)`" -- so only the prefix is matched, never
// the name). One count before the send, one after: an increase is the CLI's
// own acknowledgement. Visible pane only; if an old line scrolls off at the
// same moment the count does not rise and the reply stays the cautious
// "elküldve" -- never a false "átváltva".
export function countModelAcks(pane: string | null): number | null {
  return pane === null ? null : (pane.match(/Set model to\b/g) ?? []).length
}

// The CLI refuses a model it does not support with an API error in the pane,
// e.g. "API error: 400 {...Claude Code 2.1.110 does not support this model;
// version 2.1.251 or newer is required...}" (measured on the test bot,
// 2026-09-23, /model fable). Counted like the acks: a rise after our send is
// a refusal; its message, when readable, goes into the reply.
export function countModelRejections(pane: string | null): number | null {
  return pane === null ? null : (pane.match(/API error: \d{3}/g) ?? []).length
}

export function lastRejectionMessage(pane: string | null): string | null {
  if (!pane) return null
  const flat = pane.replace(/\s*\n\s*/g, ' ')
  const all = [...flat.matchAll(/"message":"((?:[^"\\]|\\.)*)"/g)]
  return all.length ? all[all.length - 1][1] : null
}

export interface ModelChoice {
  name: string
  id: string
  purpose?: string
  defaultHoldMinutes: number
}

export interface ChoiceList {
  choices: ModelChoice[]
  /** false: store/model-choices.json is missing, the list is the configured model only. */
  fromFile: boolean
}

// Throws on a corrupt file: a broken choice list must not silently shrink
// to "the configured model".
export function readModelChoices(file: string, configured: string): ChoiceList {
  if (!existsSync(file)) {
    return { choices: [{ name: configured, id: configured, defaultHoldMinutes: DEFAULT_HOLD_MINUTES }], fromFile: false }
  }
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, { id?: unknown; purpose?: unknown; default_hold_minutes?: unknown }>
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('model-choices.json: objektum kell (név -> { id, purpose, default_hold_minutes })')
  const choices: ModelChoice[] = []
  for (const [name, v] of Object.entries(parsed)) {
    if (!v || typeof v.id !== 'string' || !isValidModelId(v.id)) throw new Error(`model-choices.json: "${name}" id-ja érvénytelen`)
    const hold = typeof v.default_hold_minutes === 'number' && v.default_hold_minutes > 0 ? Math.floor(v.default_hold_minutes) : DEFAULT_HOLD_MINUTES
    choices.push({ name, id: v.id, purpose: typeof v.purpose === 'string' ? v.purpose : undefined, defaultHoldMinutes: hold })
  }
  return { choices, fromFile: true }
}

export function resolveChoice(arg: string, list: ChoiceList): ModelChoice | null {
  const a = arg.trim().toLowerCase()
  return list.choices.find(c => c.name.toLowerCase() === a) ?? list.choices.find(c => c.id.toLowerCase() === a) ?? null
}

export interface ModelArgs {
  choice: ModelChoice | null
  effort: string | null
  hold: number | 'keep' | undefined
}

// One line, order-free: /model [<choice>] [<effort>] [<time>|keep]. The three
// parts cannot be confused -- a choice comes from the list, an effort from the
// fixed level set, a time is 4h / 30m / 90 / keep -- so `/model opus low 4m`,
// `/model low 5m` (effort only, on a timer) and `/model opus` all parse. The
// separate `/model effort <level>` form is gone: nothing shipped yet
// (ELSOKOR922 Phase 7, owner decision 2026-09-22).
export function parseModelArgs(args: string[], list: ChoiceList): ModelArgs | string {
  const a = args[0]?.toLowerCase() === 'set' ? args.slice(1) : args
  if (a.length === 0) return 'Használat: /model [<választás>] [<effort>] [<idő>|keep], pl. /model opus, /model opus low 4m, /model low 5m, /model opus keep'
  const out: ModelArgs = { choice: null, effort: null, hold: undefined }
  for (const raw of a) {
    const t = raw.trim().toLowerCase()
    // "/model effort high" (the plan's form) = "/model high"
    if (t === 'effort') continue
    if ((EFFORT_LEVELS as readonly string[]).includes(t)) {
      if (out.effort) return `Kétszer adtál meg effortot: „${raw}”.`
      out.effort = t
      continue
    }
    const choice = resolveChoice(t, list)
    if (choice) {
      if (out.choice) return `Kétszer adtál meg modellt: „${raw}”.`
      out.choice = choice
      continue
    }
    const hold = parseHold(t)
    if (hold !== null && hold !== undefined) {
      if (out.hold !== undefined) return `Kétszer adtál meg időt: „${raw}”.`
      out.hold = hold
      continue
    }
    const names = list.choices.map(c => c.name).join(', ')
    return `Nem értem: „${raw}”. Modell: ${names}${list.fromFile ? '' : ' (a store/model-choices.json hiányzik, csak a konfigurált modell)'} · effort: ${EFFORT_LEVELS.join('|')} · idő: 4h, 30m, keep.`
  }
  if (!out.choice && !out.effort) return 'Nem váltottam: adj meg modellt vagy effortot, pl. /model opus 30m vagy /model low 5m.'
  return out
}

/** '4h' | '30m' | '90' (minutes) -> minutes; 'keep' -> 'keep'; else null. */
export function parseHold(arg: string | undefined): number | 'keep' | null | undefined {
  if (arg === undefined) return undefined
  const a = arg.trim().toLowerCase()
  if (a === 'keep') return 'keep'
  const m = a.match(/^(\d{1,4})(h|m)?$/)
  if (!m) return null
  const n = Number(m[1])
  if (n <= 0) return null
  const minutes = m[2] === 'h' ? n * 60 : n
  return minutes > 7 * 24 * 60 ? null : minutes
}

export interface HoldState {
  /** null: an effort-only hold (the model was not switched). */
  model: string | null
  name: string
  revert_to: string | null
  /** The effort held, and what to put back -- null when it was not part of it. */
  effort: string | null
  /** null with a non-null `effort`: no configured base, so it cannot be put back. */
  revert_effort: string | null
  /** epoch ms */
  until: number
  set_at: number
  verify_pending: boolean
  blocked_since: number | null
  block_alert_at: number | null
}

export type HoldRead = { state: HoldState | null; error?: string }

export function readHold(file: string): HoldRead {
  if (!existsSync(file)) return { state: null }
  try {
    const p = JSON.parse(readFileSync(file, 'utf-8')) as Partial<HoldState>
    const hasModel = typeof p.model === 'string' && typeof p.revert_to === 'string'
    const hasEffort = typeof p.effort === 'string'
    if ((!hasModel && !hasEffort) || typeof p.until !== 'number' || !Number.isFinite(p.until)) {
      return { state: null, error: 'hiányzó vagy hibás mező (model+revert_to vagy effort, és until)' }
    }
    return {
      state: {
        model: hasModel ? (p.model as string) : null,
        name: typeof p.name === 'string' ? p.name : (p.model ?? p.effort ?? ''),
        revert_to: hasModel ? (p.revert_to as string) : null,
        effort: hasEffort ? (p.effort as string) : null,
        revert_effort: typeof p.revert_effort === 'string' ? p.revert_effort : null,
        until: p.until,
        set_at: typeof p.set_at === 'number' ? p.set_at : 0,
        verify_pending: p.verify_pending === true,
        blocked_since: typeof p.blocked_since === 'number' ? p.blocked_since : null,
        block_alert_at: typeof p.block_alert_at === 'number' ? p.block_alert_at : null,
      },
    }
  } catch (err) {
    return { state: null, error: err instanceof Error ? err.message : String(err) }
  }
}

export function writeHold(file: string, state: HoldState): void {
  mkdirSync(dirname(file), { recursive: true })
  atomicWriteFileSync(file, JSON.stringify(state, null, 2) + '\n')
}

export function clearHold(file: string): void {
  try { unlinkSync(file) } catch { /* already gone */ }
}

// autoCompactWindow: a smaller-window model is silently cut by the CLI.
export function readAutoCompactWindow(): number | null {
  const env = Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  if (Number.isFinite(env) && env > 0) return env
  try {
    const s = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8'))
    const v = Number(s?.autoCompactWindow)
    return Number.isFinite(v) && v > 0 ? v : null
  } catch { return null }
}

export function windowWarning(modelId: string, autoCompactWindow: number | null): string | null {
  if (autoCompactWindow === null) return null
  const limit = contextLimitForModel(modelId)
  return limit < autoCompactWindow
    ? `FIGYELEM: a(z) ${modelId} ablaka (${formatTokens(limit)}) kisebb a beállított autoCompactWindow-nál (${formatTokens(autoCompactWindow)}); a CLI némán levágja.`
    : null
}

// ---- side effects, injectable for tests --------------------------------------

export interface ModelDeps {
  now: () => number
  choicesFile: string
  holdFile: string
  configured: () => string
  /** The measured model, optionally only from transcript lines at/after sinceSec. */
  measured: (sinceSec?: number) => string | null
  quiet: (nowMs: number) => QuietVerdict
  send: (command: string) => Promise<void>
  writeEnv: (updates: Record<string, string>) => void
  notify: (text: string) => Promise<boolean>
  autoCompactWindow: () => number | null
  lastSentFile: string
  /** The effort level configured for the session, if any (the revert target). */
  configuredEffort: () => string | null
  /** Count of "Set model to" lines in the visible pane; null = not capturable. */
  ackCount: () => number | null
  /** The visible pane, for the CLI's refusal of a model (API error). */
  pane: () => string | null
  /** Pause between two ack reads (the ack wait is bounded, see sendModel). */
  sleep: (ms: number) => Promise<void>
  /** Arm (untilMs) or disarm (null) the one-shot hold-expiry timer. */
  scheduleExpiry: (untilMs: number | null) => void
}

// Measured on the test pane: the CLI prints "Set model to ..." ~1.0-1.1 s after
// the send (a fixed 0.7 s read missed it). The read stops at the first
// increase; the bound only caps a slow or silent CLI.
const ACK_WAIT_MS = 3000
const ACK_STEP_MS = 250

// One timer, armed at the exact hold expiry. The 5-minute sweep (the gate's
// disabled-recheck cadence) stays as the fallback -- after a dashboard restart,
// or when the session is busy at expiry -- but it no longer decides WHEN a
// hold ends (ELSOKOR922 Phase 7 A-smoke: a 3-minute hold reverted 5 minutes
// late, and its confirmation arrived with the same delay).
let expiryTimer: ReturnType<typeof setTimeout> | null = null

export function scheduleHoldExpiry(untilMs: number | null, nowMs = Date.now()): void {
  if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null }
  if (untilMs === null) return
  const delay = Math.max(0, untilMs - nowMs) + 1000
  expiryTimer = setTimeout(() => {
    expiryTimer = null
    sweepModelHold(Date.now()).catch(err => logger.warn({ err }, 'main-model: expiry sweep failed'))
  }, delay)
  expiryTimer.unref?.()
}

/** At boot: re-arm the expiry timer from a hold that survived the restart. */
export function armHoldExpiryFromFile(file: string = MODEL_HOLD_FILE): void {
  const { state } = readHold(file)
  if (state) scheduleHoldExpiry(state.until)
}

export const liveModelDeps: ModelDeps = {
  now: Date.now,
  choicesFile: MODEL_CHOICES_FILE,
  holdFile: MODEL_HOLD_FILE,
  configured: () => readConfiguredMainModel(PROJECT_ROOT),
  measured: (sinceSec) => readActiveModelFromProjectDir(PROJECT_ROOT, sinceSec, configDirFor(MAIN_AGENT_ID)),
  quiet: (nowMs) => {
    const { cfg, inputs } = gatherGateInputs(MAIN_AGENT_ID, nowMs)
    return switchVerdict(inputs, cfg)
  },
  send: (command) => sendSlashCommand(mainSessionName(), command),
  writeEnv: updateEnvFile,
  // ELSOKOR922 D-4: the runner's own messages go out on the main bot, over
  // the Bot API, without a main-session turn (no second bot any more).
  notify: async (text) => { await notifyChannel(text); return true },
  autoCompactWindow: readAutoCompactWindow,
  lastSentFile: MODEL_LAST_SENT_FILE,
  configuredEffort: () => readConfiguredEffort()?.value ?? null,
  ackCount: () => countModelAcks(capturePane(mainSessionName())),
  pane: () => capturePane(mainSessionName()),
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  scheduleExpiry: (untilMs) => scheduleHoldExpiry(untilMs),
}

// Send a /model and wait (bounded) for the CLI's acknowledgement. Records the
// send so a status can say "switched since the last measured turn".
export interface SendOutcome {
  acked: boolean
  /** The CLI refused the model (API error in the pane): the message, or '' if unreadable. */
  rejected: string | null
}

async function sendModel(modelId: string, deps: ModelDeps): Promise<SendOutcome> {
  const before = deps.ackCount()
  const rejBefore = countModelRejections(deps.pane())
  await deps.send(`/model ${modelId}`)
  const sentAt = deps.now()
  let acked = false
  let rejected: string | null = null
  if (before !== null) {
    for (let waited = 0; waited < ACK_WAIT_MS && !acked && rejected === null; waited += ACK_STEP_MS) {
      await deps.sleep(ACK_STEP_MS)
      const after = deps.ackCount()
      acked = after !== null && after > before
      if (!acked && rejBefore !== null) {
        const pane = deps.pane()
        const rej = countModelRejections(pane)
        if (rej !== null && rej > rejBefore) rejected = lastRejectionMessage(pane) ?? ''
      }
    }
  }
  writeLastSent(deps.lastSentFile, modelId, sentAt, acked)
  return { acked, rejected }
}

function rejectedText(modelId: string, why: string): string {
  return `Nem váltottam: a Claude Code elutasította a(z) ${modelId} modellt${why ? ` (${why})` : ''}.`
}

// A hold that expired while the session was busy: the Stop hook reports the
// end of every main-session turn (marveen-commands.py --stop -> POST
// /api/commands/turn-ended). The revert then gets ONE retry, once the turn has
// been quiet for the switch window -- an event, not a poll; the 5-minute sweep
// stays the fallback.
export function onMainTurnEnded(nowMs: number, holdFile: string = MODEL_HOLD_FILE): boolean {
  let armed = false
  // A write the session was busy for waits for exactly this moment.
  if (readPendingWrite()) {
    logger.info({ inMs: SWITCH_TURN_QUIET_MS + 1000 }, 'main-model: turn ended, pending write armed')
    setTimeout(() => {
      runPendingWrite(Date.now()).catch(err => logger.warn({ err }, 'main-model: pending write failed'))
    }, SWITCH_TURN_QUIET_MS + 1000).unref?.()
    armed = true
  }
  const { state } = readHold(holdFile)
  if (state && nowMs >= state.until) {
    scheduleHoldExpiry(nowMs + SWITCH_TURN_QUIET_MS, nowMs)
    armed = true
  }
  return armed
}

// ---- /model [set] -------------------------------------------------------------

export interface StepResult {
  ok: boolean
  text: string
  /** Refused only because the session was busy: worth retrying at turn end. */
  busy?: boolean
}

const fail = (text: string): StepResult => ({ ok: false, text })
const failBusy = (text: string): StepResult => ({ ok: false, text, busy: true })
const ok = (text: string): StepResult => ({ ok: true, text })

export async function setModel(args: string[], deps: ModelDeps = liveModelDeps): Promise<StepResult> {
  const configured = deps.configured()
  let list: ChoiceList
  try {
    list = readModelChoices(deps.choicesFile, configured)
  } catch (err) {
    return fail(`Nem váltottam: a választék olvashatatlan (${err instanceof Error ? err.message : String(err)}).`)
  }
  const parsed = parseModelArgs(args, list)
  if (typeof parsed === 'string') return fail(parsed)
  const { choice, effort, hold } = parsed
  if (choice && !isValidModelId(choice.id)) return fail(`Nem váltottam: érvénytelen modell-azonosító: ${choice.id}`)
  const now = deps.now()
  const verdict = deps.quiet(now)
  if (!verdict.quiet) return failBusy(`Nem váltottam: a session foglalt (${verdict.reason}).`)

  const lines: string[] = []
  let acked = false
  if (choice) {
    const out = await sendModel(choice.id, deps)
    if (out.rejected !== null) return fail(rejectedText(choice.id, out.rejected))
    acked = out.acked
    lines.push(acked
      ? `Átváltva: ${choice.name} = ${choice.id} (a Claude Code visszaigazolta)`
      : `/model ${choice.id} elküldve (a Claude Code visszaigazolását nem láttam)`)
  }
  if (effort) {
    await deps.send(`/effort ${effort}`)
    writeEffortSent(effortSentFileFor(deps.lastSentFile), effort, now)
    lines.push(`Effort: ${effort} elküldve (visszamérni nem tudjuk).`)
  }

  const baseEffort = deps.configuredEffort()
  if (hold === 'keep') {
    if (choice) deps.writeEnv({ MAIN_AGENT_MODEL: choice.id })
    clearHold(deps.holdFile)
    deps.scheduleExpiry(null)
    lines.push(choice
      ? 'TARTÓS: az app .env MAIN_AGENT_MODEL sora frissítve (respawn után is ez indul).'
      : 'A „keep” csak a modellre vonatkozik; az effortot a CLI újraindításkor elfelejti.')
  } else {
    const minutes = hold ?? choice?.defaultHoldMinutes ?? DEFAULT_HOLD_MINUTES
    const until = now + minutes * 60_000
    writeHold(deps.holdFile, {
      model: choice?.id ?? null, name: choice?.name ?? (effort as string), revert_to: choice ? configured : null,
      effort: effort ?? null, revert_effort: effort ? baseEffort : null,
      until, set_at: now, verify_pending: choice !== null, blocked_since: null, block_alert_at: null,
    })
    deps.scheduleExpiry(until)
    const back = [choice ? `modell: ${configured}` : null, effort ? (baseEffort ? `effort: ${baseEffort}` : 'effort: nincs beállított alapérték, kézzel állítsd vissza') : null]
      .filter(Boolean).join(' · ')
    lines.push(`Ideiglenes: ${formatSpan(minutes * 60)} (${formatDayClock(until)}-ig), utána vissza -- ${back}. A .env nem változott.`)
  }
  if (choice) lines.push('A következő kör modelljét is visszamérem; ha eltér, szólok.')
  const warn = choice ? windowWarning(choice.id, deps.autoCompactWindow()) : null
  if (warn) lines.push(warn)
  return ok(lines.join('\n'))
}

// ---- /model back --------------------------------------------------------------

export async function modelBack(deps: ModelDeps = liveModelDeps): Promise<StepResult> {
  const now = deps.now()
  const { state, error } = readHold(deps.holdFile)
  if (error) return fail(`Nem váltottam: a main-model-hold.json olvashatatlan (${error}).`)
  const base = state?.revert_to ?? deps.configured()
  const measured = deps.measured()
  if (!state && measured && !modelsDiffer(base, measured)) return ok(`Már az alapmodell fut: ${measured}.`)
  const verdict = deps.quiet(now)
  if (!verdict.quiet) {
    if (state) {
      writeHold(deps.holdFile, { ...state, until: now })
      return fail(`A session foglalt (${verdict.reason}); a tartás lejártra állítva, a sweep visszavált, amint csendes.`)
    }
    return failBusy(`Nem váltottam: a session foglalt (${verdict.reason}).`)
  }
  const lines: string[] = []
  // An effort-only hold has no model to put back.
  if (!state || state.model !== null) {
    const out = await sendModel(base, deps)
    if (out.rejected !== null) return fail(rejectedText(base, out.rejected))
    const acked = out.acked
    lines.push(`${acked ? `Visszaváltva: ${base} (a Claude Code visszaigazolta)` : `/model ${base} elküldve (vissza az alapmodellre; a visszaigazolást nem láttam)`}${state ? ', a tartás törölve' : ''}.`)
  }
  // /model default puts the effort back too, when there is a base to put back.
  if (state?.effort) {
    if (state.revert_effort) {
      await deps.send(`/effort ${state.revert_effort}`)
      writeEffortSent(effortSentFileFor(deps.lastSentFile), state.revert_effort, deps.now())
      lines.push(`Effort vissza: ${state.revert_effort} elküldve.`)
    } else {
      lines.push(`Az effort (${state.effort}) marad: nincs beállított alapérték, amire visszaállíthatnék.`)
    }
  }
  clearHold(deps.holdFile)
  deps.scheduleExpiry(null)
  return ok(lines.join('\n'))
}

// ---- /model effort ------------------------------------------------------------

export async function setEffort(level: string | undefined, deps: ModelDeps = liveModelDeps): Promise<StepResult> {
  const l = (level ?? '').toLowerCase()
  if (!(EFFORT_LEVELS as readonly string[]).includes(l)) return fail(`Használat: /model effort <${EFFORT_LEVELS.join('|')}>`)
  const verdict = deps.quiet(deps.now())
  if (!verdict.quiet) return failBusy(`Nem állítottam: a session foglalt (${verdict.reason}).`)
  await deps.send(`/effort ${l}`)
  writeEffortSent(effortSentFileFor(deps.lastSentFile), l, deps.now())
  return ok(`/effort ${l} elküldve. Az effortot visszamérni nem tudjuk (a transzkript nem hordozza).`)
}

// The last /effort sent, for the /model status: the CLI's effort is not in the
// transcript, so without this the status kept saying "nincs beállítva" right
// after a /model effort high (ELSOKOR922 Phase 7 A-smoke). A restart of the
// session resets the CLI's effort -- the reader drops a send older than the
// session.
export const EFFORT_SENT_FILE = join(STORE_DIR, 'main-effort-last-sent.json')

/** The configured effort for the session: env first, then .claude/settings.json. */
export function readConfiguredEffort(): { value: string; source: string } | null {
  if (process.env.CLAUDE_CODE_EFFORT_LEVEL) return { value: process.env.CLAUDE_CODE_EFFORT_LEVEL, source: 'env CLAUDE_CODE_EFFORT_LEVEL' }
  try {
    const s = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8'))
    if (typeof s?.effortLevel === 'string') return { value: s.effortLevel, source: '.claude/settings.json effortLevel' }
  } catch { /* no settings */ }
  return null
}

export function effortSentFileFor(lastSentFile: string): string {
  return join(dirname(lastSentFile), 'main-effort-last-sent.json')
}

export function readEffortSent(file: string, sessionStartMs: number | null): { level: string; at: number } | null {
  try {
    const p = JSON.parse(readFileSync(file, 'utf-8')) as { level?: unknown; at?: unknown }
    if (typeof p.level !== 'string' || typeof p.at !== 'number') return null
    if (sessionStartMs !== null && p.at < sessionStartMs) return null
    return { level: p.level, at: p.at }
  } catch { return null }
}

function writeEffortSent(file: string, level: string, at: number): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    atomicWriteFileSync(file, JSON.stringify({ level, at }) + '\n')
  } catch (err) {
    logger.warn({ err, file }, 'main-model: effort marker not written')
  }
}

// ---- the sweep (runs on the gate's main sweep) --------------------------------

export type SweepOutcome =
  | 'none' | 'corrupt' | 'verified' | 'mismatch' | 'waiting' | 'cleared-already-base'
  | 'blocked' | 'block-alerted' | 'reverted'

let corruptLogged = false

export async function sweepModelHold(nowMs: number, deps: ModelDeps = liveModelDeps): Promise<SweepOutcome> {
  const { state, error } = readHold(deps.holdFile)
  if (error) {
    // Corrupt hold: say so, do NOT switch anything (no guessing the base).
    if (!corruptLogged) {
      logger.warn({ file: deps.holdFile, error }, 'main-model: hold file unreadable, no revert (fix or delete the file)')
      corruptLogged = true
    }
    return 'corrupt'
  }
  corruptLogged = false
  if (!state) return 'none'

  let s = state
  let outcome: SweepOutcome = 'waiting'
  if (s.verify_pending && s.model) {
    const measured = deps.measured(Math.floor(s.set_at / 1000))
    if (measured) {
      s = { ...s, verify_pending: false }
      writeHold(deps.holdFile, s)
      if (modelsDiffer(s.model as string, measured)) {
        await deps.notify(`FIGYELEM: /model ${s.model} után a mért modell ${measured}. A tartás marad, lejáratkor visszaváltok: ${s.revert_to}.`)
        outcome = 'mismatch'
      } else {
        // The switch reply already carried the CLI's own acknowledgement; a
        // matching measurement is the expected case and is logged, not sent.
        logger.info({ model: measured }, 'main-model: hold verified by the next turn')
        outcome = 'verified'
      }
    }
  }
  if (nowMs < s.until) return outcome

  // Only a turn written AFTER the switch can prove a respawn put the base model
  // back. The newest line overall may predate the switch (no turn ran during
  // the hold) and then still names the base model -- ELSOKOR922 Phase 7
  // A-smoke: a 3-minute hold "expired, base already running", cleared without
  // sending anything, and opus stayed on.
  const measuredNow = s.revert_to ? deps.measured(Math.floor(s.set_at / 1000)) : null
  if (measuredNow && s.revert_to && !modelsDiffer(s.revert_to, measuredNow) && !s.effort) {
    // A respawn already brought the base model back: only forget the hold.
    clearHold(deps.holdFile)
    logger.info({ model: measuredNow }, 'main-model: hold expired, base model already running (respawn); state cleared')
    return 'cleared-already-base'
  }
  const verdict = deps.quiet(nowMs)
  if (!verdict.quiet) {
    const since = s.blocked_since ?? nowMs
    const alertDue = nowMs - since >= BLOCK_ALERT_MS && s.block_alert_at === null
    writeHold(deps.holdFile, { ...s, blocked_since: since, block_alert_at: alertDue ? nowMs : s.block_alert_at })
    if (alertDue) {
      await deps.notify(`A modell-tartás ${formatDayClock(s.until)}-kor lejárt, de a session ${Math.round((nowMs - since) / 60_000)} perce foglalt (${verdict.reason}); a visszaváltás (${s.revert_to}) vár. Mi fut: /runs`)
      return 'block-alerted'
    }
    return 'blocked'
  }
  const parts: string[] = []
  if (s.model && s.revert_to) {
    const acked = (await sendModel(s.revert_to, deps)).acked
    parts.push(acked
      ? `visszaváltva ${s.model} -> ${s.revert_to} (a Claude Code visszaigazolta)`
      : `/model ${s.revert_to} elküldve (${s.model} helyett); a visszaigazolást nem láttam, a következő kör mérése mutatja`)
  }
  if (s.effort) {
    if (s.revert_effort) {
      await deps.send(`/effort ${s.revert_effort}`)
      writeEffortSent(effortSentFileFor(deps.lastSentFile), s.revert_effort, deps.now())
      parts.push(`effort vissza: ${s.revert_effort}`)
    } else {
      parts.push(`az effort (${s.effort}) marad: nincs beállított alapérték, kézzel állítsd vissza`)
    }
  }
  clearHold(deps.holdFile)
  deps.scheduleExpiry(null)
  await deps.notify(`A tartás lejárt: ${parts.join(' · ')}.`)
  return 'reverted'
}

export function _resetMainModelForTest(): void {
  corruptLogged = false
}

// ---- registration (replaces the A1 "planned" entries by usage) ----------------

// A write refused only because the session was busy is queued, and run at the
// end of the turn (pending-write.ts). The owner asked for exactly this after
// a `/model sonnet keep` was lost to a pane-busy refusal.
export function withRetry(text: string, r: StepResult, ctx: { ownerId: number; now: number }, file: string = PENDING_WRITE_FILE): string {
  // The owner's latest word wins: a write that went through drops an older
  // one still queued for the turn end (measured on the test bot: a queued
  // "/model low 5m" outlived the "/model default" typed after it, and would
  // have fired minutes later).
  if (r.ok) {
    const stale = readPendingWrite(file)
    if (stale) {
      clearPendingWrite(file)
      logger.info({ dropped: stale.text, by: text }, 'pending-write: dropped, a later write ran')
      return `${r.text}\n(A sorban várakozó „${stale.text}” törölve: ez a parancs felülírta.)`
    }
    return r.text
  }
  if (!r.busy) return r.text
  queuePendingWrite(text, ctx.ownerId, ctx.now, file)
  return `${r.text} A kör végén megpróbálom, és szólok az eredményről (legfeljebb ${Math.round(PENDING_WRITE_TTL_MS / 60_000)} percig).`
}

export function registerModelWriteCommands(): void {
  registerCommand({
    name: 'model', kind: 'write', usage: `/model [<választás>] [<${EFFORT_LEVELS.join('|')}>] [<idő>|keep]`,
    description: 'modell és/vagy effort; alapból 2 óra, majd vissza; keep = tartós (.env)',
    matches: args => args.length > 0 && !['back', 'default'].includes(args[0].toLowerCase()),
    run: async (ctx, args) => ctx.reply(withRetry(`/model ${args.join(' ')}`, await setModel(args), ctx)),
  })
  registerCommand({
    name: 'model', kind: 'write', usage: '/model default', description: 'azonnal vissza az alapmodellre (és az alap effortra)',
    matches: args => ['back', 'default'].includes(args[0]?.toLowerCase() ?? ''),
    run: async ctx => ctx.reply(withRetry('/model default', await modelBack(), ctx)),
  })
}
