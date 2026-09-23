// The owner's own slash commands (CMD920 3.12, ELSOKOR922 spec 5. and D-4).
//
// Two kinds:
//   - actions: steps from a CLOSED action set (model, effort, context clear,
//     message, interrupt, task). The definition is data, the action is code: a new action
//     needs a PR.
//   - prompt: a text template sent into the main session. It goes in through
//     the existing channel-inbound path (agent_messages from the channel
//     coordinator id, drained by the main agent's inbox hook), i.e. framed
//     exactly like an owner message on the channel: no more rights than the
//     owner typing it. Wrapper markers are filtered and the length is capped.
//
// Threat model (honest): there is no hard guarantee inside the container --
// the agent can read the dashboard token and the DB. The defence is against a
// prompt-injected sentence persisted as a definition: (1) the CRUD route
// refuses agent-identified writes; (2) running a prompt command shows
// updated_by / updated_at / the text start; (3) a definition changed since the
// owner last ran it is NOT sent: the bot asks once, and only a repeat within
// the confirm window sends it.
//
// Invalid definitions (unknown action, bad parameter, builtin name clash) are
// found at LOAD time and listed by /commands with the reason, never at call
// time. Builtin names win.

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { logger } from '../logger.js'
import { STORE_DIR, MAIN_AGENT_ID } from '../config.js'
import {
  listCustomCommands,
  countCustomCommands,
  insertCustomCommand,
  markCustomCommandRun,
  getCustomCommand,
  createAgentMessage,
  type CustomCommandRow,
} from '../db.js'
import { COORDINATOR_AGENT_ID } from '../channel-coordinator/ingest.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  registerCommand,
  unregisterCommand,
  listCommands,
  setInvalidCustomCommands,
  type CommandContext,
  type InvalidCustomCommand,
} from './commands.js'
import { setModel, setEffort, withRetry, EFFORT_LEVELS, type StepResult } from './main-model.js'
import { contextClear } from './session-control.js'
import { mainSessionName, sendInterrupt } from './context-restart-gate-runner.js'
import { capturePane } from './agent-process.js'
import { runScheduledTaskNow } from './schedule-runner.js'

// Claude Code's footer while a turn runs.
const PANE_BUSY_MARK = 'esc to interrupt'
import { formatDayClock } from './system-status.js'

export const COMMANDS_JSON = join(STORE_DIR, 'commands.json')
export const PROMPT_MAX_CHARS = 2000
export const MESSAGE_MAX_CHARS = 500
export const MAX_STEPS = 10
export const CONFIRM_WINDOW_MS = 120_000
export const ACTIONS = ['model', 'effort', 'context clear', 'message', 'interrupt', 'task'] as const
export type ActionName = typeof ACTIONS[number]

const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/

export interface ActionStep {
  action: ActionName
  /** model: choice name; effort: level; message: text; task: scheduled task name. */
  value?: string
  /** model only: '4h' | '30m' | 'keep'. */
  hold?: string
}

export interface CommandDefinition {
  name: string
  description: string
  kind: 'actions' | 'prompt'
  /** actions: ActionStep[]; prompt: the template text. */
  body: ActionStep[] | string
  enabled: boolean
}

// The shipped defaults (CMD920 3.12): /new and /clear as /context clear aliases.
export const DEFAULT_COMMANDS: CommandDefinition[] = [
  { name: 'new', description: 'a /context clear aliasa', kind: 'actions', body: [{ action: 'context clear' }], enabled: true },
  { name: 'clear', description: 'a /context clear aliasa', kind: 'actions', body: [{ action: 'context clear' }], enabled: true },
]

export type Validation = { ok: true; def: CommandDefinition } | { ok: false; reason: string }

