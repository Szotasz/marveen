import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { MAIN_AGENT_ID } from '../config.js'
import { isRepoShippedScript } from './precheck-trust.js'
import { preCheckScriptPath } from './precheck-path.js'
import type { ChannelProviderType } from '../channel-provider.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { readJsonObjectForWrite } from './agent-config.js'
import { parseHelperType, parseWatchSpec, type HelperTaskType, type WatchSpec } from './helper/types.js'

export const SCHEDULED_TASKS_DIR = join(homedir(), '.claude', 'scheduled-tasks')

// Hard cap on the prompt length for a scheduled task, to stop a malicious
// or accidentally-huge POST body from exhausting the target agent's
// token budget (and wedging the tmux send-keys paste detector). 50,000
// characters is ~12k tokens of English, which is already far beyond any
// legitimate schedule prompt -- real ones are usually <1k chars. Doubles
// (SCHEDPROMPTREF917) as the scheduled-task size-guard ALERT threshold: past
// this point delivery is fine (reference-based, see below), but the task
// itself is large enough to warrant a direct owner notice.
export const MAX_SCHEDULED_TASK_PROMPT_LEN = 50_000

// SCHEDPROMPTREF917: above this length the runner snapshots the full task
// body to disk (scheduled-run-snapshot.ts) and sends only a short reference
// through tmux, instead of pasting the whole body via send-keys -- the path
// that corrupted large scheduled-task fires (spec 1.1, 1.3). Below it, the
// existing inline path is unchanged. 1,500 chars keeps every measured task
// under this size inline (the smallest three, spec 3.3) while the previously
// corrupted ones (kanban-audit at ~49k) all cross it by a wide margin.
export const SCHEDULED_TASK_INLINE_MAX_CHARS = 1_500

// Below this, no size-guard notice. At/above it: a one-per-task-per-day
// logger.warn + inter-agent notice to the main agent (spec 3.5). Chosen well
// under MAX_SCHEDULED_TASK_PROMPT_LEN so the operator sees the growth trend
// (SKILL.md "Buktatók" accretion, spec 1.2) before it reaches the alert tier.
export const SCHEDULED_TASK_BODY_WARN_CHARS = 20_000

// #796: a deleted DEFAULT scheduled task must stay deleted. Seeding is
// skip-if-missing at three points -- ensureDefaultScheduledTasks() on every
// dashboard start, and the install/update shell seed loops -- so without a
// record of the deletion, a shipped task the operator removed reappears on the
// next restart or update. This tombstone is a newline-separated list of task
// names that all three seed points consult; the DELETE route appends to it and
// (re)creating a task clears its entry. Kept as a plain dotfile in the tasks
// dir (not a subdirectory) so listScheduledTasks -- which filters to dirs --
// never treats it as a task, and the shell seeders can read it with grep.
export const REMOVED_DEFAULTS_FILE = join(SCHEDULED_TASKS_DIR, '.removed-defaults')

export function readRemovedDefaultTasks(): Set<string> {
  try {
    return new Set(
      readFileSync(REMOVED_DEFAULTS_FILE, 'utf-8')
        .split('\n').map(l => l.trim()).filter(l => l.length > 0),
    )
  } catch { return new Set<string>() }
}

export function markDefaultTaskRemoved(taskName: string): void {
  const names = readRemovedDefaultTasks()
  if (names.has(taskName)) return
  names.add(taskName)
  mkdirSync(SCHEDULED_TASKS_DIR, { recursive: true })
  atomicWriteFileSync(REMOVED_DEFAULTS_FILE, [...names].sort().join('\n') + '\n')
}

export function clearDefaultTaskRemoved(taskName: string): void {
  const names = readRemovedDefaultTasks()
  if (!names.delete(taskName)) return
  const body = [...names].sort().join('\n')
  atomicWriteFileSync(REMOVED_DEFAULTS_FILE, body.length > 0 ? body + '\n' : '')
}

