// Command registry for the owner's slash commands (CMD920, ELSOKOR922 D-4).
//
// Every command the main session's command hook answers without a model turn
// (scripts/hooks/marveen-commands.py -> POST /api/commands/dispatch) is
// registered here with a
// description and a `kind` (read | write). `/help` and the Telegram command
// menu (`setMyCommands`) are GENERATED from this registry, so a new command
// cannot silently miss the help text.
//
// One command name can carry several entries: a read entry (the fallback, no
// `matches`) plus write / planned entries that claim specific argument shapes
// (`matches(args)`). Dispatch tries the entries with a matcher first, in
// registration order, then the fallback. A planned entry (not implemented in
// this release) answers "planned" instead of running anything -- so e.g.
// `/runs stop <nonce>` never falls through to the read-only `/runs`.
//
// Registering an entry with the same `usage` as an existing one REPLACES it:
// that is how a later release turns a planned entry into a real one without
// touching this file's builtin list.

export type CommandKind = 'read' | 'write'

export interface CommandContext {
  reply(text: string): Promise<void>
  ownerId: number
  now: number
}

export interface CommandSpec {
  /** Top-level command name without the slash, lowercase (e.g. `runs`). */
  name: string
  kind: CommandKind
  description: string
  /** Help-line syntax; defaults to `/<name>`. Also the replace key. */
  usage?: string
  /** Not implemented yet: listed in /help as planned, answers "planned". */
  planned?: boolean
  /** Write that needs a one-time nonce (only planned in this release). */
  confirm?: boolean
  /** `custom` = owner-defined command (listed under SAJÁT). */
  source?: 'builtin' | 'custom'
  /** Detailed help with examples, shown for `/<name> ?`; without it the registry lines are shown. */
  help?: () => string
  /** What a write changes. A write that runs drops a queued write touching the same thing. */
  touches?: Array<'model' | 'context'>
  /** Claims specific argument shapes; an entry without it is the fallback. */
  matches?: (args: string[]) => boolean
  run?: (ctx: CommandContext, args: string[]) => Promise<void> | void
}

const entries: CommandSpec[] = []

function usageOf(spec: CommandSpec): string {
  return spec.usage ?? `/${spec.name}`
}

const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/

export function registerCommand(spec: CommandSpec): void {
  if (!NAME_RE.test(spec.name)) throw new Error(`invalid command name: ${spec.name}`)
  if (!spec.planned && typeof spec.run !== 'function') {
    throw new Error(`command ${usageOf(spec)} has no run() and is not planned`)
  }
  const key = usageOf(spec)
  const idx = entries.findIndex(e => usageOf(e) === key)
  if (idx >= 0) entries[idx] = spec
  else entries.push(spec)
}

export function unregisterCommand(usage: string): boolean {
  const idx = entries.findIndex(e => usageOf(e) === usage)
  if (idx < 0) return false
  entries.splice(idx, 1)
  return true
}

/** Test helper: drop every registered entry. */
export function clearCommandsForTest(): void {
  entries.length = 0
  invalidCustom = []
}

export function listCommands(): readonly CommandSpec[] {
  return entries
}

// Owner-defined commands whose definition failed validation at load time.
// /commands lists them with the reason (CMD920 3.12: an invalid definition
// shows up at load, not at call time). The loader (a later release) sets it.
export interface InvalidCustomCommand {
  name: string
  reason: string
}

let invalidCustom: InvalidCustomCommand[] = []

export function setInvalidCustomCommands(list: InvalidCustomCommand[]): void {
  invalidCustom = [...list]
}

export function listInvalidCustomCommands(): readonly InvalidCustomCommand[] {
  return invalidCustom
}

export function hasCommand(name: string): boolean {
  return entries.some(e => e.name === name)
}

export interface ParsedCommand {
  name: string
  args: string[]
  raw: string
}

// `/Name@SomeBot arg1  arg2` -> { name: 'name', args: ['arg1', 'arg2'] }.
// Returns null for anything that is not a slash command.
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const parts = trimmed.split(/\s+/)
  const head = parts[0].slice(1).split('@')[0].toLowerCase()
  if (!head) return null
  return { name: head, args: parts.slice(1), raw: trimmed }
}

// Pick the entry that should handle `args` for command `name`.
export function resolveCommand(name: string, args: string[]): CommandSpec | null {
  const forName = entries.filter(e => e.name === name)
  for (const e of forName) {
    if (e.matches && e.matches(args)) return e
  }
  return forName.find(e => !e.matches) ?? null
}

