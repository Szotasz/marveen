import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { encodeClaudeProjectDir } from '../claude-project-dir.js'

// Claude Code writes one .jsonl session log per session under
// ~/.claude/projects/<encoded-working-dir>/. Every assistant turn carries the
// model id that answered it. We use that to surface the *live* running model
// (vs. the configured value in agent-config.json), so the dashboard can show
// what the running process is actually using, including across restarts.
//
// When an agent is launched with --continue, Claude Code appends to the same
// session jsonl across restarts, so the latest "model" field may reflect a
// pre-restart turn rather than the freshly-spawned process. Callers that know
// when the current session started should pass sinceUnixSec; we then ignore
// any line whose own timestamp predates that, leaving the caller to fall back
// to the configured model until the new session writes its first turn.
const cache = new Map<string, { value: string | null; expiresAt: number }>()
const TTL_MS = 3000

// df2e0d97 2b: the newest transcript is read from its END, in chunks, and only as far back as the answer needs.
// The whole-file readFileSync it replaces ran for every running agent on GET /api/agents and in the context
// monitors: in a 20.7-hour measurement of the dashboard's event loop (df2e0d97 phase 1) the main thread read
// 296 GB, in bursts of up to 540 MB, while the agents' newest transcripts stood open. Per (reader, transcript) the
// scan is remembered by the file's identity (dev + ino), size and mtime and the start of its last line, so the next
// call reads only the bytes appended since (Claude Code only appends), and an unchanged file is not read at all. The
// answer is the old one: the same lines (split on newline, trimmed, blank ones skipped), tried from the last to the
// first, the first that answers wins.
const SCAN_CHUNK_BYTES = 256 * 1024
const MAX_REMEMBERED_SCANS = 512
type ScanState = {
  dev: number; ino: number; size: number; mtimeMs: number; lastLineStart: number; found: unknown; foundAt: number
  // the bytes just before lastLineStart: an in-place rewrite (not an append) changes them, and is then read whole
  anchor: Buffer
}
const ANCHOR_BYTES = 64
const scans = new Map<string, ScanState>()
let scanBytesRead = 0

// The lines of [from, to) from the last to the first, each with the offset of its first byte. Split on the byte 0x0A
// (a multibyte UTF-8 character never contains it), so a line is decoded whole; the segment after the last newline is
// a line too, as in content.split('\n').
function* linesBackward(fd: number, from: number, to: number): Generator<{ start: number; text: string }> {
  let pos = to
  let tail: Buffer[] = []
  let tailStart = to
  while (pos > from) {
    const len = Math.min(SCAN_CHUNK_BYTES, pos - from)
    pos -= len
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, pos + got)
      if (n === 0) break
      got += n
    }
    scanBytesRead += got
    let end = got
    for (let i = got - 1; i >= 0; i--) {
      if (buf[i] !== 0x0a) continue
      const piece = buf.subarray(i + 1, end)
      yield { start: pos + i + 1, text: (tail.length ? Buffer.concat([piece, ...tail]) : piece).toString('utf-8') }
      tail = []
      end = i
    }
    tail.unshift(buf.subarray(0, end))
    tailStart = pos
  }
  yield { start: tailStart, text: Buffer.concat(tail).toString('utf-8') }
}