export interface ScheduledTask {
  name: string
  description: string
  prompt: string
  schedule: string
  agent: string
  enabled: boolean
  createdAt: number
  type?: 'task' | 'heartbeat' | 'command'  // heartbeat = silent unless important; command = raw shell, no LLM
  // When true, a tick whose target session is busy is dropped silently
  // instead of queued. Use ONLY for cron schedules that fire often enough
  // (every 30-60 min) that losing a single tick is harmless because the
  // next one is already on the way. Daily/weekly schedules must keep
  // skipIfBusy false (default) so the queue + alert path catches a
  // long-running busy state and nothing business-critical is lost.
  skipIfBusy?: boolean
  // When true, this task drives the shared desktop (GUI automation,
  // computer-use). While another agent holds the desktop lock, its ticks are
  // skipped -- and the skip is RECORDED, never silent. Marked per task rather
  // than matched against a list of task names in the runner: a hand-kept list
  // is a blind spot the day someone adds a GUI round and forgets it.
  requiresDesktop?: boolean
  // When true, skip the busy-state check entirely and inject the prompt
  // via tmux send-keys regardless. The Claude session will process it at
  // the next idle slot. Useful for critical tasks that must never be
  // deferred to a retry queue (e.g. daily briefings, heartbeats during
  // active conversations).
  forceSend?: boolean
  // Override the default tmux session name derived from the agent. When
  // set, the scheduler targets this exact tmux session instead of
  // `agent-<name>` or MAIN_CHANNELS_SESSION. Enables dedicated
  // scheduler-only sessions in the future.
  targetSession?: string
  // type='command' only: raw shell command run via `bash -lc`, no LLM/tmux.
  command?: string
  // type='command' only: command timeout in ms (default 10000).
  timeoutMs?: number
  // type='command' only: consecutive failures before a Telegram alert (default 2).
  failThreshold?: number
  // Optional pre-check script (filename relative to the task dir, or absolute path).
  // Runs via `bash` BEFORE invoking the LLM. Protocol:
  //   exit 0 + stdout "SKIP" → skip LLM this tick (nothing actionable)
  //   exit 0 + other stdout  → run LLM with stdout prepended to prompt as context
  //   exit 0 + empty stdout  → run LLM normally
  //   non-zero exit          → log warning, run LLM anyway (fail-open)
  preCheck?: string
  // How stale a MISSED occurrence may be and still be executed as a catch-up
  // after the scheduler was down (host powered off, dashboard restart). Unset
  // uses the per-type default in DEFAULT_CATCHUP_MAX_AGE_MIN; 0 disables
  // catch-up for this task entirely (only on-time ticks run it); a negative
  // value means "always catch up, however late". Occurrences older than the
  // limit are recorded as a 'missed' run and reported, never silently dropped.
  catchUpMaxAgeMinutes?: number
  // How long this task may run before the post-fire watchdog calls it stuck and
  // alerts the operator. Unset uses the global TASK_FIRE_TIMEOUT_MS (45 min),
  // which is right for a short-cadence heartbeat and wrong for a task whose job
  // is to think for a while. Clamped at both ends, see resolveStuckTimeoutMs.
  // DISTINCT from catchUpMaxAgeMinutes: that one judges a MISSED occurrence's
  // staleness before firing; this one judges a RUNNING injection's age.
  stuckAfterMinutes?: number
  // Manifest-style requirements (Roitman 22.5). When mcp_servers is set, the
  // runner pre-checks each named MCP server has a live process under the
  // target session before injecting the prompt; a dead server defers the task
  // with a reasoned alert instead of a silent runtime failure.
  requires?: { mcp_servers?: string[] }
  // type='heartbeat' only (HBMETRICSWIRE910): the runner executes
  // scripts/heartbeat-metrics.sh at prompt-build time and appends its output
  // PRE-RENDERED in final report form to the prompt. The receiving round
  // copies the block verbatim instead of running the instrument itself --
  // instructing the round to run it was measured failing 4 separate times
  // (fabricated numbers with the instruction standing).
  injectMetrics?: boolean
  // type='heartbeat' + injectMetrics only (HBFABRIC1003): the runner SENDS the
  // digest itself -- the measured block, a header and nothing else -- as an
  // inter-agent message to the main agent, with no LLM round at all. The
  // round's one job was to copy the block and POST it; it was measured
  // failing at exactly that (2026-10-03: a number typed before reading the
  // block, then twice the POST written out as text and never run).
  sendDigestDirect?: boolean
  // Explicit Telegram delivery target for this task's result (WRONGRECIP819).
  // Unset means "resolve it automatically" -- safe only when the agent's own
  // channel access.json has exactly one DM contact; with 2+ contacts the
  // runner will no longer guess (see resolveTaskChannelTarget in
  // schedule-runner.ts; the name lost its Telegram-only spelling when Slack
  // was added). A real chat_id string pins the exact recipient,
  // overriding any allowlist-order heuristic. The literal string "none" means
  // this task has NO direct Telegram recipient at all (e.g. its result goes
  // out as an inter-agent message, or it is a self-only reminder) -- the
  // runner omits the Telegram delivery instruction entirely, no warning.
  telegramChatId?: string
  // SLACKFOCSATORNA1007C: the provider this task's result is delivered on,
  // when it is NOT the agent's own bound provider (e.g. the main agent is
  // bound to Telegram, but the owner reads this task's result in the Slack
  // DM). The chat id still comes from telegramChatId (the key keeps its
  // historical name); without one, the agent's binding for THIS provider is
  // resolved. An unknown value is ignored, as if unset.
  channelProvider?: ChannelProviderType
  // Run once (card 7d2b49b4): after the first SUCCESSFUL run the runner switches the task off itself
  // (enabled:false + onceDisabledAt). The fleet wrote one-offs as a dated cron ("0 5 22 9 *"), which fires
  // again every year and had to be switched off by hand. "Successful" is isOnceRunSuccess for a prompt task
  // and exit 0 for a command task: a damaged or lost run leaves the task on, so it stays visible.
  once?: boolean
  // When the runner switched a once task off (ISO time); absent until then.
  onceDisabledAt?: string
  // A named topic of the main chat (`/topic new <name>`, store/telegram-topics.json)
  // the result goes into. Used only while TELEGRAM_TOPICS_ENABLED is on, for the
  // main agent's tasks delivered on Telegram; otherwise ignored (see
  // resolveTaskTopicThreadId in schedule-runner.ts).
  telegramTopic?: string
  // Local helper routing (docs/superpowers/specs/2026-10-26-local-helper-task-routing-design.md 4.3): routes the
  // task to the helper while HELPER_ENABLED=1 and the active helper provider
  // ticks this type; otherwise the task runs exactly as it always did. Both
  // keys are absent (not undefined-valued) on a task that does not set them.
  helperType?: HelperTaskType
  // helperType 'watch' / 'wake': the deterministic watch the helper evaluates.
  watch?: WatchSpec
  // Scheduled-task registry: sha256 over the exact bytes this read
  // parsed (SKILL.md + task-config.json), the preCheck script (see
  // preCheckHashTarget) and every other file under the task dir
  // (taskDirExtraParts). The runner compares it with the server-owned registry and
  // fires only on a match. Computed from the SAME buffers the task was parsed
  // from, so a file swapped between "hash" and "parse" cannot slip through.
  contentHash?: string
  // sha256 of the preCheck script bytes that went into contentHash, or
  // PRECHECK_ABSENT; undefined when the preCheck is not hashed (none, or a
  // repo-shipped script under <PROJECT_ROOT>/scripts/, see preCheckHashTarget). The runner runs exactly these
  // bytes, so a script swapped after the read is not executed.
  preCheckSha256?: string
  // How many entries under the task dir, besides SKILL.md and task-config.json,
  // went into contentHash (taskDirExtraParts); -1 when the dir is over the
  // hash bounds. A writer that only wrote those two files refuses to register
  // a dir where this is not 0 (registerScheduledTask noUnwrittenDirFiles).
  dirFiles?: number
  // The on-disk directory name. The registry is keyed by THIS, never by
  // `name` (which a SKILL.md frontmatter can set to anything): a planted dir
  // claiming another task's name must not borrow that task's registry entry.
  dirName?: string
}

