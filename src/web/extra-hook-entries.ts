/**
 * Install-local extra hook entries for the sub-agents' generated settings.
 *
 * An install that wants one more hook in every sub-agent (a local PreToolUse
 * gate, an action log) used to patch agent-scaffold.ts and the startup
 * migration in web.ts, and that patch conflicted on every upgrade. Instead the
 * operator lists the entries in store/extra-hooks.json (store/ is gitignored,
 * the same place as egress-allowlist.json), and the scaffold appends them to
 * each sub-agent's settings.json after the built-in gates.
 *
 * What an entry can NOT do, by construction:
 *   - replace, remove or reorder a built-in hook: extras are appended after
 *     the built-ins of their event, and the only entries this module ever
 *     removes are the ones it wrote itself (recognised by EXTRA_HOOK_MARK);
 *   - use a path or matcher that contains the file name of a shipped script
 *     (scripts/ and scripts/hooks/, where every built-in gate lives): the
 *     built-in injectors find their own entries by script name
 *     (`JSON.stringify(entry).includes('egress-gate.mjs')`), so such an extra
 *     would be deleted by them, or would make a backfill believe the built-in
 *     gate is already wired;
 *   - point anywhere but the dedicated <root>/local-hooks/ directory
 *     (symlinks resolved), under a volatile tmp directory, or at a file that
 *     does not exist (the same registration guard the built-in gates use,
 *     isUnsafeHookCommand).
 *
 * Trust: store/extra-hooks.json and local-hooks/ decide what runs in EVERY
 * sub-agent's session, and the writers are meant to be the operator and the
 * main agent. What is actually enforced is narrower than "a sub-agent cannot
 * write them", and it is stated here so nobody reads more into it:
 *   - the sub-agents' self-pace gate denies a native file-tool write to either
 *     (by name and by resolved real path), and a Bash command that SPELLS a
 *     protected name: in plain text, through quoting, escapes or literal string
 *     concatenation, through a variable assigned a literal in the same command,
 *     as a glob or partly-unresolved word that can expand onto it, or a
 *     cp/mv/tar/rsync/... pointed at the project root or the store dir itself
 *     (the exact list is in scripts/self-pace-gate.mjs, "WHAT MENTIONS MEANS");
 *   - it does NOT stop a sub-agent that wants to write the file: a path built
 *     at run time, a script file written earlier and then run, an interpreter
 *     or git writing under a directory it picks. Every agent runs as the same
 *     OS user, so these files are in the same trust domain as every agent's own
 *     settings.json (which a sub-agent can also edit, and where a hand-added
 *     hook survives a respawn);
 *   - what the gate misses is made visible, not prevented: every time the
 *     extras are synced (dashboard start, sub-agent spawn), the sha256 of the
 *     file and of every script it names is logged once per content
 *     (logExtraHooksDigest in agent-scaffold.ts), so an unexpected change shows
 *     up in dashboard.log.
 * A script may not live in an agent's own directory (agents/<name>/) for the
 * same reason: that one the agent writes with no gate at all.
 *
 * Absent, empty or `{"entries": []}`: nothing is added and nothing is removed,
 * so the generated settings are byte-identical to a scaffold without this
 * module. A file that does not parse, or has the wrong shape, adds nothing; an
 * invalid entry is skipped on its own. Both are logged at error level, and
 * neither can touch a built-in gate.
 *
 * The main agent is not covered: its hooks are the repo-shipped project
 * settings, which the scaffold never writes (#1305).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative } from 'node:path'

export const EXTRA_HOOKS_FILE = 'extra-hooks.json'
/** The only directory an extra's script may live in, relative to the project root. */
export const EXTRA_HOOKS_DIR = 'local-hooks'

// Leading shell no-op that marks a command this module wrote. `:` does nothing
// and returns 0, so the command behaves exactly as without it; the marker is
// how a later pass (a changed or deleted file) finds its own entries and never
// a built-in one.
export const EXTRA_HOOK_MARK = ': extra-hook;'

export const EXTRA_HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit',
  'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact', 'Notification',
] as const

const ENTRY_KEYS = new Set(['event', 'matcher', 'script', 'timeout', 'failClosed', 'scope', 'description'])
const SCRIPT_RE = /^[A-Za-z0-9_][A-Za-z0-9_./@+-]*$/
const SCRIPT_EXTS = new Set(['.py', '.mjs', '.js'])
const MAX_MATCHER = 500
const MAX_TIMEOUT_SEC = 600
const DEFAULT_TIMEOUT_SEC = 10

export interface ExtraHookDeps {
  projectRoot: string
  /** The shipped scripts/ tree: the file names of scripts/ and scripts/hooks/
   *  (the built-in gates) are reserved. */
  shippedScriptsDir: string
  /** Absolute node binary for a non-fail-closed .mjs/.js entry. */
  nodeBin: string
  /** Fail-closed builders: the same ones the built-in gates use. */
  nodeGateCommand: (scriptPath: string, timeoutSec: number) => string
  pythonGateCommand: (scriptPath: string, timeoutSec: number) => string
  isUnsafe: (command: string) => boolean
}

