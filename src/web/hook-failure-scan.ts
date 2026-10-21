/**
 * A reader for the hook failures Claude Code records but nothing reads.
 *
 * When a hook exits with anything but 0 or 2, Claude Code writes a structured
 * `hook_non_blocking_error` record into the session transcript -- also in headless
 * runs, where nothing is printed. For a PreToolUse gate that is the dangerous case:
 * a non-blocking error means the gated call PROCEEDED, so a gate that crashes at
 * load (a missing import, a syntax error) is silently fail-open for every call until
 * someone reads the transcript. A blocked operation is recorded too, as a system
 * warning. Agents run unattended, so the inline terminal line is seen by nobody;
 * this module reads the record instead.
 *
 * Where it looks: every agent's Claude Code config root (configDirFor, else the
 * host default ~/.claude), under projects/<encoded-working-dir>/*.jsonl. A
 * transcript's owner is the agent whose root it was found under; files shared
 * between roots (a symlinked projects directory) are read once, owned by the first
 * agent listed (the main agent first). Agents with no config directory of their
 * own share the host default with the main agent, so that root is walked once and
 * its records are reported under the first agent listed with it.
 */
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { MAIN_AGENT_ID } from '../config.js'
import { listAllAgentNames } from './agent-config.js'
import { configDirFor } from './main-transcript-root.js'

export interface HookFailure {
  /** The agent whose transcript root the record was found under. */
  agent: string
  /** Transcript file the record came from (original path, not the realpath). */
  file: string
  sessionId: string | null
  /** SessionStart / UserPromptSubmit / PreToolUse / ... */
  event: string | null
  /** null for blocking records: the harness reports those without an exit code. */
  exitCode: number | null
  command: string | null
  stderr: string
  timestamp: string | null
  /**
   * false = the hook failed but the operation went through anyway (fail-open).
   * true  = the hook blocked the operation (exit 2). The difference matters: a gate
   * that fails open is a missing control, a gate that blocks is a lost turn.
   */
  blocking: boolean
}

const NON_BLOCKING_MARKER = 'hook_non_blocking_error'
const BLOCKING_MARKER = 'blocked by hook'

/**
 * Parse ONE transcript line. Returns null for anything that is not a structured hook
 * failure record.
 *
 * Deliberately strict about the blocking shape: a raw search for "blocked by hook"
 * also matches ordinary conversation about hooks, which a text-keyed detector would
 * report as incidents forever. Only `{type: 'system', level: 'warning'}` counts.
 */
export function parseHookFailureLine(
  line: string,
): Omit<HookFailure, 'agent' | 'file'> | null {
  // Cheap reject before JSON.parse: transcript lines are large and most are neither.
  if (!line.includes(NON_BLOCKING_MARKER) && !line.includes(BLOCKING_MARKER)) return null

  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null

  const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : null
  const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : null

  const attachment = obj.attachment as Record<string, unknown> | undefined
  if (obj.type === 'attachment' && attachment?.type === NON_BLOCKING_MARKER) {
    return {
      sessionId,
      timestamp,
      event: typeof attachment.hookEvent === 'string' ? attachment.hookEvent : null,
      exitCode: typeof attachment.exitCode === 'number' ? attachment.exitCode : null,
      command: typeof attachment.command === 'string' ? attachment.command : null,
      stderr: typeof attachment.stderr === 'string' ? attachment.stderr : '',
      blocking: false,
    }
  }

  if (obj.type === 'system' && obj.level === 'warning' && typeof obj.content === 'string'
      && obj.content.includes(BLOCKING_MARKER)) {
    // "UserPromptSubmit operation blocked by hook: ..." -- the event is the leading word.
    const event = /^\s*(\w+)\s+operation\s+blocked\s+by\s+hook/.exec(obj.content)?.[1] ?? null
    return {
      sessionId,
      timestamp,
      event,
      exitCode: null,
      command: null,
      stderr: obj.content,
      blocking: true,
    }
  }

  return null
}

export interface TranscriptRoot {
  agent: string
  /** A Claude Code `projects` directory. */
  dir: string
}

/** Every agent's transcript root, the main agent first; a directory shared by several agents once. */
export function transcriptRoots(): TranscriptRoot[] {
  const names = [MAIN_AGENT_ID, ...listAllAgentNames().filter((n) => n !== MAIN_AGENT_ID)]
  const roots: TranscriptRoot[] = []
  const dirs = new Set<string>()
  for (const agent of names) {
    const dir = join(configDirFor(agent) ?? join(homedir(), '.claude'), 'projects')
    if (dirs.has(dir)) continue
    dirs.add(dir)
    roots.push({ agent, dir })
  }
  return roots
}

export interface HookFailureScan {
  failures: HookFailure[]
  /** Roots walked (missing ones included: a root that does not exist yields nothing). */
  rootsScanned: number
  filesScanned: number
  filesSkippedByAge: number
  /**
   * In the window but could not be opened or read: counted, so such a file is never
   * dropped silently. (A file that vanishes before it can be stat-ed, or a folder
   * that cannot be listed, is not seen at all and so not counted.)
   */
  filesUnreadable: number
}