const CHANNEL_PROVIDER_VALUES: readonly ChannelProviderType[] = ['telegram', 'slack', 'discord', 'googlechat', 'teams']

/** A ChannelProviderType, or undefined for anything else (absent, mistyped, wrong case). */
export function parseChannelProvider(raw: unknown): ChannelProviderType | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim()
  return (CHANNEL_PROVIDER_VALUES as readonly string[]).includes(v) ? v as ChannelProviderType : undefined
}

function readFileOr(path: string, fallback: string): string {
  try { return readFileSync(path, 'utf-8') } catch { return fallback }
}

export function parseSkillMdFrontmatter(content: string): { name?: string; description?: string; body: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!fmMatch) return { body: content }
  const yaml = fmMatch[1]
  const body = fmMatch[2].trim()
  const nameMatch = yaml.match(/^name:\s*(.+)$/m)
  const descMatch = yaml.match(/^description:\s*(.+)$/m)
  return {
    name: nameMatch?.[1]?.trim(),
    description: descMatch?.[1]?.trim(),
    body,
  }
}

// A hand-written "once": "true" is NOT once (card 7d2b49b4, a review finding): only the JSON true counts, the
// same rule the API enforces with a 400. Ignoring it silently would let a task meant to run once fire again
// every year, so the read says so, naming the task -- once per task and value per process, because the
// runner reads every task every minute.
const announcedNonBooleanOnce = new Set<string>()

