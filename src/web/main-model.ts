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
  model: string
  name: string
  revert_to: string
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
    if (typeof p.model !== 'string' || typeof p.revert_to !== 'string' || typeof p.until !== 'number' || !Number.isFinite(p.until)) {
      return { state: null, error: 'hiányzó vagy hibás mező (model / revert_to / until)' }
    }
    return {
      state: {
        model: p.model,
        name: typeof p.name === 'string' ? p.name : p.model,
        revert_to: p.revert_to,
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
  /** Count of "Set model to" lines in the visible pane; null = not capturable. */
  ackCount: () => number | null
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
  ackCount: () => countModelAcks(capturePane(mainSessionName())),
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  scheduleExpiry: (untilMs) => scheduleHoldExpiry(untilMs),
}

// Send a /model and wait (bounded) for the CLI's acknowledgement. Records the
// send so a status can say "switched since the last measured turn".
async function sendModel(modelId: string, deps: ModelDeps): Promise<boolean> {
  const before = deps.ackCount()
  await deps.send(`/model ${modelId}`)
  const sentAt = deps.now()
  let acked = false
  if (before !== null) {
    for (let waited = 0; waited < ACK_WAIT_MS && !acked; waited += ACK_STEP_MS) {
      await deps.sleep(ACK_STEP_MS)
      const after = deps.ackCount()
      acked = after !== null && after > before
    }
  }
  writeLastSent(deps.lastSentFile, modelId, sentAt, acked)
  return acked
}

// A hold that expired while the session was busy: the Stop hook reports the
// end of every main-session turn (marveen-commands.py --stop -> POST
// /api/commands/turn-ended). The revert then gets ONE retry, once the turn has
// been quiet for the switch window -- an event, not a poll; the 5-minute sweep
// stays the fallback.
export function onMainTurnEnded(nowMs: number, holdFile: string = MODEL_HOLD_FILE): boolean {
  const { state } = readHold(holdFile)
  if (!state || nowMs < state.until) return false
  scheduleHoldExpiry(nowMs + SWITCH_TURN_QUIET_MS, nowMs)
  return true
}

// ---- /model [set] -------------------------------------------------------------

export interface StepResult {
  ok: boolean
  text: string
}

const fail = (text: string): StepResult => ({ ok: false, text })
const ok = (text: string): StepResult => ({ ok: true, text })

export async function setModel(args: string[], deps: ModelDeps = liveModelDeps): Promise<StepResult> {
  const a = args[0]?.toLowerCase() === 'set' ? args.slice(1) : args
  if (a.length === 0 || a.length > 2) return fail('Használat: /model [set] <választás> [<idő>|keep], pl. /model opus, /model opus 30m, /model opus keep')
  const configured = deps.configured()
  let list: ChoiceList
  try {
    list = readModelChoices(deps.choicesFile, configured)
  } catch (err) {
    return fail(`Nem váltottam: a választék olvashatatlan (${err instanceof Error ? err.message : String(err)}).`)
  }
  const choice = resolveChoice(a[0], list)
  if (!choice) {
    const names = list.choices.map(c => c.name).join(', ')
    return fail(`Nem váltottam: „${a[0]}” nincs a választékban. Választható: ${names}${list.fromFile ? '' : ' (a store/model-choices.json hiányzik, csak a konfigurált modell)'}.`)
  }
  if (!isValidModelId(choice.id)) return fail(`Nem váltottam: érvénytelen modell-azonosító: ${choice.id}`)
  const hold = parseHold(a[1])
  if (hold === null) return fail(`Nem értem az időt: „${a[1]}”. Példa: 4h, 30m, keep.`)
  const now = deps.now()
  const verdict = deps.quiet(now)
  if (!verdict.quiet) return fail(`Nem váltottam: a session foglalt (${verdict.reason}). Mi fut: /runs`)

  const acked = await sendModel(choice.id, deps)
  const head = acked
    ? `Átváltva: ${choice.name} = ${choice.id} (a Claude Code visszaigazolta)`
    : `/model ${choice.id} elküldve (a Claude Code visszaigazolását nem láttam)`
  const warn = windowWarning(choice.id, deps.autoCompactWindow())
  const lines: string[] = []
  if (hold === 'keep') {
    deps.writeEnv({ MAIN_AGENT_MODEL: choice.id })
    clearHold(deps.holdFile)
    deps.scheduleExpiry(null)
    lines.push(`${head}, TARTÓS: az app .env MAIN_AGENT_MODEL sora frissítve (respawn után is ez indul).`)
  } else {
    const minutes = hold ?? choice.defaultHoldMinutes
    const until = now + minutes * 60_000
    writeHold(deps.holdFile, {
      model: choice.id, name: choice.name, revert_to: configured, until, set_at: now,
      verify_pending: true, blocked_since: null, block_alert_at: null,
    })
    deps.scheduleExpiry(until)
    lines.push(`${head}, ideiglenes: ${formatSpan(minutes * 60)} (${formatDayClock(until)}-ig), utána vissza: ${configured}. A .env nem változott.`)
  }
  lines.push('A következő kör modelljét is visszamérem; ha eltér, szólok.')
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
    return fail(`Nem váltottam: a session foglalt (${verdict.reason}). Mi fut: /runs`)
  }
  const acked = await sendModel(base, deps)
  clearHold(deps.holdFile)
  deps.scheduleExpiry(null)
  return ok(`${acked ? `Visszaváltva: ${base} (a Claude Code visszaigazolta)` : `/model ${base} elküldve (vissza az alapmodellre; a visszaigazolást nem láttam)`}${state ? ', a tartás törölve' : ''}.`)
}