// Pure: validate an untrusted definition. `builtinNames` are the registered
// builtin command names; a clash is invalid (the builtin wins).
export function validateDefinition(raw: unknown, builtinNames: ReadonlySet<string>): Validation {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'a definíció nem objektum' }
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim().toLowerCase() : ''
  if (!NAME_RE.test(name)) return { ok: false, reason: 'érvénytelen név (a-z, 0-9, _; betűvel kezdődik; max 32)' }
  if (builtinNames.has(name)) return { ok: false, reason: 'beépített parancs neve; a beépített nyer' }
  const description = typeof r.description === 'string' ? r.description.trim().slice(0, 200) : ''
  const enabled = r.enabled === undefined ? true : r.enabled === true || r.enabled === 1
  if (r.kind === 'prompt') {
    if (typeof r.body !== 'string' || !r.body.trim()) return { ok: false, reason: 'prompt: üres szöveg' }
    if (r.body.length > PROMPT_MAX_CHARS) return { ok: false, reason: `prompt: ${r.body.length} karakter, a korlát ${PROMPT_MAX_CHARS}` }
    return { ok: true, def: { name, description, kind: 'prompt', body: r.body, enabled } }
  }
  if (r.kind === 'actions') {
    if (!Array.isArray(r.body) || r.body.length === 0) return { ok: false, reason: 'actions: üres lépéslista' }
    if (r.body.length > MAX_STEPS) return { ok: false, reason: `actions: legfeljebb ${MAX_STEPS} lépés` }
    const steps: ActionStep[] = []
    for (const [i, st] of r.body.entries()) {
      const s = st as Record<string, unknown>
      const action = typeof s?.action === 'string' ? s.action.trim().toLowerCase() : ''
      if (!(ACTIONS as readonly string[]).includes(action)) return { ok: false, reason: `${i + 1}. lépés: ismeretlen akció: ${String(s?.action)}` }
      const value = typeof s.value === 'string' ? s.value.trim() : undefined
      if (action === 'model' && !value) return { ok: false, reason: `${i + 1}. lépés: model: hiányzik a value (választás neve)` }
      if (action === 'model' && s.hold !== undefined && (typeof s.hold !== 'string' || !/^(keep|\d{1,4}[hm]?)$/i.test(s.hold))) {
        return { ok: false, reason: `${i + 1}. lépés: model: érvénytelen hold` }
      }
      if (action === 'effort' && !(EFFORT_LEVELS as readonly string[]).includes(value ?? '')) {
        return { ok: false, reason: `${i + 1}. lépés: effort: value csak ${EFFORT_LEVELS.join('|')} lehet` }
      }
      if (action === 'task' && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value ?? '')) {
        return { ok: false, reason: `${i + 1}. lépés: task: value egy ütemezett feladat neve (a-z, 0-9, -, _)` }
      }
      if (action === 'message' && (!value || value.length > MESSAGE_MAX_CHARS)) {
        return { ok: false, reason: `${i + 1}. lépés: message: 1-${MESSAGE_MAX_CHARS} karakter kell` }
      }
      steps.push({ action: action as ActionName, value, hold: typeof s.hold === 'string' ? s.hold : undefined })
    }
    return { ok: true, def: { name, description, kind: 'actions', body: steps, enabled } }
  }
  return { ok: false, reason: `ismeretlen kind: ${String(r.kind)} (actions | prompt)` }
}

export function rowToRaw(row: CustomCommandRow): Record<string, unknown> {
  let body: unknown = row.body
  if (row.kind === 'actions') {
    try { body = JSON.parse(row.body) } catch { body = null }
  }
  return { name: row.name, description: row.description, kind: row.kind, body, enabled: row.enabled === 1 }
}

export function definitionBody(def: CommandDefinition): string {
  return typeof def.body === 'string' ? def.body : JSON.stringify(def.body)
}

// ---- prompt sanitation --------------------------------------------------------