function readOnceFlag(taskName: string, raw: unknown): boolean {
  if (raw === undefined || typeof raw === 'boolean') return raw === true
  const key = JSON.stringify([taskName, raw])
  if (!announcedNonBooleanOnce.has(key)) {
    announcedNonBooleanOnce.add(key)
    logger.warn({ task: taskName, once: raw }, 'task-config.json "once" is not true or false -- the task is NOT treated as once')
  }
  return false
}

/** Test seam: the announce-once memory is process-wide by design. */
export function resetOnceValueAnnouncements(): void {
  announcedNonBooleanOnce.clear()
}

function readBufferOr(path: string): Buffer | null {
  try { return readFileSync(path) } catch { return null }
}

// Which preCheck script is part of a task's trusted content. The runner runs
// it with bash on every tick (resolvePreCheckPath in schedule-runner.ts); both
// locate it by preCheckScriptPath (precheck-path.ts), so they cannot disagree
// on which script, or whether there is one at all. The resolved script is
// hashed wherever it points (an absolute path under a writable dir such as
// /tmp or an agent's working dir must not be trusted by its path),
// EXCEPT repo-shipped code under <PROJECT_ROOT>/scripts/ (isRepoShippedScript):
// it is updated with the install, and hashing it would stop the task on every
// update that changes the script. Returns null when the script is not hashed.
export function preCheckHashTarget(taskDir: string, preCheck: unknown): string | null {
  const resolved = preCheckScriptPath(taskDir, preCheck)
  if (resolved == null || isRepoShippedScript(resolved)) return null
  return resolved
}

// Every other entry under a task's own directory (recursively), besides the
// top-level SKILL.md and task-config.json that readScheduledTask hashes from
// the buffers it parses. A registered task can run or read these (a preCheck
// that wraps another file, a `command` that runs a script kept next to the
// task, a prompt that points the agent at a helper or at references/*.md), so
// they are part of its trusted content: an added, removed or changed file
// changes the hash. Sorted by relative path ('/'-separated), so the order is
// stable. A symlink is followed and hashed by its target's bytes (a linked
// directory is walked, once per real path, so a link loop terminates); a
// broken link by its link text; anything that is neither a file nor a
// directory (fifo, socket, device) by its name only, never read. Bounded: a
// directory with more than TASK_DIR_MAX_FILES entries or TASK_DIR_MAX_BYTES of
// content throws TaskDirTooLargeError, and the task then has no hash (it is
// neither registered nor fired; fail-closed).
export interface TaskDirPart { label: string; buf: Buffer | null }
export const TASK_DIR_MAX_FILES = 500
export const TASK_DIR_MAX_BYTES = 16 * 1024 * 1024
export class TaskDirTooLargeError extends Error {}