// The answer of `pick` on the last line of the transcript that has one, or null. `key` names the reader and its
// parameters; the remembered scan is per key and file.
function lastAnswerInTranscript<T>(key: string, file: string, pick: (entry: any) => T | undefined): T | null {
  const st = statSync(file)
  const memoKey = `${key}\u0000${file}`
  const prev = scans.get(memoKey)
  let from = 0
  let base: { found: unknown; foundAt: number } = { found: null, foundAt: -1 }
  if (prev && prev.dev === st.dev && prev.ino === st.ino) {
    if (st.size === prev.size && st.mtimeMs === prev.mtimeMs) return prev.found as T | null
    // Grown since: only the last (maybe unfinished) line and the appended bytes need reading, unless the answer
    // stood in that last line itself (then it may have changed with it). Same size with another mtime, or a shorter
    // file, is read whole.
    if (st.size > prev.size && prev.foundAt < prev.lastLineStart && sameBytes(file, prev.lastLineStart - prev.anchor.length, prev.anchor)) {
      from = prev.lastLineStart
      base = { found: prev.found, foundAt: prev.foundAt }
    }
  }
  let found: unknown = base.found
  let foundAt = base.foundAt
  let lastLineStart = from
  let anchor: Buffer = Buffer.alloc(0)
  const fd = openSync(file, 'r')
  try {
    let first = true
    for (const { start, text } of linesBackward(fd, from, st.size)) {
      if (first) { lastLineStart = start; first = false }
      const line = text.trim()
      if (!line) continue
      let answer: T | undefined
      try { answer = pick(JSON.parse(line)) } catch { continue /* a malformed line */ }
      if (answer !== undefined) { found = answer; foundAt = start; break }
    }
    // the anchor of the next call: the bytes before the last line's start
    const anchorLen = Math.min(ANCHOR_BYTES, lastLineStart)
    anchor = Buffer.alloc(anchorLen)
    if (anchorLen > 0) scanBytesRead += readSync(fd, anchor, 0, anchorLen, lastLineStart - anchorLen)
  } finally { closeSync(fd) }
  if (scans.size >= MAX_REMEMBERED_SCANS && !scans.has(memoKey)) scans.clear()
  scans.set(memoKey, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, lastLineStart, found, foundAt, anchor })
  return found as T | null
}

function sameBytes(file: string, at: number, want: Buffer): boolean {
  if (want.length === 0) return true
  const got = Buffer.alloc(want.length)
  const fd = openSync(file, 'r')
  try {
    if (readSync(fd, got, 0, want.length, at) !== want.length) return false
  } finally { closeSync(fd) }
  scanBytesRead += want.length
  return got.equals(want)
}

// Test hooks: the bytes the backward scans have read so far, and a reset of the remembered scans.
export function transcriptScanBytesReadForTests(): number { return scanBytesRead }
export function resetTranscriptScansForTests(): void { scans.clear(); scanBytesRead = 0; cache.clear(); ctxCache.clear() }

// Resolve the session-log directory Claude Code writes for a working dir.
// Logs live under <config-root>/projects/<encoded-working-dir>/, where the
// config root is ~/.claude by default but an alternate one when the agent was
// launched with CLAUDE_CONFIG_DIR. Pass that absolute config root as configDir
// so we read the right project dir for agents on a non-default config.
export function projectsDirFor(workingDir: string, configDir?: string, homeDirOverride?: string): string {
  const base = configDir ?? join(homeDirOverride ?? homedir(), '.claude')
  // The encoding is Claude Code's, measured -- see src/claude-project-dir.ts.
  const encoded = encodeClaudeProjectDir(workingDir)
  return join(base, 'projects', encoded)
}

export function readActiveModelFromProjectDir(workingDir: string, sinceUnixSec?: number, configDir?: string): string | null {
  const now = Date.now()
  const cacheKey = `${workingDir}:${sinceUnixSec ?? ''}:${configDir ?? ''}`
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.value
  let value: string | null = null
  try {
    const dir = projectsDirFor(workingDir, configDir)
    if (!existsSync(dir)) {
      cache.set(cacheKey, { value: null, expiresAt: now + TTL_MS })
      return null
    }
    const jsonls = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    if (jsonls.length === 0) {
      cache.set(cacheKey, { value: null, expiresAt: now + TTL_MS })
      return null
    }
    value = lastAnswerInTranscript<string>(`active-model:${sinceUnixSec ?? ''}`, join(dir, jsonls[0].f), (entry) => {
      const model = entry?.message?.model
      if (typeof model !== 'string' || model.startsWith('<')) return undefined
      if (sinceUnixSec !== undefined) {
        const ts = entry?.timestamp
        if (typeof ts !== 'string') return undefined
        const lineUnix = Math.floor(new Date(ts).getTime() / 1000)
        if (!Number.isFinite(lineUnix) || lineUnix < sinceUnixSec) return undefined
      }
      return model
    })
  } catch { /* fall through */ }
  cache.set(cacheKey, { value, expiresAt: now + TTL_MS })
  return value
}