// Wrapper markers a prompt must not carry: a forged <scheduled-task> or
// system-reminder would claim a provenance the owner's text does not have.
const WRAPPER_TAG_RX = /<\s*\/?\s*(channel|scheduled-task|trusted-peer|untrusted|system-reminder|task-notification|command-name|local-command-stdout)\b[^>]*>/gi
const WRAPPER_PREFIX_RX = /^\s*\[(Uzenet @|Uzenet a tavoli @|Üzenet @|SYSTEM-DIREKTIVA)/gim

export function sanitizePromptText(text: string): string {
  return text.replace(WRAPPER_TAG_RX, '[stripped-tag]').replace(WRAPPER_PREFIX_RX, '(stripped-prefix: ')
}

export function renderPrompt(template: string, args: string[]): string {
  const joined = args.join(' ')
  return template.replace(/\$ARGUMENTS|\{\{\s*args\s*\}\}/g, () => joined)
}

// The channel-inbound envelope, like the coordinator's buildHandoffContent: the
// attributes are ours (routing data), only the body is the owner's text.
export function buildOwnerCommandInbound(body: string, ownerId: number, command: string, nowMs: number): string {
  const attrs = [
    'source="owner-command"',
    `chat_id="${ownerId}"`,
    `user_id="${ownerId}"`,
    `ts="${new Date(nowMs).toISOString()}"`,
    'kind="custom-command"',
    `command="/${command}"`,
  ].join(' ')
  return `<channel ${attrs}>\n${body}\n</channel>`
}

// ---- running a command -----------------------------------------------------------

export interface RunDeps {
  model: (args: string[]) => Promise<StepResult>
  effort: (level: string) => Promise<StepResult>
  clear: (nowMs: number) => Promise<StepResult>
  interrupt: () => Promise<StepResult>
  task: (name: string) => Promise<StepResult>
  sendPrompt: (content: string) => number
  getRow: (name: string) => CustomCommandRow | undefined
  markRun: (name: string, runAt: number, definitionAt: number) => void
}

// Escape only when a turn is running: on an idle pane it would clear a
// half-typed input line instead. An unreadable pane is reported, not guessed.
export async function interruptStep(pane: string | null, send: () => Promise<void>): Promise<StepResult> {
  if (pane === null) return { ok: false, text: 'a fő session paneljét nem tudtam kiolvasni, nem küldtem Esc-et' }
  if (!pane.includes(PANE_BUSY_MARK)) return { ok: true, text: 'nem futott kör, nincs mit megszakítani' }
  await send()
  return { ok: true, text: 'Esc elküldve, a futó kör megáll' }
}

// runScheduledTaskNow already queues a busy session's run (the scheduler's
// pending retry), so a busy result is NOT a failure and needs no withRetry.
// Measured on the test bot: /napindito as a prompt made the model trigger the
// run from inside its own turn, got "busy", and told the owner it had not
// started -- while the queued run fired 19 s later.
export function taskStepText(name: string, r: { ok: boolean; result?: string; error?: string }): StepResult {
  if (!r.ok) return { ok: false, text: `a(z) ${name} nem indult: ${r.error ?? 'ismeretlen hiba'}` }
  const parts = (r.result ?? '').split(', ').filter(Boolean).map(p => {
    const [agent, how] = p.split(': ')
    if (how === 'fired') return `${agent}: elindult`
    if (how === 'busy' || how === 'starting' || how === 'first-run') return `${agent}: foglalt, sorba állt, amint szabad, lefut`
    return `${agent}: ${how ?? p}`
  })
  return { ok: true, text: `${name} ${parts.join('; ')}. Az eredményt a feladat maga küldi.` }
}

export const liveRunDeps: RunDeps = {
  model: (args) => setModel(args),
  effort: (level) => setEffort(level),
  clear: async (nowMs) => {
    const r = await contextClear(nowMs)
    return { ok: r.cleared, text: r.text, busy: r.busy }
  },
  task: async (name) => taskStepText(name, await runScheduledTaskNow(name)),
  interrupt: () => interruptStep(capturePane(mainSessionName()), () => sendInterrupt(mainSessionName())),
  sendPrompt: (content) => createAgentMessage(COORDINATOR_AGENT_ID, MAIN_AGENT_ID, content, 'owner custom command').id,
  getRow: getCustomCommand,
  markRun: markCustomCommandRun,
}

/**
 * The text to reply plus `busy` = a step was refused only because the session
 * was busy. Without this the whole custom command reported plain "HIBA" and was
 * lost, while the same write typed as `/model ...` was queued for the end of the
 * turn (measured on the test bot: `/gyors` ran from the queue twice and switched
 * nothing, ELSOKOR922 Phase 7).
 */
export interface ActionsResult {
  text: string
  busy: boolean
}

// Actions run in order; the first failing step stops the rest, and the reply
// says how far it got.
export async function runActions(steps: ActionStep[], nowMs: number, deps: RunDeps): Promise<ActionsResult> {
  const lines: string[] = []
  for (const [i, st] of steps.entries()) {
    let r: StepResult
    try {
      // The value may carry the whole /model line ("opus low 4m"), matching the
      // command the owner types; `hold` stays supported as its own field.
      if (st.action === 'model') r = await deps.model([...(st.value ?? '').trim().split(/\s+/).filter(Boolean), ...(st.hold ? [st.hold] : [])])
      else if (st.action === 'effort') r = await deps.effort(st.value ?? '')
      else if (st.action === 'context clear') r = await deps.clear(nowMs)
      else if (st.action === 'interrupt') r = await deps.interrupt()
      else if (st.action === 'task') r = await deps.task(st.value ?? '')
      else r = { ok: true, text: st.value ?? '' }
    } catch (err) {
      r = { ok: false, text: err instanceof Error ? err.message : String(err) }
    }
    lines.push(`${i + 1}. ${st.action}${st.value ? ` ${st.value}` : ''}: ${r.ok ? 'kész' : 'HIBA'} — ${r.text}`)
    if (!r.ok) {
      lines.push(`Megállt a ${i + 1}. lépésnél (${i}/${steps.length} kész).`)
      return { text: lines.join('\n'), busy: r.busy === true }
    }
  }
  // A command made only of messages is a canned reply: send just its text,
  // not the step report (measured on the test bot: /dashboard answered
  // "1. message X: kész — X / Mind a 1 lépés kész.").
  if (steps.every(st => st.action === 'message')) return { text: steps.map(st => st.value ?? '').join('\n'), busy: false }
  lines.push(`Mind a ${steps.length} lépés kész.`)
  return { text: lines.join('\n'), busy: false }
}

// name -> { definitionAt, expiresAt }: the one-time "changed, send anyway?" ask.
const pendingConfirm = new Map<string, { definitionAt: number; expiresAt: number }>()

export function _resetCustomCommandsForTest(): void {
  pendingConfirm.clear()
}

export async function runPrompt(
  name: string, args: string[], ctx: CommandContext, deps: RunDeps,
): Promise<string> {
  const row = deps.getRow(name)
  if (!row) return `A /${name} közben törlődött.`
  const now = ctx.now
  const changed = row.last_run_definition_at === null || row.updated_at > row.last_run_definition_at
  const head = `/${name} · módosította: ${row.updated_by} · ${formatDayClock(row.updated_at)}`
  const preview = row.body.replace(/\s+/g, ' ').trim().slice(0, 160)
  if (changed) {
    const p = pendingConfirm.get(name)
    if (!p || p.definitionAt !== row.updated_at || p.expiresAt < now) {
      pendingConfirm.set(name, { definitionAt: row.updated_at, expiresAt: now + CONFIRM_WINDOW_MS })
      const why = row.last_run_definition_at === null ? 'még nem futtattad' : `a legutóbbi futtatásod óta változott (${formatDayClock(row.updated_at)})`
      return `NEM küldtem be: a /${name} definíciója ${why}.\n${head}\nSzöveg eleje: „${preview}”\nHa így küldjem, add ki újra ${CONFIRM_WINDOW_MS / 1000} másodpercen belül.`
    }
    pendingConfirm.delete(name)
  }
  const text = sanitizePromptText(renderPrompt(row.body, args))
  if (text.length > PROMPT_MAX_CHARS * 2) return `NEM küldtem be: a kész szöveg ${text.length} karakter, a korlát ${PROMPT_MAX_CHARS * 2}.`
  const msgId = deps.sendPrompt(buildOwnerCommandInbound(text, ctx.ownerId, name, now))
  deps.markRun(name, now, row.updated_at)
  return `Beküldve a fő ágensnek (üzenet #${msgId}, csatorna-bejövő borítékkal; a fő csatornán válaszol).\n${head}\nSzöveg eleje: „${text.replace(/\s+/g, ' ').trim().slice(0, 160)}”`
}

// ---- load / import / export -----------------------------------------------------

export function touchesOfSteps(def: CommandDefinition): Array<'model' | 'context'> {
  if (def.kind !== 'actions') return []
  const out = new Set<'model' | 'context'>()
  for (const st of def.body as ActionStep[]) {
    if (st.action === 'model' || st.action === 'effort') out.add('model')
    if (st.action === 'context clear') out.add('context')
  }
  return [...out]
}

let registeredCustom: string[] = []

function builtinNames(): Set<string> {
  return new Set(listCommands().filter(e => e.source !== 'custom').map(e => e.name))
}

// (Re)load every definition from the DB into the command registry. Invalid
// ones are listed (with the reason) for /commands and logged.
export function loadCustomCommands(deps: RunDeps = liveRunDeps, rows: CustomCommandRow[] = listCustomCommands()): { loaded: string[]; invalid: InvalidCustomCommand[] } {
  for (const u of registeredCustom) unregisterCommand(u)
  registeredCustom = []
  const builtins = builtinNames()
  const invalid: InvalidCustomCommand[] = []
  const loaded: string[] = []
  for (const row of rows) {
    const v = validateDefinition(rowToRaw(row), builtins)
    if (!v.ok) {
      invalid.push({ name: row.name, reason: v.reason })
      continue
    }
    if (!v.def.enabled) continue
    const def = v.def
    const usage = `/${def.name}`
    registerCommand({
      name: def.name,
      kind: 'write',
      source: 'custom',
      usage,
      touches: touchesOfSteps(def),
      description: `${def.description || '(nincs leírás)'} [${def.kind}]`,
      run: async (ctx, args) => {
        if (def.kind === 'actions') {
          const r = await runActions(def.body as ActionStep[], ctx.now, deps)
          // A busy step queues the WHOLE command for the end of the turn, the
          // same way a typed `/model ...` is queued -- rerunning it from the
          // start is right here: the steps are the owner's own definition.
          await ctx.reply(withRetry(usage, { ok: !r.busy, text: r.text, busy: r.busy }, ctx))
        }
        else await ctx.reply(await runPrompt(def.name, args, ctx, deps))
      },
    })
    registeredCustom.push(usage)
    loaded.push(def.name)
  }
  setInvalidCustomCommands(invalid)
  if (invalid.length) logger.warn({ invalid }, 'custom-commands: invalid definitions skipped (listed by /commands)')
  return { loaded, invalid }
}

export interface ImportResult {
  imported: number
  skipped: InvalidCustomCommand[]
  source: 'commands.json' | 'defaults' | 'none'
}

// Import into an EMPTY table only (never merges over edited rows). Missing
// file on an empty table -> the shipped defaults (/new, /clear).
export function importIfEmpty(file: string = COMMANDS_JSON): ImportResult {
  if (countCustomCommands() > 0) return { imported: 0, skipped: [], source: 'none' }
  let defs: unknown[]
  let source: ImportResult['source']
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { commands?: unknown }
    if (!parsed || !Array.isArray(parsed.commands)) throw new Error('commands.json: { "commands": [...] } alak kell')
    defs = parsed.commands
    source = 'commands.json'
  } else {
    defs = DEFAULT_COMMANDS
    source = 'defaults'
  }
  return { ...importDefinitions(defs, source === 'commands.json' ? 'import:commands.json' : 'shipped-default'), source }
}