export function taskDirExtraParts(taskDir: string): TaskDirPart[] {
  const parts: TaskDirPart[] = []
  let bytes = 0
  const seenDirs = new Set<string>()
  const walk = (abs: string, rel: string): void => {
    let real: string
    try { real = realpathSync(abs) } catch { return }
    if (seenDirs.has(real)) { parts.push({ label: `dir-loop:${rel}`, buf: null }); return }
    seenDirs.add(real)
    let names: string[]
    try { names = readdirSync(abs).sort() } catch { parts.push({ label: `unreadable:${rel}`, buf: null }); return }
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name
      if (!rel && (name === 'SKILL.md' || name === 'task-config.json')) continue
      if (parts.length >= TASK_DIR_MAX_FILES) throw new TaskDirTooLargeError(`more than ${TASK_DIR_MAX_FILES} entries`)
      const childAbs = join(abs, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(childAbs)
      } catch {
        // A broken symlink (or an entry that vanished): hash what it is, not nothing.
        let link: Buffer | null = null
        try { if (lstatSync(childAbs).isSymbolicLink()) link = Buffer.from(readlinkSync(childAbs), 'utf-8') } catch { /* gone */ }
        parts.push({ label: `broken:${childRel}`, buf: link })
        continue
      }
      if (st.isDirectory()) { walk(childAbs, childRel); continue }
      if (!st.isFile()) { parts.push({ label: `special:${childRel}`, buf: null }); continue }
      bytes += st.size
      if (bytes > TASK_DIR_MAX_BYTES) throw new TaskDirTooLargeError(`more than ${TASK_DIR_MAX_BYTES} bytes`)
      let buf: Buffer | null
      try { buf = readFileSync(childAbs) } catch { parts.push({ label: `unreadable:${childRel}`, buf: null }); continue }
      parts.push({ label: `file:${childRel}`, buf })
    }
  }
  walk(taskDir, '')
  return parts
}

// Canonical, length-framed hash of a task's trusted files. Each part is
// labelled and length-prefixed, and an absent file hashes differently from an
// empty one, so no two distinct file sets can collide by concatenation (a
// label never contains NUL, the separator after it). A task dir with no other
// files hashes exactly as before the dir parts were added.
export function computeScheduledTaskHash(parts: { skill: Buffer | null; config: Buffer | null; preCheck?: Buffer | null; preCheckRel?: string | null; dirParts?: TaskDirPart[] }): string {
  const h = createHash('sha256')
  h.update('marveen-scheduled-task-v1\n')
  const add = (label: string, buf: Buffer | null | undefined) => {
    if (buf == null) { h.update(`${label}\0absent\n`); return }
    h.update(`${label}\0${buf.length}\n`)
    h.update(buf)
    h.update('\n')
  }
  add('SKILL.md', parts.skill)
  add('task-config.json', parts.config)
  if (parts.preCheckRel) add(`preCheck:${parts.preCheckRel}`, parts.preCheck ?? null)
  for (const p of parts.dirParts ?? []) add(`dir:${p.label}`, p.buf)
  return h.digest('hex')
}

// Sentinel for "the hashed preCheck script did not exist when the task was
// read": a script that appears later is not the trusted content either.
export const PRECHECK_ABSENT = 'absent'

export function preCheckBytesSha256(buf: Buffer | null): string {
  return buf == null ? PRECHECK_ABSENT : createHash('sha256').update(buf).digest('hex')
}