export interface ExtraHookEntry {
  event: string
  matcher?: string
  command: string
  timeout: number
}

export interface ExtraHookLoad {
  entries: ExtraHookEntry[]
  /** Human-readable reasons, one per rejected entry (or one for the file). */
  errors: string[]
}

function realInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// The FILE names of the shipped script directories (a sub-directory such as
// __pycache__ names no hook).
function shippedNames(scriptsDir: string): string[] {
  const names: string[] = []
  for (const dir of [scriptsDir, join(scriptsDir, 'hooks')]) {
    try {
      names.push(...readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name))
    } catch { /* missing dir: nothing reserved from it */ }
  }
  return names
}

function validateEntry(raw: unknown, i: number, deps: ExtraHookDeps, reserved: string[]): ExtraHookEntry | string {
  const at = `entries[${i}]`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${at}: must be an object`
  const e = raw as Record<string, unknown>
  const unknown = Object.keys(e).filter((k) => !ENTRY_KEYS.has(k))
  if (unknown.length) return `${at}: unknown key(s) ${unknown.join(', ')}`

  const event = e.event
  if (typeof event !== 'string' || !(EXTRA_HOOK_EVENTS as readonly string[]).includes(event)) {
    return `${at}: event must be one of ${EXTRA_HOOK_EVENTS.join(', ')}`
  }
  if (e.scope !== undefined && e.scope !== 'subagents') return `${at}: scope must be "subagents" (the only scope this version wires)`
  let matcher: string | undefined
  if (e.matcher !== undefined) {
    if (typeof e.matcher !== 'string' || e.matcher.length === 0 || e.matcher.length > MAX_MATCHER) {
      return `${at}: matcher must be a non-empty string of at most ${MAX_MATCHER} characters`
    }
    try { new RegExp(e.matcher) } catch { return `${at}: matcher is not a valid regular expression` }
    matcher = e.matcher
  }
  let timeout = DEFAULT_TIMEOUT_SEC
  if (e.timeout !== undefined) {
    if (typeof e.timeout !== 'number' || !Number.isInteger(e.timeout) || e.timeout < 1 || e.timeout > MAX_TIMEOUT_SEC) {
      return `${at}: timeout must be an integer number of seconds, 1..${MAX_TIMEOUT_SEC}`
    }
    timeout = e.timeout
  }
  if (typeof e.failClosed !== 'boolean') return `${at}: failClosed must be set to true or false`
  // A fail-closed wrapper turns a crash into exit 2. On PreToolUse that denies
  // one tool call, which is the point of a gate; on UserPromptSubmit or
  // SessionStart it would block every prompt of the session.
  if (e.failClosed && event !== 'PreToolUse') return `${at}: failClosed is only allowed on PreToolUse`

  const script = e.script
  if (typeof script !== 'string' || !SCRIPT_RE.test(script) || script.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    return `${at}: script must be a plain relative path inside the project (letters, digits, _ . / @ + -, no ..)`
  }
  const ext = extname(script)
  if (!SCRIPT_EXTS.has(ext)) return `${at}: script must end in .py, .mjs or .js`
  const text = `${script}\n${matcher ?? ''}`
  const clash = reserved.find((n) => text.includes(n))
  if (clash) return `${at}: script or matcher contains the shipped script name ${clash}; extras may not name a built-in hook`
  if (script.split('/')[0] !== EXTRA_HOOKS_DIR) return `${at}: script must live in ${EXTRA_HOOKS_DIR}/ (the directory sub-agents cannot write)`
  const abs = join(deps.projectRoot, script)
  let realAbs: string
  try {
    if (!statSync(abs).isFile()) return `${at}: script ${script} is not a file`
    realAbs = realpathSync(abs)
  } catch {
    return `${at}: script ${script} does not exist`
  }
  let realRoot = deps.projectRoot
  try { realRoot = realpathSync(deps.projectRoot) } catch { /* keep as given */ }
  if (!realInside(join(realRoot, EXTRA_HOOKS_DIR), realAbs)) return `${at}: script ${script} resolves outside ${EXTRA_HOOKS_DIR}/`

  const body = e.failClosed
    ? (ext === '.py' ? deps.pythonGateCommand(abs, timeout) : deps.nodeGateCommand(abs, timeout))
    : (ext === '.py' ? `python3 "${abs}"` : `"${deps.nodeBin}" "${abs}"`)
  const command = `${EXTRA_HOOK_MARK} ${body}`
  if (deps.isUnsafe(command)) return `${at}: script ${script} fails the hook registration guard (volatile tmp path or missing file)`
  return { event, ...(matcher !== undefined ? { matcher } : {}), command, timeout }
}

/** Pure: validate a parsed config object. */
export function parseExtraHookEntries(raw: unknown, deps: ExtraHookDeps): ExtraHookLoad {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray((raw as { entries?: unknown }).entries)) {
    return { entries: [], errors: ['the file must be an object with an "entries" array; every extra ignored'] }
  }
  const reserved = shippedNames(deps.shippedScriptsDir)
  const entries: ExtraHookEntry[] = []
  const errors: string[] = []
  ;((raw as { entries: unknown[] }).entries).forEach((item, i) => {
    const r = validateEntry(item, i, deps, reserved)
    if (typeof r === 'string') errors.push(r)
    else entries.push(r)
  })
  return { entries, errors }
}

/** Read and validate the config file. A missing or blank file is no extras and no error. */
export function loadExtraHookEntries(path: string, deps: ExtraHookDeps): ExtraHookLoad {
  if (!existsSync(path)) return { entries: [], errors: [] }
  let text: string
  try { text = readFileSync(path, 'utf-8') } catch (err) {
    return { entries: [], errors: [`unreadable: ${(err as Error).message}; every extra ignored`] }
  }
  if (text.trim() === '') return { entries: [], errors: [] }
  let raw: unknown
  try { raw = JSON.parse(text) } catch (err) {
    return { entries: [], errors: [`not valid JSON: ${(err as Error).message}; every extra ignored`] }
  }
  return parseExtraHookEntries(raw, deps)
}

type Group = { matcher?: string; hooks?: Array<{ command?: unknown }> }

/** A matcher group this module wrote: every handler carries the marker. */
export function isExtraHookGroup(group: unknown): boolean {
  const hooks = (group as Group | null)?.hooks
  return Array.isArray(hooks) && hooks.length > 0
    && hooks.every((h) => typeof h?.command === 'string' && h.command.startsWith(EXTRA_HOOK_MARK))
}

/**
 * Pure: drop the groups an earlier pass wrote, then append `entries` at the end
 * of their events. Every other group keeps its place and its bytes. Returns
 * whether the hooks block changed.
 */
export function applyExtraHookEntries(settings: Record<string, unknown>, entries: readonly ExtraHookEntry[]): boolean {
  const before = JSON.stringify(settings.hooks ?? null)
  const current = settings.hooks
  if (current === undefined || current === null) {
    if (entries.length === 0) return false
    settings.hooks = {}
  } else if (typeof current !== 'object' || Array.isArray(current)) {
    return false // not a hooks block this module understands: leave it alone
  }
  const hooks = settings.hooks as Record<string, unknown>
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    const kept = groups.filter((g) => !isExtraHookGroup(g))
    if (kept.length === groups.length) continue
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  for (const e of entries) {
    if (hooks[e.event] !== undefined && !Array.isArray(hooks[e.event])) continue // never overwrite a malformed event
    const list = (hooks[e.event] ??= []) as unknown[]
    list.push({
      ...(e.matcher !== undefined ? { matcher: e.matcher } : {}),
      hooks: [{ type: 'command', command: e.command, timeout: e.timeout }],
    })
  }
  return JSON.stringify(settings.hooks ?? null) !== before
}

export interface ExtraHooksDigest {
  /** sha256 of the file's bytes. */
  sha256: string
  /** sha256 of each local-hooks/ script the file names (null: not readable). */
  scripts: Record<string, string | null>
}

const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/**
 * The fingerprint the dashboard logs when it syncs the extras: the file, and
 * every script it names under <projectRoot>/local-hooks/, whether or not the
 * entry is valid (a rejected entry today can be a valid one after the next
 * edit). Null when the file does not exist: then nothing is logged, as nothing
 * is wired. A file that does not parse still gets its own hash.
 */
export function extraHooksDigest(path: string, projectRoot: string): ExtraHooksDigest | null {
  if (!existsSync(path)) return null
  let bytes: Buffer
  try { bytes = readFileSync(path) } catch { return { sha256: 'unreadable', scripts: {} } }
  let raw: unknown = null
  try { raw = JSON.parse(bytes.toString('utf-8')) } catch { /* the file hash alone */ }
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)
    ? (raw as { entries: unknown[] }).entries : []
  const scripts: Record<string, string | null> = {}
  for (const e of list) {
    const script = (e as { script?: unknown } | null)?.script
    if (typeof script !== 'string' || !SCRIPT_RE.test(script) || script in scripts) continue
    if (script.split('/')[0] !== EXTRA_HOOKS_DIR || script.split('/').some((x) => x === '..' || x === '.' || x === '')) continue
    try { scripts[script] = sha256Hex(readFileSync(join(projectRoot, script))) } catch { scripts[script] = null }
  }
  return { sha256: sha256Hex(bytes), scripts }
}