// ---- /model effort ------------------------------------------------------------

export async function setEffort(level: string | undefined, deps: ModelDeps = liveModelDeps): Promise<StepResult> {
  const l = (level ?? '').toLowerCase()
  if (!(EFFORT_LEVELS as readonly string[]).includes(l)) return fail(`Használat: /model effort <${EFFORT_LEVELS.join('|')}>`)
  const verdict = deps.quiet(deps.now())
  if (!verdict.quiet) return fail(`Nem állítottam: a session foglalt (${verdict.reason}). Mi fut: /runs`)
  await deps.send(`/effort ${l}`)
  return ok(`/effort ${l} elküldve. Az effortot visszamérni nem tudjuk (a transzkript nem hordozza).`)
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
  if (s.verify_pending) {
    const measured = deps.measured(Math.floor(s.set_at / 1000))
    if (measured) {
      s = { ...s, verify_pending: false }
      writeHold(deps.holdFile, s)
      if (modelsDiffer(s.model, measured)) {
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
  const measuredNow = deps.measured(Math.floor(s.set_at / 1000))
  if (measuredNow && !modelsDiffer(s.revert_to, measuredNow)) {
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
  const acked = await sendModel(s.revert_to, deps)
  clearHold(deps.holdFile)
  deps.scheduleExpiry(null)
  await deps.notify(acked
    ? `A modell-tartás lejárt: visszaváltva ${s.model} -> ${s.revert_to} (a Claude Code visszaigazolta).`
    : `A modell-tartás lejárt: /model ${s.revert_to} elküldve (${s.model} helyett); a visszaigazolást nem láttam, a következő kör mérése mutatja.`)
  return 'reverted'
}

export function _resetMainModelForTest(): void {
  corruptLogged = false
}

// ---- registration (replaces the A1 "planned" entries by usage) ----------------

export function registerModelWriteCommands(): void {
  registerCommand({
    name: 'model', kind: 'write', usage: '/model [set] <választás> [<idő>|keep]',
    description: 'váltás; alapból 2 óra, majd vissza; keep = tartós (.env)',
    matches: args => args.length > 0 && !['back', 'effort'].includes(args[0].toLowerCase()),
    run: async (ctx, args) => ctx.reply((await setModel(args)).text),
  })
  registerCommand({
    name: 'model', kind: 'write', usage: '/model back', description: 'azonnal vissza az alapmodellre',
    matches: args => args[0]?.toLowerCase() === 'back',
    run: async ctx => ctx.reply((await modelBack()).text),
  })
  registerCommand({
    name: 'model', kind: 'write', usage: '/model effort <low|medium|high|xhigh|max>', description: 'effort beállítása',
    matches: args => args[0]?.toLowerCase() === 'effort',
    run: async (ctx, args) => ctx.reply((await setEffort(args[1])).text),
  })
}