// The registry hash of a task dir given its SKILL.md and task-config.json
// bytes; the preCheck script (if hashed) and every other file under the task
// dir (taskDirExtraParts) are read from disk. Used by readScheduledTask, and by
// a writer that registers the bytes it WROTE rather than whatever is on disk a
// moment later (registerScheduledTask `written`). contentHash is undefined
// when the task dir is over the size bounds (TaskDirTooLargeError): such a
// task is never registered and never fired. `dirFiles` is the number of
// entries hashed besides SKILL.md and task-config.json.
const warnedTooLarge = new Set<string>()
export function scheduledTaskHashFromFiles(
  taskDir: string,
  skillBuf: Buffer | null,
  configBuf: Buffer | null,
): { contentHash?: string; preCheckSha256?: string; dirFiles: number } {
  let preCheck: unknown
  try {
    const parsed = JSON.parse(configBuf != null ? configBuf.toString('utf-8') : '{}')
    if (parsed && typeof parsed === 'object') preCheck = (parsed as { preCheck?: unknown }).preCheck
  } catch { /* unparsable config: no preCheck */ }
  const target = preCheckHashTarget(taskDir, preCheck)
  const preCheckBuf = target ? readBufferOr(target) : null
  const preCheckSha256 = target ? preCheckBytesSha256(preCheckBuf) : undefined
  let dirParts: TaskDirPart[]
  try {
    dirParts = taskDirExtraParts(taskDir)
  } catch (err) {
    if (!(err instanceof TaskDirTooLargeError)) throw err
    if (!warnedTooLarge.has(taskDir)) {
      warnedTooLarge.add(taskDir)
      logger.warn({ taskDir, reason: err.message }, 'scheduled task dir is over the registry hash bounds; the task is not registered and not fired')
    }
    return { contentHash: undefined, preCheckSha256, dirFiles: -1 }
  }
  return {
    contentHash: computeScheduledTaskHash({
      skill: skillBuf,
      config: configBuf,
      // Labelled with the preCheck string as written (never empty here).
      preCheckRel: target ? (preCheck as string) : null,
      preCheck: preCheckBuf,
      dirParts,
    }),
    preCheckSha256,
    dirFiles: dirParts.length,
  }
}

export function readScheduledTask(taskName: string): ScheduledTask | null {
  const dir = join(SCHEDULED_TASKS_DIR, taskName)
  const skillPath = join(dir, 'SKILL.md')
  const configPath = join(dir, 'task-config.json')
  // Read each file ONCE as bytes: the same buffers feed both the parse and the
  // registry hash.
  const skillBuf = readBufferOr(skillPath)
  const configBuf = readBufferOr(configPath)
  // command-type tasks have no SKILL.md; they are defined entirely by
  // task-config.json. Only bail if neither file exists.
  if (skillBuf == null && configBuf == null) return null

  const skillContent = skillBuf != null ? skillBuf.toString('utf-8') : ''
  const { name, description, body } = parseSkillMdFrontmatter(skillContent)

  let config: { schedule?: string; agent?: string; enabled?: boolean; createdAt?: number; type?: string; skipIfBusy?: boolean; requiresDesktop?: boolean; forceSend?: boolean; targetSession?: string; description?: string; command?: string; timeoutMs?: number; failThreshold?: number; preCheck?: string; catchUpMaxAgeMinutes?: unknown; stuckAfterMinutes?: unknown; requires?: { mcp_servers?: unknown }; injectMetrics?: unknown; sendDigestDirect?: unknown; telegramChatId?: string; channelProvider?: unknown; once?: unknown; onceDisabledAt?: unknown; telegramTopic?: unknown; helperType?: unknown; watch?: unknown } = {}
  try {
    config = JSON.parse(configBuf != null ? configBuf.toString('utf-8') : '{}')
  } catch { /* use defaults */ }
  if (config === null || typeof config !== 'object') config = {}

  const { contentHash, preCheckSha256, dirFiles } = scheduledTaskHashFromFiles(dir, skillBuf, configBuf)
  const helperType = parseHelperType(config.helperType)
  const watch = parseWatchSpec(config.watch)

  return {
    name: name || taskName,
    description: description || config.description || '',
    prompt: body,
    schedule: config.schedule || '0 9 * * *',
    agent: config.agent || MAIN_AGENT_ID,
    enabled: config.enabled !== false,
    createdAt: config.createdAt || 0,
    type: (config.type as 'task' | 'heartbeat' | 'command') || 'task',
    skipIfBusy: config.skipIfBusy === true,
    requiresDesktop: config.requiresDesktop === true,
    forceSend: config.forceSend === true,
    targetSession: config.targetSession || undefined,
    command: config.command,
    timeoutMs: config.timeoutMs,
    failThreshold: config.failThreshold,
    preCheck: config.preCheck,
    catchUpMaxAgeMinutes: parseCatchUpMaxAge(config.catchUpMaxAgeMinutes),
    stuckAfterMinutes: parseFiniteMinutes(config.stuckAfterMinutes),
    requires: parseRequires(config.requires),
    injectMetrics: config.injectMetrics === true,
    sendDigestDirect: config.sendDigestDirect === true,
    telegramChatId: typeof config.telegramChatId === 'string' && config.telegramChatId.trim() ? config.telegramChatId.trim() : undefined,
    channelProvider: parseChannelProvider(config.channelProvider),
    once: readOnceFlag(taskName, config.once),
    onceDisabledAt: typeof config.onceDisabledAt === 'string' ? config.onceDisabledAt : undefined,
    telegramTopic: typeof config.telegramTopic === 'string' && config.telegramTopic.trim() ? config.telegramTopic.trim() : undefined,
    ...(helperType ? { helperType } : {}),
    ...(watch ? { watch } : {}),
    contentHash,
    preCheckSha256,
    dirFiles,
    dirName: taskName,
  }
}