// `/<name> ?` (owner request 2026-09-24): every command explains itself. A
// command with its own help() shows that (options, examples); any other one
// its registry lines -- so a new command never lacks a `?` answer.
// A "?" anywhere asks for the help: "/board w ?" must not filter for an
// assignee called "?", nor "/model opus ?" switch to a model called "?".
export function isHelpRequest(args: string[]): boolean {
  return args.includes('?')
}

export function commandHelpText(name: string): string | null {
  const forName = entries.filter(e => e.name === name)
  if (forName.length === 0) return null
  const own = forName.find(e => e.help)
  if (own?.help) return own.help()
  const out = [`/${name}`]
  for (const e of forName) out.push(helpLine(e))
  if (forName[0].source === 'custom') out.push('', 'Saját parancs; a definíciója a dashboardon szerkeszthető.')
  return out.join('\n')
}

export type DispatchOutcome = 'ran' | 'planned' | 'unknown' | 'not-command' | 'error'

export async function dispatchCommand(text: string, ctx: CommandContext): Promise<DispatchOutcome> {
  const parsed = parseCommand(text)
  if (!parsed) return 'not-command'
  if (isHelpRequest(parsed.args)) {
    const h = commandHelpText(parsed.name)
    if (h !== null) {
      await ctx.reply(h)
      return 'ran'
    }
  }
  const spec = resolveCommand(parsed.name, parsed.args)
  if (!spec) {
    await ctx.reply(`Ismeretlen parancs: /${parsed.name}. Nem futtattam semmit. Lásd /help.`)
    return 'unknown'
  }
  if (spec.planned || !spec.run) {
    await ctx.reply(`Tervezett, még nem elérhető: ${usageOf(spec)}\nNem futtattam semmit. Lásd /help.`)
    return 'planned'
  }
  try {
    await spec.run(ctx, parsed.args)
    return 'ran'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`Hiba a(z) /${parsed.name} futtatásakor: ${msg}`)
    return 'error'
  }
}

function helpLine(e: CommandSpec): string {
  return `${usageOf(e)} - ${e.description}${e.planned ? ' (tervezett)' : ''}`
}

// /help text, generated from the registry. Sections follow CMD920 3.2.
export function renderHelp(): string {
  const builtin = entries.filter(e => e.source !== 'custom')
  const custom = entries.filter(e => e.source === 'custom')
  const read = builtin.filter(e => e.kind === 'read')
  const write = builtin.filter(e => e.kind === 'write' && !e.confirm)
  const confirm = builtin.filter(e => e.kind === 'write' && e.confirm)
  // Owner feedback (ELSOKOR922 Phase 7 A-smoke): the read list needs no header
  // of its own, and "MODOSÍT" says more than "ÍR" about what a write does.
  // First line (owner feedback 2026-09-24): the "?" is the way into every command.
  const out: string[] = ['Minden parancs után ?: részletes súgó példákkal, pl. /board ?', '']
  for (const e of read) out.push(helpLine(e))
  out.push('')
  out.push('MODOSÍT, megerősítés nélkül')
  if (write.length === 0) out.push('nincs')
  for (const e of write) out.push(helpLine(e))
  out.push('')
  out.push('MODOSÍT, megerősítéssel')
  if (confirm.length === 0) out.push('nincs')
  for (const e of confirm) out.push(helpLine(e))
  out.push('')
  out.push('SAJÁT')
  if (custom.length === 0) out.push('nincs')
  for (const e of custom) out.push(helpLine(e))
  return out.join('\n')
}

export interface BotCommand {
  command: string
  description: string
}

// The Telegram command menu: one row per runnable top-level name. Planned-only
// names are left out (the menu would offer a command that does nothing).
export function botCommandList(): BotCommand[] {
  const seen = new Set<string>()
  const out: BotCommand[] = []
  for (const e of entries) {
    if (e.planned || seen.has(e.name)) continue
    const primary = entries.find(x => x.name === e.name && !x.matches && !x.planned) ?? e
    seen.add(e.name)
    out.push({ command: e.name, description: primary.description.slice(0, 256) })
  }
  return out
}

// Split a reply into Telegram-sized chunks (4096 chars), preferring line
// boundaries so a table row is not cut in half.
export const TELEGRAM_MAX_TEXT = 4096

export function chunkText(text: string, max = TELEGRAM_MAX_TEXT): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut <= 0) cut = max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}