export function importDefinitions(defs: unknown[], updatedBy: string): { imported: number; skipped: InvalidCustomCommand[] } {
  const builtins = builtinNames()
  const skipped: InvalidCustomCommand[] = []
  let imported = 0
  for (const raw of defs) {
    const v = validateDefinition(raw, builtins)
    const name = (raw as { name?: unknown })?.name
    if (!v.ok) {
      skipped.push({ name: typeof name === 'string' ? name : '?', reason: v.reason })
      continue
    }
    if (getCustomCommand(v.def.name)) {
      skipped.push({ name: v.def.name, reason: 'már létezik' })
      continue
    }
    insertCustomCommand({ name: v.def.name, description: v.def.description, kind: v.def.kind, body: definitionBody(v.def), enabled: v.def.enabled, updatedBy })
    imported++
  }
  return { imported, skipped }
}

export function exportDefinitions(): { commands: Array<Record<string, unknown>> } {
  return { commands: listCustomCommands().map(rowToRaw) }
}

export function writeExport(file: string = COMMANDS_JSON): void {
  mkdirSync(dirname(file), { recursive: true })
  atomicWriteFileSync(file, JSON.stringify(exportDefinitions(), null, 2) + '\n')
}

// Startup: import into an empty table, then load. Never throws: a broken
// commands.json is logged and the table stays empty (the builtins still work).
export function initCustomCommands(): void {
  try {
    const r = importIfEmpty()
    if (r.imported || r.skipped.length) logger.info({ source: r.source, imported: r.imported, skipped: r.skipped }, 'custom-commands: imported into the empty table')
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'custom-commands: import failed, table left as is')
  }
  try {
    loadCustomCommands()
  } catch (err) {
    logger.warn({ err }, 'custom-commands: load failed')
  }
}