// Only a finite number is a policy; anything else (string, null, NaN) is
// treated as absent so a malformed config falls back to the built-in default
// instead of disabling a guard by accident.
export function parseFiniteMinutes(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

// Same acceptance rule, kept as a named export because the catch-up call sites
// and tests predate the generic helper (range semantics live downstream in
// catchUpMaxAgeMs / resolveStuckTimeoutMs, not here).
export function parseCatchUpMaxAge(raw: unknown): number | undefined {
  return parseFiniteMinutes(raw)
}

// Accept only a string array for requires.mcp_servers; anything else is
// treated as absent so a malformed config cannot wedge the runner.
export function parseRequires(raw: { mcp_servers?: unknown } | undefined): ScheduledTask['requires'] {
  if (!raw || !Array.isArray(raw.mcp_servers)) return undefined
  const servers = raw.mcp_servers.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
  return servers.length ? { mcp_servers: servers } : undefined
}

export function listScheduledTasks(): ScheduledTask[] {
  if (!existsSync(SCHEDULED_TASKS_DIR)) return []
  const dirs = readdirSync(SCHEDULED_TASKS_DIR).filter(f => {
    try { return statSync(join(SCHEDULED_TASKS_DIR, f)).isDirectory() } catch { return false }
  })
  const tasks: ScheduledTask[] = []
  for (const d of dirs) {
    const task = readScheduledTask(d)
    if (task) tasks.push(task)
  }
  return tasks.sort((a, b) => b.createdAt - a.createdAt)
}

// The exact bytes a writer put into a task dir: registerScheduledTask(...,
// written) registers THESE, so a concurrent writer between the write and the
// registration cannot get its content trusted (the hashes differ, nothing is
// registered). null = the writer left that file absent.
export interface ScheduledTaskWritten {
  skill: string | Buffer | null
  config: string | Buffer | null
}

export function writeScheduledTask(
  taskName: string,
  data: { description?: string; prompt?: string; schedule?: string; agent?: string; enabled?: boolean; type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string; command?: string; timeoutMs?: number; failThreshold?: number; preCheck?: string; catchUpMaxAgeMinutes?: number; stuckAfterMinutes?: number; injectMetrics?: boolean; sendDigestDirect?: boolean; telegramChatId?: string; channelProvider?: ChannelProviderType | null; once?: boolean; helperType?: HelperTaskType; watch?: WatchSpec },
): ScheduledTaskWritten {
  const dir = join(SCHEDULED_TASKS_DIR, taskName)
  mkdirSync(dir, { recursive: true })
  // (Re)creating a task with this name is a deliberate act -- lift any tombstone
  // so a later restart's seeding treats it as present, not as removed (#796).
  clearDefaultTaskRemoved(taskName)

  const skillPath = join(dir, 'SKILL.md')
  const configPath = join(dir, 'task-config.json')

  // Read existing if updating
  const existing = readScheduledTask(taskName)

  // Write SKILL.md
  const desc = data.description ?? existing?.description ?? ''
  const prompt = data.prompt ?? existing?.prompt ?? ''
  const skillContent = `---\nname: ${taskName}\ndescription: ${desc}\n---\n\n${prompt}\n`
  atomicWriteFileSync(skillPath, skillContent)

  // Write/update config
  let config: Record<string, unknown> = {}
  config = readJsonObjectForWrite(configPath)
  if (data.schedule !== undefined) config.schedule = data.schedule
  if (data.agent !== undefined) config.agent = data.agent
  if (data.enabled !== undefined) config.enabled = data.enabled
  if (data.type !== undefined) config.type = data.type
  if (data.skipIfBusy !== undefined) config.skipIfBusy = data.skipIfBusy
  if (data.forceSend !== undefined) config.forceSend = data.forceSend
  if (data.targetSession !== undefined) config.targetSession = data.targetSession
  if (data.command !== undefined) config.command = data.command
  if (data.timeoutMs !== undefined) config.timeoutMs = data.timeoutMs
  if (data.failThreshold !== undefined) config.failThreshold = data.failThreshold
  if (data.preCheck !== undefined) config.preCheck = data.preCheck
  if (data.catchUpMaxAgeMinutes !== undefined) config.catchUpMaxAgeMinutes = data.catchUpMaxAgeMinutes
  if (data.stuckAfterMinutes !== undefined) config.stuckAfterMinutes = data.stuckAfterMinutes
  if (data.injectMetrics !== undefined) config.injectMetrics = data.injectMetrics
  if (data.sendDigestDirect !== undefined) config.sendDigestDirect = data.sendDigestDirect
  if (data.telegramChatId !== undefined) config.telegramChatId = data.telegramChatId
  // null clears the override (back to the agent's own provider); an unknown
  // value is never written, so the reader's "ignored as unset" is not the only guard.
  if (data.channelProvider === null) delete config.channelProvider
  else if (data.channelProvider !== undefined) {
    const cp = parseChannelProvider(data.channelProvider)
    if (cp) config.channelProvider = cp
  }
  if (data.once !== undefined) config.once = data.once
  if (data.helperType !== undefined) config.helperType = data.helperType
  if (data.watch !== undefined) config.watch = data.watch
  if (data.description !== undefined) config.description = data.description
  if (!config.createdAt) config.createdAt = Math.floor(Date.now() / 1000)
  const configContent = JSON.stringify(config, null, 2)
  atomicWriteFileSync(configPath, configContent)
  return { skill: skillContent, config: configContent }
}

/**
 * Whether a prompt task's run counts as the "first successful run" of a once task (card 7d2b49b4): the
 * run closed 'done' -- the session worked on it and went idle -- AND the transcript shows the prompt arrived
 * intact, as a turn of its own ('intact') or queued into a running turn ('intact-queued', card c8a6c2cc:
 * whole, just handed over while the agent was busy). Every other ending ('abandoned', 'lost') and every
 * other delivery verdict (damaged, not arrived, unverifiable, never checked) is not a success: the task
 * stays on and visible rather than silently gone.
 *
 * A REMOTE agent is the one exception (review on #1806): its transcript lives on its own host, so the
 * runner never records sentText/typedAt for it and no delivery verdict can exist. For such a run a closed
 * 'done' is the success bar -- the same bar a command task meets with exit 0 ('done' already requires
 * sawTurn). The caller says so explicitly with `remote: true`; a missing verdict on a LOCAL run is still
 * "never checked" and still not a success.
 */
export function isOnceRunSuccess(
  decision: string,
  deliveryVerdict: string | null | undefined,
  delivery: { remote?: boolean } = {},
): boolean {
  if (decision !== 'done') return false
  if (delivery.remote === true) return true
  return deliveryVerdict === 'intact' || deliveryVerdict === 'intact-queued'
}

/**
 * Switch a once task off after its first successful run (card 7d2b49b4): enabled:false and onceDisabledAt,
 * nothing else. Only task-config.json is written -- writeScheduledTask would also rewrite SKILL.md, and would
 * create one for a command task that has none. Returns true only when it switched something off: a task
 * without once, an already disabled one, or a missing one is left exactly as it is. A corrupt
 * task-config.json is refused (readJsonObjectForWrite throws), never reset.
 */
export function disableOnceTask(taskName: string, nowMs: number): boolean {
  const configPath = join(SCHEDULED_TASKS_DIR, taskName, 'task-config.json')
  if (!existsSync(configPath)) return false
  const config = readJsonObjectForWrite(configPath)
  if (config.once !== true || config.enabled === false) return false
  config.enabled = false
  config.onceDisabledAt = new Date(nowMs).toISOString()
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
  return true
}