export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function collectJsonl(dir: string, out: string[], depth = 0): void {
  // Layout is <projects>/<encoded-cwd>/<uuid>.jsonl. Symlinks are followed (a
  // symlinked working-dir folder is common); the depth cap leaves room and stops a
  // symlink loop from walking forever, and the caller reads each realpath once.
  if (depth > 3) return
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    let isDir = e.isDirectory()
    let isFile = e.isFile()
    if (e.isSymbolicLink()) {
      try {
        const st = statSync(full)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch {
        continue                       // a dangling link
      }
    }
    if (isDir) collectJsonl(full, out, depth + 1)
    else if (isFile && e.name.endsWith('.jsonl')) out.push(full)
  }
}

const CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Call `onLine` for every line of `file`, reading it in chunks: a transcript can be
 * hundreds of MB, and one string of the whole file costs that much again in memory
 * (and past V8's string limit cannot be built at all). The decoder keeps a UTF-8
 * character that straddles two chunks intact. Throws if the file cannot be read.
 */
function forEachLine(file: string, onLine: (line: string) => void, chunkBytes = CHUNK_BYTES): void {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(chunkBytes)
    const decoder = new StringDecoder('utf8')
    let rest = ''
    for (;;) {
      const n = readSync(fd, buf, 0, chunkBytes, null)
      if (n === 0) break
      const lines = (rest + decoder.write(buf.subarray(0, n))).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    }
    const last = rest + decoder.end()
    if (last) onLine(last)
  } finally {
    closeSync(fd)
  }
}

/**
 * The hook failures recorded in the transcripts modified within the window (default
 * 7 days), oldest first. A transcript is read, in chunks, only when its mtime is
 * inside the window; a file that cannot be read is counted in filesUnreadable, and
 * a missing root yields nothing.
 */
export function scanHookFailures(
  opts: { sinceMs?: number; now?: number; roots?: TranscriptRoot[]; chunkBytes?: number } = {},
): HookFailureScan {
  const windowMs = opts.sinceMs ?? DEFAULT_WINDOW_MS
  const cutoff = (opts.now ?? Date.now()) - windowMs
  const roots = opts.roots ?? transcriptRoots()
  const seenFiles = new Set<string>()
  const failures: HookFailure[] = []
  let filesScanned = 0
  let filesSkippedByAge = 0
  let filesUnreadable = 0

  for (const root of roots) {
    const files: string[] = []
    collectJsonl(root.dir, files)
    for (const file of files) {
      let real: string
      let mtimeMs: number
      try {
        mtimeMs = statSync(file).mtimeMs
        real = realpathSync(file)
      } catch {
        continue
      }
      if (seenFiles.has(real)) continue
      seenFiles.add(real)
      if (mtimeMs < cutoff) {
        filesSkippedByAge++
        continue
      }
      const found: HookFailure[] = []
      try {
        // parseHookFailureLine rejects a line without either marker before parsing it.
        forEachLine(file, (line) => {
          const parsed = parseHookFailureLine(line)
          if (parsed) found.push({ ...parsed, agent: root.agent, file })
        }, opts.chunkBytes)
      } catch {
        filesUnreadable++
        continue
      }
      filesScanned++
      failures.push(...found)
    }
  }

  failures.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
  return { failures, rootsScanned: roots.length, filesScanned, filesSkippedByAge, filesUnreadable }
}

export interface HookFailureGroup {
  agent: string
  event: string | null
  exitCode: number | null
  command: string | null
  blocking: boolean
  count: number
  firstTimestamp: string | null
  lastTimestamp: string | null
  /** One line of the stderr -- enough to recognise the fault, short enough to print. */
  stderrHead: string
}

const HARNESS_WRAPPER = 'Failed with non-blocking status code:'

/**
 * The one stderr line worth printing. NOT simply the first: the harness prefixes its
 * own "Failed with non-blocking status code: file:///...:<line>" wrapper, so the first
 * line is a path and a line number while the line that names the fault (say
 * "ReferenceError: join is not defined") sits further down. The wrapper is dropped;
 * a line that STARTS with an error name wins (a code frame such as
 * `throw new Error(...)` merely contains one); otherwise the first line left, which
 * for a shell hook is its message ("jq: command not found").
 */
export function stderrHeadline(stderr: string): string {
  const lines = stderr.split('\n').map((s) => s.trim()).filter(Boolean)
  const body = lines.filter((l) => !l.startsWith(HARNESS_WRAPPER))
  return body.find((l) => /^\w*(?:Error|Exception)\b/.test(l)) ?? body[0] ?? lines[0] ?? ''
}

/** Collapse repeats so a hook that failed 200 times is one line, not 200. */
export function groupHookFailures(failures: HookFailure[]): HookFailureGroup[] {
  const groups = new Map<string, HookFailureGroup>()
  for (const f of failures) {
    const stderrHead = stderrHeadline(f.stderr)
    const key = [f.agent, f.event, f.exitCode, f.command, f.blocking, stderrHead].join('\u0000')
    const existing = groups.get(key)
    if (existing) {
      existing.count++
      if (f.timestamp && (!existing.lastTimestamp || f.timestamp > existing.lastTimestamp)) {
        existing.lastTimestamp = f.timestamp
      }
      if (f.timestamp && (!existing.firstTimestamp || f.timestamp < existing.firstTimestamp)) {
        existing.firstTimestamp = f.timestamp
      }
      continue
    }
    groups.set(key, {
      agent: f.agent,
      event: f.event,
      exitCode: f.exitCode,
      command: f.command,
      blocking: f.blocking,
      count: 1,
      firstTimestamp: f.timestamp,
      lastTimestamp: f.timestamp,
      stderrHead,
    })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}