// Like readActiveModelFromProjectDir, but also says WHEN that assistant line
// was written. The model a status shows is only as fresh as the last turn: a
// /model sent after it has not been measured yet (ELSOKOR922 Phase 7 A-smoke:
// the hold reverted to sonnet at 14:52, /model at 14:53 still read "opus" from
// the 14:47 turn, with nothing saying the reading was stale).
export function readLastAssistantModel(workingDir: string, configDir?: string): { model: string; atMs: number } | null {
  try {
    const dir = projectsDirFor(workingDir, configDir)
    if (!existsSync(dir)) return null
    const newest = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0]
    if (!newest) return null
    const lines = readFileSync(join(dir, newest.f), 'utf-8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const entry = JSON.parse(line)
        const model = entry?.message?.model
        if (typeof model !== 'string' || model.startsWith('<')) continue
        const atMs = typeof entry?.timestamp === 'string' ? new Date(entry.timestamp).getTime() : NaN
        if (!Number.isFinite(atMs)) continue
        return { model, atMs }
      } catch { /* skip malformed JSON line */ }
    }
  } catch { /* fall through */ }
  return null
}

const TURN_TAIL_BYTES = 512 * 1024

// Epoch ms of the last TURN line (type user / assistant) in the newest
// transcript; null = no transcript or no such line in the tail. Unlike the
// file mtime, bookkeeping lines do not count: Claude Code writes a
// queue-operation, a "UserPromptSubmit operation blocked by hook" system line
// and last-prompt / title metadata for every prompt a hook blocks, so an owner
// command made the transcript look "active" by its own blocked prompt
// (ELSOKOR922 Phase 7 A-smoke: /model refused "transcript-active (0s)").
// A running turn writes user (tool_result) and assistant lines, so the gap
// between two tool calls -- what the quiet window guards -- still counts.
// A local slash command (/model, /effort, /clear sent into the pane) writes
// `user` lines -- "<command-name>/model</command-name>..." and
// "<local-command-stdout>Set model to ...</local-command-stdout>" -- but no model
// turn runs. Counted as activity they made every write within 20 s of our own
// previous /model read "turn-active" (measured on the test bot, 2026-09-23).
function isLocalCommandLine(e: { type?: unknown; message?: { content?: unknown } }): boolean {
  if (e.type !== 'user') return false
  const c = e.message?.content
  return typeof c === 'string' && /^\s*<(local-command-(stdout|stderr|caveat)|command-name)>/.test(c)
}

export function readLastTurnActivityMs(workingDir: string, configDir?: string): number | null {
  try {
    const dir = projectsDirFor(workingDir, configDir)
    if (!existsSync(dir)) return null
    const newest = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs, size: statSync(join(dir, f)).size }))
      .sort((a, b) => b.mtime - a.mtime)[0]
    if (!newest) return null
    const fd = openSync(join(dir, newest.f), 'r')
    let text: string
    try {
      const len = Math.min(newest.size, TURN_TAIL_BYTES)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, newest.size - len)
      text = buf.toString('utf-8')
    } finally { closeSync(fd) }
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line.startsWith('{')) continue
      try {
        const e = JSON.parse(line)
        if (e?.type !== 'user' && e?.type !== 'assistant') continue
        if (isLocalCommandLine(e)) continue
        const at = typeof e.timestamp === 'string' ? new Date(e.timestamp).getTime() : NaN
        if (Number.isFinite(at)) return at
      } catch { /* a line cut by the tail window, or malformed */ }
    }
    // The WHOLE file was read and holds no turn: a fresh session (after a
    // deploy or /clear) that has only bookkeeping lines. That is "never had a
    // turn" -- quiet -- not "unknown". Returning null here made the caller
    // fall back to the file's mtime, which every hook-blocked command bumps,
    // so commands typed in a row kept each other "turn-active" (measured on
    // the test bot, 2026-09-23). A file larger than the window stays null.
    if (newest.size <= TURN_TAIL_BYTES) return 0
  } catch { /* fall through */ }
  return null
}

const ctxCache = new Map<string, { value: number | null; expiresAt: number }>()

// Current context size of the live session, in tokens. Claude Code records a
// `usage` object on each assistant turn; the context that gets re-read every
// turn is input_tokens + cache_read_input_tokens + cache_creation_input_tokens
// (output_tokens is the new reply, not context). We scan the newest transcript
// from the end for the last turn carrying a usage and sum those three. Returns
// null when there is no transcript / no usage yet (fresh session). This is what
// the dashboard surfaces so the operator can see a session growing heavy and
// decide to restart it.
export function readContextTokensFromProjectDir(workingDir: string, configDir?: string): number | null {
  const now = Date.now()
  const cacheKey = `${workingDir}:${configDir ?? ''}`
  const cached = ctxCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.value
  let value: number | null = null
  try {
    const dir = projectsDirFor(workingDir, configDir)
    if (existsSync(dir)) {
      const jsonls = readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      if (jsonls.length > 0) {
        value = lastAnswerInTranscript<number>('context-tokens', join(dir, jsonls[0].f), (entry) => {
          const u = entry?.message?.usage
          if (!u || typeof u !== 'object') return undefined
          const inp = Number(u.input_tokens) || 0
          const cr = Number(u.cache_read_input_tokens) || 0
          const cc = Number(u.cache_creation_input_tokens) || 0
          const total = inp + cr + cc
          return total > 0 ? total : undefined
        })
      }
    }
  } catch { /* fall through */ }
  ctxCache.set(cacheKey, { value, expiresAt: now + TTL_MS })
  return value
}

/**
 * Wall-clock mtime (ms) of the newest transcript for a working dir, or null
 * when there is none (fresh session, unreadable dir, agent on a remote host).
 *
 * This is the cheapest "when did this session last do anything" signal, and
 * the honest one: Claude Code appends to the jsonl on every turn, so the
 * file's mtime is written BY the session, outside the dashboard process. A
 * clock kept in dashboard memory dies with the dashboard, and a
 * count-the-sweeps streak measures the sweep interval rather than the agent.
 * Neither survives a restart; this does.
 *
 * What it does NOT measure: whether the agent is working right now. A single
 * long tool call (a 30-minute Bash, a subagent) appends nothing while it runs,
 * so the transcript goes quiet while real work is in flight. Callers must pair
 * this with a live-work signal -- the guard uses paneIdle -- and never treat a
 * stale mtime on its own as "finished".
 *
 * The mtime is already computed inside readContextTokensFromProjectDir to pick
 * the newest file; this exposes it rather than recomputing the selection
 * differently, so the two always describe the SAME transcript.
 */
export function readTranscriptMtimeFromProjectDir(workingDir: string, configDir?: string): number | null {
  try {
    const dir = projectsDirFor(workingDir, configDir)
    if (!existsSync(dir)) return null
    let newest: number | null = null
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const m = statSync(join(dir, f)).mtimeMs
      if (newest === null || m > newest) newest = m
    }
    return newest
  } catch { return null }
}

/**
 * Newest transcript mtime for `workingDir` across SEVERAL candidate config
 * roots, or null when no candidate has one.
 *
 * Same "probe every root, newest wins" rule the inbound probe uses, and for the
 * same reason: whether a session writes under the shared ~/.claude or under an
 * isolated CLAUDE_CONFIG_DIR is decided by gates (settings, fleet token, dir
 * existence) that a watchdog must not try to re-derive. A root that is not in
 * use simply yields an older timestamp or none.
 *
 * An `undefined` entry means the shared ~/.claude default, so a caller that
 * already has a single known root can pass `[root]` and get the old behaviour.
 */
export function readTranscriptMtimeAcrossConfigDirs(
  workingDir: string,
  configDirs: ReadonlyArray<string | undefined>,
): number | null {
  let newest: number | null = null
  for (const configDir of configDirs) {
    const m = readTranscriptMtimeFromProjectDir(workingDir, configDir)
    if (m != null && (newest === null || m > newest)) newest = m
  }
  return newest
}

/**
 * Epoch ms of the newest REAL conversation event in `workingDir`'s transcript,
 * or null when no timestamped line can be found.
 *
 * WHY THIS EXISTS AND WHY mtime IS NOT IT (GATEMTIME922, measured 2026-09-22):
 * Claude Code appends more than conversation to the .jsonl. Bookkeeping records
 * (atis-latch, mode, last-prompt, custom-title, agent-name,
 * file-history-snapshot, artifact-autoreact-ledger) are written while a session
 * sits completely idle, and they carry NO `timestamp` field. The file therefore
 * keeps growing when nobody is working: measured on Willy's transcript, the
 * last real turn was 11:35:56 while mtime read 12:24:19 and was still climbing
 * (10404001 -> 10404348 bytes under observation).
 *
 * The consequence is not "the gate waits a bit longer". The restart gate blocks
 * while msSinceTranscriptWrite < transcriptQuietMs, so a signal that never goes
 * quiet is a gate that NEVER opens: Willy's was blocked 240 minutes with no
 * stuck work at all. The mtime measurement was never wrong about the FILE; it
 * answered a different question than the one the gate asks.
 *
 * Reads a bounded tail rather than the whole file: transcripts here run to tens
 * of megabytes and this is called on every gate tick. The first (likely
 * partial) line of the tail is dropped. Lines are JSON-parsed and only a
 * TOP-LEVEL `timestamp` counts, so an ISO date quoted inside message text
 * cannot masquerade as activity.
 */
/** Above this a transcript is read by tail only; see the widening passes below. */
const MAX_FULL_READ_BYTES = 64 * 1024 * 1024

export function readLastConversationTsFromProjectDir(
  workingDir: string,
  configDir?: string,
  tailBytes = 512 * 1024,
): number | null {
  try {
    const dir = projectsDirFor(workingDir, configDir)
    if (!existsSync(dir)) return null
    let newestFile: string | null = null
    let newestMtime = -1
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const m = statSync(join(dir, f)).mtimeMs
      if (m > newestMtime) { newestMtime = m; newestFile = join(dir, f) }
    }
    if (newestFile === null) return null

    const size = statSync(newestFile).size
    // Widening passes: a long tool-result burst can push every timestamped line
    // out of a small tail, and a tail that happens to contain no turn is NOT
    // evidence that the session has none. The last pass reads the whole file,
    // but only below MAX_FULL_READ_BYTES -- past that the caller's logged mtime
    // fallback is cheaper than stalling a watchdog tick on a huge read.
    const passes = [tailBytes, tailBytes * 8, tailBytes * 64]
    if (size <= MAX_FULL_READ_BYTES) passes.push(size)
    for (const want of passes) {
      const start = Math.max(0, size - want)
      const fd = openSync(newestFile, 'r')
      let buf: Buffer
      try {
        const len = size - start
        buf = Buffer.alloc(len)
        readSync(fd, buf, 0, len, start)
      } finally { closeSync(fd) }

      const lines = buf.toString('utf-8').split('\n')
      if (start > 0) lines.shift()   // partial first line
      let newest: number | null = null
      for (const line of lines) {
        if (!line.startsWith('{')) continue
        let o: Record<string, unknown>
        try { o = JSON.parse(line) as Record<string, unknown> } catch { continue }
        const ts = o.timestamp
        if (typeof ts !== 'string') continue
        const ms = Date.parse(ts)
        if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms
      }
      if (newest !== null) return newest
      if (start === 0) break   // already read the whole file
    }
    return null
  } catch { return null }
}
