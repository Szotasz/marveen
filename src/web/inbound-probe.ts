/**
 * Inbound-probe: active deafness watchdog for the main main channels session.
 *
 * Architecture note: the actual Telegram ping is sent by a Python script
 * (scripts/watchdog-inbound-prober.py) using the existing telethon session.
 * Rationale: telethon's asyncio event loop, StringSession handling, and
 * FloodWait back-off are already Python-shaped (see watchdog-userbot-login.py).
 * Re-implementing MTProto session handling in TS for a 30-line prober is
 * disproportionate. This TS module manages the Python prober's lifecycle and
 * implements the pure decision logic.
 *
 * MANUAL GATE: the prober account must be /telegram:access allowlisted by
 * the operator before the probe pings reach the main session. Until then the
 * Python prober's sends still succeed and write the probe-last-sent marker,
 * but the channel plugin drops the pings. The allowlist is not something the
 * prober can see: it exits 0 (no-op) only when it cannot run at all (missing
 * credentials, session or owner chat, an unauthorised telethon session, a
 * connection error). No respawn is triggered by
 * the TS side when the session file is absent, nor before a probe
 * ping has been seen arriving in the transcript at least once (see
 * decideProbeTick). At most DEAFNESS_RESPAWN_LOOP_MAX respawns happen
 * without a probe ping being heard in between before the check disarms
 * itself, and at most DEAFNESS_RESPAWN_DAY_MAX respawns happen in any
 * rolling DEAFNESS_RESPAWN_DAY_WINDOW_MS whatever was heard in between (a
 * due respawn beyond that holds until the oldest of them leaves the window).
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import { readEnvFile } from '../env.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { resolveOwnerChatId } from '../owner-chat.js'
import { projectsDirFor } from './active-model.js'
import { capturePane, resolveMainAgentRotatedConfigDir } from './agent-process.js'
import type { PaneState } from '../pane-state.js'

// Mirrors KEEPALIVE_RESPAWN_GRACE_MS from channel-monitor.ts (15 min).
// Not imported directly to avoid a circular module dependency: channel-monitor.ts
// lazy-imports inbound-probe.ts; inbound-probe.ts uses dynamic import() of
// channel-monitor.ts to call hardRestartMarveenChannels at respawn time.
const RESPAWN_GRACE_MS = 15 * 60 * 1000

const SESSION_FILE = join(PROJECT_ROOT, 'store', '.watchdog-userbot.session')
const PROBE_LAST_SENT_FILE = join(PROJECT_ROOT, 'store', '.watchdog-probe-last-sent')
const VENV_PYTHON = join(PROJECT_ROOT, '.watchdog-venv', 'bin', 'python3')
const PROBER_SCRIPT = join(PROJECT_ROOT, 'scripts', 'watchdog-inbound-prober.py')

// Transcript directory for the main channels session JSONL files. Claude Code
// encodes a project dir by replacing every character outside [a-zA-Z0-9-]
// with '-' (measured, src/claude-project-dir.ts) --
// see projectsDirFor in active-model.ts, the canonical encoder already relied
// on by schedule-runner and the context-guard/restart-gate watchdogs. A
// hand-rolled slash-only encoder here
// used to disagree with it on any PROJECT_ROOT containing another separator
// Claude Code also encodes (e.g. a dot in the username), which made this
// constant point at a directory Claude Code never creates -- see the
// 866da985 postmortem below mainTranscriptDirs().
//
// Kept as the SHARED-ROOT candidate only; every caller must go through
// mainTranscriptDirs() instead -- see the comment there.
export const TRANSCRIPT_DIR = projectsDirFor(PROJECT_ROOT, join(process.env.HOME ?? homedir(), '.claude'))

// CONFIG-DIR BLIND SPOT (2026-09-11, ~2h of false keepalive respawns): the
// constant above assumes the main channels agent writes its transcript under the
// SHARED ~/.claude. That stopped being true the moment main-agent config
// isolation shipped -- with MAIN_AGENT_ISOLATED_CONFIG=1 the session runs with
// CLAUDE_CONFIG_DIR=<PROJECT_ROOT>/.channels-config, so its JSONL lands in
// <PROJECT_ROOT>/.channels-config/projects/<encoded-cwd>/ and the watchdogs read
// an empty (or frozen) directory forever. Two things break at once:
//   - refreshKeepaliveFromInbound() never sees live traffic, so a BUSY
//     conversation ages the keepalive file out (the scheduled edit_message
//     keep-alive is busy-skipped exactly then) and the staleness watchdog
//     respawn-panes the running conversation away;
//   - the inbound probe reads lastIngestionTs as null/stale and can declare
//     deafness on a perfectly healthy channel.
// Rather than re-deriving the isolation gates here (settings + fleet token +
// dir existence -- three places to drift out of sync), we probe EVERY
// candidate root and take the newest ingestion across them. A root that is
// not in use simply yields an older timestamp or none, and "newest wins" is
// exactly the question being asked.
// The CONFIG ROOTS (not the projects/ subdirs) the main agent may be writing
// its transcript under. Exported separately from mainTranscriptDirs() because
// not every caller wants the main agent's own cwd: the schedule runner asks the
// same question about a task it injected, and needs the roots so it can join
// them with ITS working dir. Keeping the isolation knowledge in one function is
// the whole point -- a second copy is what produced the schedule-runner blind
// spot this list was already supposed to prevent (2026-09-14).
export function mainConfigRoots(): string[] {
  const roots = [
    join(process.env.HOME ?? homedir(), '.claude'),
    join(PROJECT_ROOT, '.channels-config'),
  ]
  // An operator-set MAIN_AGENT_CONFIG_DIR (a separate Claude login for the bot)
  // wins over both defaults, so it must be a candidate too. Read defensively:
  // the settings store must never be able to break a watchdog tick.
  try {
    let raw = String(getEffectiveSettingValue('MAIN_AGENT_CONFIG_DIR') ?? '').trim()
    if (raw) {
      if (raw.startsWith('~')) raw = join(homedir(), raw.slice(1))
      roots.push(raw)
    }
  } catch {
    // keep the defaults
  }
  return [...new Set(roots)]
}

// POSTMORTEM (866da985, 2026-09-20): this used to encode PROJECT_ROOT with a
// local `PROJECT_ROOT.replace(/\//g, '-')` that only strips slashes, while
// Claude Code itself also replaces dots with '-' (the character class is
// `[/.]`, not `/` alone). On this host PROJECT_ROOT is
// /Users/a.kobza/marveen -- the dot in the username meant the computed directory
// (.../-Users-a.kobza-marveen) never existed on disk (the real one is
// .../-Users-a-kobza-marveen), so readLastIngestionTimestampAcross() always
// returned null. shouldRefreshKeepaliveFromInbound() is `lastInboundTs !=
// null && ...`, so it was permanently false: refreshKeepaliveFromInbound()
// never advanced store/.channel-keepalive's mtime, no matter how much real
// Telegram traffic or inter-agent processing occurred. The file aged out
// past KEEPALIVE_STALE_MS forever, and once past KEEPALIVE_RESPAWN_GRACE_MS
// (15 min) the very next non-busy poll tick force-respawned the session --
// measured live at 63 respawns in one day, each one wiping the running
// conversation (memory/kanban survive; the live turn does not). Fixed by
// reusing projectsDirFor(), the same encoder schedule-runner and the
// context-guard/restart-gate watchdogs already trust for this exact
// question -- see the 09-11 CONFIG-DIR BLIND SPOT comment above for why a
// second hand-rolled copy of this logic is exactly how this kind of bug
// hides for months on hosts whose username has no dot in it.
export function mainTranscriptDirs(): string[] {
  const dirs = mainConfigRoots().map(root => projectsDirFor(PROJECT_ROOT, root))
  return [...new Set(dirs)]
}

// The transcript dirs the deafness check scans: mainTranscriptDirs() plus the
// active rotated plan's own config dir (configDir-mode plan under
// MAIN_AGENT_ISOLATED_CONFIG=1 with 2+ plans). The launcher exports that dir
// as CLAUDE_CONFIG_DIR (scripts/main-agent-isolated-config.mjs, "rotated"),
// so the hub's transcript lives there while the plan is active; a check that
// does not read it sees no ingestion on a healthy hub. Resolved with the
// launcher's own resolver, so the gating cannot drift. Kept local to the
// probe on purpose: mainConfigRoots() feeds other readers too.
// A dir reached through two paths (a symlinked root) is harmless here: the
// scan takes the newest record across dirs, and countTranscriptWritersSince
// counts files by real path.
// Every rotated dir resolved during this process stays in the scan (`seen`).
// The launcher resolves the dir once, at hub start, but the plan store can
// change under a running hub without a restart (a plan deleted or its
// configDir edited, the isolation flag turned off, a rotation whose restart
// failed). Reading only the currently resolved dir would then miss the live
// transcript and restart a healthy hub. A dir that is no longer written can
// only add a writer to the ambiguity count (a hold), never hide one.
const rotatedDirsSeen = new Set<string>()

export function probeTranscriptDirs(seen: Set<string> = rotatedDirsSeen): string[] {
  const dirs = mainTranscriptDirs()
  try {
    const rotated = resolveMainAgentRotatedConfigDir()
    if (rotated) seen.add(projectsDirFor(PROJECT_ROOT, rotated))
  } catch {
    // keep the others
  }
  dirs.push(...seen)
  return [...new Set(dirs)]
}

// Newest inbound-channel ingestion across every candidate transcript root.
// Returns null only when NO candidate has one.
export function readLastIngestionTimestampAcross(dirs: string[]): number | null {
  return scanIngestionAcross(dirs).lastTs
}

// Same as readLastIngestionTimestampAcross, plus the newest probe ping seen.
// sinceMs: see scanIngestion.
export function scanIngestionAcross(dirs: string[], sinceMs?: number, maxBytes?: number): IngestionScan {
  let lastTs: number | null = null
  let lastProbeTs: number | null = null
  let truncated = false
  for (const dir of dirs) {
    const scan = scanIngestion(dir, sinceMs, maxBytes)
    if (scan.lastTs != null && (lastTs == null || scan.lastTs > lastTs)) lastTs = scan.lastTs
    if (scan.lastProbeTs != null && (lastProbeTs == null || scan.lastProbeTs > lastProbeTs)) lastProbeTs = scan.lastProbeTs
    if (scan.truncated) truncated = true
  }
  return truncated ? { lastTs, lastProbeTs, truncated: true } : { lastTs, lastProbeTs }
}

// N3: named constant for the probe timeout multiplier.
// probeTimeoutMs = probeIntervalMs * PROBE_TIMEOUT_MULTIPLIER (allow 2x interval before declaring deaf).
const PROBE_TIMEOUT_MULTIPLIER = 2

// W4: env-derived values cached once at startInboundProber() startup.
// Reading .env from disk every tick is unnecessary and wasteful.
let _cachedProbeIntervalMs: number | null = null
let _cachedAllowedChatId: string | null | undefined = undefined // undefined = not yet read

// W3: one-shot flags to avoid repeating "session missing" / "ALLOWED_CHAT_ID absent" warnings every tick.
let _warnedSessionMissing = false
let _warnedChatIdAbsent = false

let proberProcess: ChildProcess | null = null

// Deafness check state, advanced by runInboundProbeTick. In memory only: a
// dashboard restart forgets the pending probe, the probeHeard latch and the
// respawn counts, and
// the latch re-arms only when a probe ping is found in the scanned transcript
// tail (see the startInboundProber docstring). lastInboundRespawn is separate
// from marveenLastKeepaliveRespawn in channel-monitor.ts so the two paths do
// not interfere with each other's grace windows.
let probeLoopState: ProbeLoopState = { tick: { pendingSince: null, probeHeard: false, disarmedAt: 0, respawnTimes: [], dayRespawnTimes: [] }, lastInboundRespawn: 0, warnedAmbiguous: false }

// Mirrors the message prefix written by scripts/watchdog-inbound-prober.py.
export const PROBE_PING_PREFIX = '__wd_ping'

const CHANNEL_TAG = '<channel source='

// The prober sends exactly `__wd_ping <UTC ISO timestamp, milliseconds, Z>`
// (scripts/watchdog-inbound-prober.py: f"__wd_ping {ts_iso}"). Only a channel
// block whose whole body (trimmed) has that shape is a probe ping: an owner
// message that mentions, quotes or extends the marker must not arm the check.
const CHANNEL_BLOCK_RE = /<channel source=[^>]*>([\s\S]*?)<\/channel>/g
const PROBE_PING_BODY_RE = /^__wd_ping \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** Pure: whether inbound text carries a probe ping sent by the prober. */
export function isProbePing(text: string): boolean {
  for (const m of text.matchAll(CHANNEL_BLOCK_RE)) {
    if (PROBE_PING_BODY_RE.test(m[1].trim())) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Pure exported functions
// ---------------------------------------------------------------------------

/**
 * Pure decision: should the watchdog trigger a deafness respawn?
 *
 * @param markerTs         When the __wd_ping was sent (ms since epoch).
 * @param lastIngestionTs  When the most recent <channel source= ingestion was
 *                         seen in the session transcript, or null if no
 *                         ingestion has been recorded yet.
 * @param probeTimeoutMs   Inactivity window after which we declare deaf.
 * @param nowMs            Current wall-clock time (ms since epoch).
 *
 * Returns true (trigger respawn) when:
 *   - nowMs - markerTs >= probeTimeoutMs (the timeout has elapsed), AND
 *   - lastIngestionTs is null OR lastIngestionTs < markerTs
 *     (no ingestion has been seen since the marker was sent).
 *
 * Returns false in all other cases.
 */
export function shouldTriggerDeafnessRespawn(opts: {
  markerTs: number
  lastIngestionTs: number | null
  probeTimeoutMs: number
  nowMs: number
}): boolean {
  const { markerTs, lastIngestionTs, probeTimeoutMs, nowMs } = opts
  if (nowMs - markerTs < probeTimeoutMs) return false
  return lastIngestionTs == null || lastIngestionTs < markerTs
}

/**
 * Pure: the send time of the oldest probe that is still unanswered, to be
 * passed to shouldTriggerDeafnessRespawn as its markerTs.
 *
 * @param pendingSince     The previous result (null on the first tick).
 * @param markerTs         The prober's last-sent marker as read this tick.
 * @param lastIngestionTs  The newest inbound ingestion, or null.
 *
 * An ingestion at or after a probe answers it. A pending probe is kept while
 * later probes are sent unanswered, so the clock does not restart with every
 * send. Returns null when the latest probe is answered too.
 */
export function nextPendingProbe(
  pendingSince: number | null,
  markerTs: number,
  lastIngestionTs: number | null,
): number | null {
  const answered = (ts: number): boolean => lastIngestionTs != null && lastIngestionTs >= ts
  if (pendingSince != null && !answered(pendingSince)) return pendingSince
  return answered(markerTs) ? null : markerTs
}

/**
 * Pure: the text of a transcript record that is a genuine inbound prompt, or
 * null. Inbound reaches the transcript in three shapes:
 *   - a `user` record whose message content is a string or text parts (an
 *     idle session);
 *   - an `attachment` record of type `queued_command` (a message that arrived
 *     mid-turn);
 *   - a `queue-operation` record with operation `enqueue`: the session has
 *     RECEIVED the message. During one long tool call this is the only trace
 *     until the call ends (the queued_command line is written at the next tool
 *     boundary, minutes later), so it must count as heard, or a busy hub in a
 *     long command reads as deaf. Whether the message was later processed or
 *     removed unprocessed is a different question from deafness.
 * A `user` record carrying a tool_result (even next to a text part), assistant
 * text and every other record type are not inbound, even when they quote a
 * channel tag.
 */
export function inboundRecordText(obj: unknown): string | null {
  if (obj == null || typeof obj !== 'object') return null
  const rec = obj as {
    type?: unknown
    message?: { content?: unknown }
    attachment?: { type?: unknown; prompt?: unknown }
  }
  if (rec.type === 'user') {
    const content = rec.message?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return null
    const parts: string[] = []
    for (const p of content) {
      if (p == null || typeof p !== 'object') continue
      const part = p as { type?: unknown; text?: unknown }
      if (part.type === 'tool_result') return null
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    }
    return parts.length > 0 ? parts.join('\n') : null
  }
  if (rec.type === 'attachment' && rec.attachment?.type === 'queued_command') {
    return typeof rec.attachment.prompt === 'string' ? rec.attachment.prompt : null
  }
  if (rec.type === 'queue-operation') {
    const q = obj as { operation?: unknown; content?: unknown }
    return q.operation === 'enqueue' && typeof q.content === 'string' ? q.content : null
  }
  return null
}

export interface IngestionScan {
  // Newest inbound channel record (ms since epoch), or null.
  lastTs: number | null
  // Newest inbound channel record carrying a probe ping, or null.
  lastProbeTs: number | null
  // Set only when a sinceMs scan hit BACKSCAN_MAX_BYTES in some file before
  // reaching records older than sinceMs: an ingestion may have been missed.
  truncated?: true
}

// Every read keeps at least the last 256 KB of a transcript. With a sinceMs
// (the deafness check) the read extends backwards in BACKSCAN_CHUNK_BYTES
// steps until it reaches a record stamped more than BACKSCAN_SLACK_MS before
// sinceMs, the file start, or BACKSCAN_MAX_BYTES. A busy hub appends MBs
// between two probes; a fixed tail would lose the ingestion that answered
// the probe and report a healthy hub as deaf. The slack covers records that
// are written later than they are stamped: a queued_command line carries the
// arrival time and is written at the next tool boundary, which can be
// minutes later. The BACKSCAN_MAX_BYTES window therefore counts from about
// BACKSCAN_SLACK_MS before sinceMs (plus up to one step), not from sinceMs.
export const TAIL_BYTES = 262144 // 256 KB
export const BACKSCAN_CHUNK_BYTES = 1024 * 1024
export const BACKSCAN_MAX_BYTES = 32 * 1024 * 1024
export const BACKSCAN_SLACK_MS = 15 * 60 * 1000

/**
 * Pure: the offset a transcript of `size` bytes is read from.
 * `firstTsFrom(offset)` returns the timestamp of the first complete record
 * at or after `offset` (null when none is found nearby). Without sinceMs it is
 * the plain tail. truncated: the cap was hit before the anchor was reached.
 */
export function backscanStart(
  size: number,
  sinceMs: number | undefined,
  firstTsFrom: (offset: number) => number | null,
  opts: { tailBytes?: number; chunkBytes?: number; maxBytes?: number; slackMs?: number } = {},
): { start: number; truncated: boolean } {
  const tailBytes = opts.tailBytes ?? TAIL_BYTES
  const chunkBytes = opts.chunkBytes ?? BACKSCAN_CHUNK_BYTES
  const maxBytes = opts.maxBytes ?? BACKSCAN_MAX_BYTES
  const slackMs = opts.slackMs ?? BACKSCAN_SLACK_MS
  let start = Math.max(0, size - tailBytes)
  if (sinceMs == null) return { start, truncated: false }
  while (start > 0) {
    const ts = firstTsFrom(start)
    if (ts != null && ts < sinceMs - slackMs) return { start, truncated: false }
    if (size - start >= maxBytes) return { start, truncated: true }
    start = Math.max(0, start - chunkBytes, size - maxBytes)
  }
  return { start: 0, truncated: false }
}

/**
 * Scan the newest JSONL session file for the most recent inbound-channel
 * ingestion. Returns the timestamp (ms since epoch) of the last inbound
 * record (see inboundRecordText) containing `<channel source=`, or null if
 * none found.
 *
 * The "newest" file is determined by mtime: stat all *.jsonl under
 * transcriptDir, pick the one with the highest mtime. This is the main
 * session's active log. Returns null when the directory does not exist or
 * no JSONL files are present.
 *
 * NOTE: Do NOT log line contents — JSONL lines may contain full Telegram
 * message text (PII). Only the extracted timestamp is ever logged.
 */
export function readLastIngestionTimestamp(transcriptDir: string): number | null {
  return scanIngestion(transcriptDir).lastTs
}

// readLastIngestionTimestamp plus the newest probe ping among those records.
//
// sinceMs (optional): also scan every *.jsonl modified at or after sinceMs,
// not only the newest one, and take the newest record across them. Another
// Claude Code session started in the same working dir writes into the same
// directory; while its file is the newest, the hub's own file would otherwise
// not be read at all. An ingestion at or after sinceMs is a write at or after
// sinceMs, so this cannot miss one. The newest file is read in any case, even
// when it was last written before sinceMs: the arming ping a deaf, silent hub
// last heard lives there, and after a dashboard restart it is what re-arms the
// check (see the startInboundProber docstring). With sinceMs each file is
// also read back to sinceMs, not only its last 256 KB (see backscanStart);
// the result is marked truncated when maxBytes stopped that read first.
export function scanIngestion(transcriptDir: string, sinceMs?: number, maxBytes: number = BACKSCAN_MAX_BYTES): IngestionScan {
  const none: IngestionScan = { lastTs: null, lastProbeTs: null }
  try {
    if (!existsSync(transcriptDir)) return none
    const entries = readdirSync(transcriptDir).filter(f => f.endsWith('.jsonl'))
    if (entries.length === 0) return none

    // Pick the newest file by mtime (plus, with sinceMs, every recent one).
    let newestFile = ''
    let newestMtime = 0
    const files = new Set<string>()
    for (const entry of entries) {
      const fullPath = join(transcriptDir, entry)
      try {
        const st = statSync(fullPath)
        if (st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs
          newestFile = fullPath
        }
        if (sinceMs != null && st.mtimeMs >= sinceMs) files.add(fullPath)
      } catch {
        // file disappeared between readdir and stat — skip
      }
    }
    if (!newestFile) return none
    files.add(newestFile)

    let lastTs: number | null = null
    let lastProbeTs: number | null = null
    let truncated = false
    for (const file of files) {
      const scan = scanTranscriptFile(file, sinceMs, maxBytes)
      if (scan.lastTs != null && (lastTs == null || scan.lastTs > lastTs)) lastTs = scan.lastTs
      if (scan.lastProbeTs != null && (lastProbeTs == null || scan.lastProbeTs > lastProbeTs)) lastProbeTs = scan.lastProbeTs
      if (scan.truncated) truncated = true
    }
    return truncated ? { lastTs, lastProbeTs, truncated: true } : { lastTs, lastProbeTs }
  } catch {
    return none
  }
}

// The top-level timestamp of the first complete record at or after `offset`
// (with offset > 0, after the partial line the offset falls into), or null
// when none is found within `limit` bytes. Reads 256 KB at a time and keeps
// reading while a record is longer than that. Parsed, not pattern-matched: a
// record can carry nested objects with their own, older "timestamp" fields.
export function firstRecordTsFrom(fd: number, offset: number, size: number, limit: number = BACKSCAN_MAX_BYTES): number | null {
  const WINDOW = 262144
  let pos = offset
  let pending = Buffer.alloc(0)
  let skipPartial = offset > 0
  while (pos < size && pos - offset < limit) {
    const len = Math.min(WINDOW, size - pos, offset + limit - pos)
    const buf = Buffer.allocUnsafe(len)
    readSync(fd, buf, 0, len, pos)
    pos += len
    pending = pending.length > 0 ? Buffer.concat([pending, buf]) : buf
    let nl: number
    while ((nl = pending.indexOf(0x0a)) >= 0) {
      const line = pending.subarray(0, nl)
      pending = pending.subarray(nl + 1)
      if (skipPartial) { skipPartial = false; continue }
      try {
        const obj = JSON.parse(line.toString('utf-8')) as { timestamp?: unknown }
        if (typeof obj.timestamp !== 'string') continue
        const ts = new Date(obj.timestamp).getTime()
        if (Number.isFinite(ts)) return ts
      } catch {
        // not a whole record -- try the next line
      }
    }
  }
  return null
}

function scanTranscriptFile(file: string, sinceMs: number | undefined, maxBytes: number): IngestionScan {
  try {
    // B1 fix: never read a whole transcript that has grown to 100s of MB; see
    // backscanStart for how far back a read goes.
    const fd = openSync(file, 'r')
    let rawText: string
    let readOffset = 0
    let truncated = false
    try {
      const fileSize = statSync(file).size
      const from = backscanStart(fileSize, sinceMs, (offset) => firstRecordTsFrom(fd, offset, fileSize, maxBytes), { maxBytes })
      readOffset = from.start
      truncated = from.truncated
      const readLength = fileSize - readOffset
      const buf = Buffer.allocUnsafe(readLength)
      readSync(fd, buf, 0, readLength, readOffset)
      rawText = buf.toString('utf-8')
    } finally {
      // fd is always closed — openSync never leaves a dangling descriptor
      closeSync(fd)
    }

    // Drop a possibly-partial first line only when we started mid-file; a
    // whole-file read starts with a complete record.
    const firstNewline = rawText.indexOf('\n')
    const trimmed = readOffset > 0 && firstNewline >= 0 ? rawText.slice(firstNewline + 1) : rawText
    const lines = trimmed.split('\n')
    let lastTs: number | null = null
    let lastProbeTs: number | null = null
    for (const line of lines) {
      if (!line.includes(CHANNEL_TAG)) continue
      try {
        const obj = JSON.parse(line) as { timestamp?: unknown }
        const text = inboundRecordText(obj)
        if (text == null || !text.includes(CHANNEL_TAG)) continue
        if (typeof obj.timestamp === 'string') {
          const ts = new Date(obj.timestamp).getTime()
          if (Number.isFinite(ts)) {
            if (lastTs == null || ts > lastTs) lastTs = ts
            if (isProbePing(text) && (lastProbeTs == null || ts > lastProbeTs)) lastProbeTs = ts
          }
        }
      } catch {
        // malformed line — skip, do not abort
      }
    }
    return truncated ? { lastTs, lastProbeTs, truncated: true } : { lastTs, lastProbeTs }
  } catch {
    return { lastTs: null, lastProbeTs: null }
  }
}

/**
 * How many distinct transcript files under `dirs` were written at or after
 * `sinceMs`. Two candidate roots can be the same directory (a symlinked
 * projects dir), so files are counted by real path.
 *
 * More than one means another Claude Code session shares the hub's working
 * dir. Nothing on this code path can tell which file is the hub's, so the
 * deafness respawn holds (see deafnessRespawnHold): a missed deafness is far
 * cheaper than killing a healthy hub.
 */
export function countTranscriptWritersSince(dirs: string[], sinceMs: number): number {
  const seen = new Set<string>()
  for (const dir of dirs) {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { continue }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const fullPath = join(dir, entry)
      try {
        if (statSync(fullPath).mtimeMs < sinceMs) continue
        seen.add(realpathSync(fullPath))
      } catch {
        // file disappeared between readdir and stat -- skip
      }
    }
  }
  return seen.size
}

export interface ProbeTickState {
  // Send time of the oldest unanswered probe, or null.
  pendingSince: number | null
  // Latches true once a probe ping stamped after disarmedAt has been seen
  // inbound; cleared when the loop breaker trips.
  probeHeard: boolean
  // Pings stamped at or before this do not arm the check (0 = any ping arms).
  disarmedAt: number
  // Successful deafness respawns since a probe ping was last heard after the
  // latest of them, oldest first (see recordDeafnessRespawn, decideProbeTick).
  respawnTimes: number[]
  // Every successful deafness respawn in the last DEAFNESS_RESPAWN_DAY_WINDOW_MS,
  // oldest first; NOT reset by heard pings (the daily ceiling).
  dayRespawnTimes: number[]
}

export const INITIAL_PROBE_TICK_STATE: ProbeTickState = { pendingSince: null, probeHeard: false, disarmedAt: 0, respawnTimes: [], dayRespawnTimes: [] }

// Loop breaker: a deafness that two hard restarts did not cure (no probe
// ping heard after either) is not one a third restart will cure, and a false
// positive the checks above did not foresee must not turn into a restart loop
// of a healthy hub. Counted by events, not by a time window: a window would
// stop limiting anything once the probe interval makes respawns sparser than
// the window.
export const DEAFNESS_RESPAWN_LOOP_MAX = 2

// Daily ceiling, defence in depth behind the event rule: a hub that is only
// intermittently deaf hears a ping now and then, which resets the event count
// every time, so without a ceiling it would be restarted every grace window
// for ever. At most DEAFNESS_RESPAWN_DAY_MAX respawns in any rolling
// DEAFNESS_RESPAWN_DAY_WINDOW_MS, whatever was heard in between; a due respawn
// beyond that holds until the oldest of them leaves the window.
export const DEAFNESS_RESPAWN_DAY_MAX = 6
export const DEAFNESS_RESPAWN_DAY_WINDOW_MS = 24 * 60 * 60 * 1000

/** Pure: the state after a successful deafness respawn at `atMs`. */
export function recordDeafnessRespawn(state: ProbeTickState, atMs: number): ProbeTickState {
  const day = state.dayRespawnTimes.filter(t => atMs - t < DEAFNESS_RESPAWN_DAY_WINDOW_MS)
  return { ...state, respawnTimes: [...state.respawnTimes, atMs], dayRespawnTimes: [...day, atMs] }
}

/**
 * Pure: one deafness-check tick.
 *
 *   - probeHeard latches on the first inbound probe ping (lastProbeTs)
 *     stamped after disarmedAt. Until then no respawn: the prober account may
 *     simply not be allowlisted yet (the marker is written on every
 *     successful send, the plugin drops the ping later), and a respawn would
 *     not fix that;
 *   - a pending probe in the future (the clock stepped back) restarts at now;
 *   - a probe sent at or before the last deafness respawn was addressed to the
 *     replaced process: it is dropped, and the clock restarts with the next
 *     unanswered probe;
 *   - otherwise the clock runs from the oldest unanswered probe
 *     (nextPendingProbe) and respawn is due after probeTimeoutMs;
 *   - loop breaker: the respawn count resets when a probe ping is heard
 *     (lastProbeTs) after the latest respawn, i.e. the respawn cured the
 *     deafness. When a respawn is due but DEAFNESS_RESPAWN_LOOP_MAX respawns
 *     happened without such a ping, it
 *     returns tripped instead, clears probeHeard and sets disarmedAt = now:
 *     no further respawn until a ping is heard (ingested) after that again.
 *     This also bounds the case the arming latch cannot see, a prober that is
 *     dropped by the allowlist only AFTER it armed the check;
 *   - daily ceiling: when a respawn is due but DEAFNESS_RESPAWN_DAY_MAX
 *     respawns happened within DEAFNESS_RESPAWN_DAY_WINDOW_MS (heard pings do
 *     not reset this), it returns ceilingHeld instead: no respawn, the clock
 *     and the latch stay as they are, and the next due tick after the oldest
 *     of them leaves the window respawns.
 */
export function decideProbeTick(opts: {
  state: ProbeTickState
  markerTs: number
  scan: IngestionScan
  lastRespawnAt: number
  probeTimeoutMs: number
  nowMs: number
}): ProbeTickState & { respawn: boolean; tripped: boolean; ceilingHeld: boolean } {
  const { state, markerTs, scan, lastRespawnAt, probeTimeoutMs, nowMs } = opts
  const probeHeard = state.probeHeard || (scan.lastProbeTs != null && scan.lastProbeTs > state.disarmedAt)
  const latestRespawn = state.respawnTimes[state.respawnTimes.length - 1]
  const cured = latestRespawn != null && scan.lastProbeTs != null && scan.lastProbeTs > latestRespawn
  const respawnTimes = cured ? [] : state.respawnTimes
  const dayRespawnTimes = state.dayRespawnTimes.filter(t => nowMs - t < DEAFNESS_RESPAWN_DAY_WINDOW_MS)
  const base = { probeHeard, disarmedAt: state.disarmedAt, respawnTimes, dayRespawnTimes, tripped: false, ceilingHeld: false }
  let pending = state.pendingSince
  if (pending != null && pending > nowMs) pending = nowMs
  if (pending != null && pending <= lastRespawnAt) pending = null
  if (markerTs <= lastRespawnAt) return { ...base, pendingSince: null, respawn: false }
  pending = nextPendingProbe(pending, markerTs, scan.lastTs)
  if (pending == null) return { ...base, pendingSince: null, respawn: false }
  const timedOut = shouldTriggerDeafnessRespawn({
    markerTs: pending,
    lastIngestionTs: scan.lastTs,
    probeTimeoutMs,
    nowMs,
  })
  if (!timedOut || !probeHeard) return { ...base, pendingSince: pending, respawn: false }
  if (respawnTimes.length >= DEAFNESS_RESPAWN_LOOP_MAX) {
    return { pendingSince: null, probeHeard: false, disarmedAt: nowMs, respawnTimes, dayRespawnTimes, respawn: false, tripped: true, ceilingHeld: false }
  }
  if (dayRespawnTimes.length >= DEAFNESS_RESPAWN_DAY_MAX) {
    return { ...base, pendingSince: pending, respawn: false, ceilingHeld: true }
  }
  return { ...base, pendingSince: pending, respawn: true }
}

/**
 * Pure: a reason to hold a due deafness respawn, or null to proceed.
 *   ambiguous -- more than one transcript was written since the pending probe
 *                (see countTranscriptWritersSince);
 *   busy      -- the hub pane is mid-turn or has typed input (the same
 *                fail-open rule as the keepalive path: an unreadable pane
 *                does not hold).
 */
export function deafnessRespawnHold(opts: {
  transcriptWriters: number
  paneState: string | null
}): 'ambiguous' | 'busy' | null {
  if (opts.transcriptWriters > 1) return 'ambiguous'
  if (opts.paneState === 'busy' || opts.paneState === 'typing') return 'busy'
  return null
}

// ---------------------------------------------------------------------------
// Prober lifecycle
// ---------------------------------------------------------------------------

function readProbeLastSentMs(): number | null {
  try {
    const raw = readFileSync(PROBE_LAST_SENT_FILE, 'utf-8').trim()
    const ts = new Date(raw).getTime()
    return Number.isFinite(ts) ? ts : null
  } catch {
    return null
  }
}

// W4: read once at startup; subsequent calls return the cached value.
// W1: enforce a minimum floor of 30 000 ms to prevent inadvertent DoS.
function readProbeIntervalMs(): number {
  if (_cachedProbeIntervalMs !== null) return _cachedProbeIntervalMs
  const env = readEnvFile(['PROBE_INTERVAL_MS'])
  const raw = env['PROBE_INTERVAL_MS']
  const DEFAULT_MS = 180_000 // 3 minutes
  let parsed = DEFAULT_MS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) parsed = n
  }
  // W1: minimum 30 s floor
  _cachedProbeIntervalMs = Math.max(parsed, 30_000)
  return _cachedProbeIntervalMs
}

// W4: read once at startup; subsequent calls return the cached value.
function readAllowedChatId(): string | null {
  if (_cachedAllowedChatId !== undefined) return _cachedAllowedChatId
  // Goes through the shared resolver so the installer placeholder "0" counts
  // as "not set" here too, and so a wizard install falls back to the paired
  // channel instead of probing a chat that cannot exist.
  const env = readEnvFile(['ALLOWED_CHAT_ID'])
  _cachedAllowedChatId = resolveOwnerChatId(undefined, env['ALLOWED_CHAT_ID'] ?? null)
  return _cachedAllowedChatId
}

function spawnProber(): void {
  if (!existsSync(SESSION_FILE)) {
    // W3: one-shot warning — log only on first occurrence, debug on subsequent ticks.
    if (!_warnedSessionMissing) {
      logger.warn('Inbound prober: store/.watchdog-userbot.session missing -- prober is a no-op until the session is created')
      _warnedSessionMissing = true
    } else {
      logger.debug('Inbound prober: session still missing -- skipping')
    }
    return
  }
  // Reset session-missing flag if the file now exists.
  _warnedSessionMissing = false

  const allowedChatId = readAllowedChatId()
  if (!allowedChatId) {
    // CW addendum D3: if ALLOWED_CHAT_ID is absent/empty, log warning and skip.
    // W3: one-shot via logger.warn; subsequent ticks use logger.debug.
    if (!_warnedChatIdAbsent) {
      logger.warn('inbound-prober: ALLOWED_CHAT_ID absent in .env -- prober skipped')
      _warnedChatIdAbsent = true
    } else {
      logger.debug('inbound-prober: ALLOWED_CHAT_ID still absent -- skipping')
    }
    return
  }
  // Reset chat-id-absent flag if the value is now present.
  _warnedChatIdAbsent = false

  if (!existsSync(VENV_PYTHON)) {
    logger.warn('Inbound prober: .watchdog-venv/bin/python3 not found -- prober skipped')
    return
  }

  if (!existsSync(PROBER_SCRIPT)) {
    logger.warn('Inbound prober: scripts/watchdog-inbound-prober.py not found -- prober skipped')
    return
  }

  if (proberProcess && proberProcess.exitCode === null) {
    // Still running — do not double-spawn.
    return
  }

  logger.info('Inbound prober: spawning watchdog-inbound-prober.py')
  try {
    proberProcess = spawn(VENV_PYTHON, [PROBER_SCRIPT], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proberProcess.stdout?.on('data', (data: Buffer) => {
      // Do not log stdout content as it may carry debug info with timing data.
      const text = data.toString('utf-8').trim()
      if (text) logger.debug({ prober: 'stdout' }, text)
    })
    proberProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8').trim()
      if (text) logger.warn({ prober: 'stderr' }, text)
    })
    proberProcess.on('exit', (code) => {
      logger.info({ code }, 'Inbound prober process exited')
      proberProcess = null
    })
    proberProcess.on('error', (err) => {
      logger.error({ err }, 'Inbound prober spawn error')
      proberProcess = null
    })
  } catch (err) {
    logger.error({ err }, 'Inbound prober: failed to spawn')
    proberProcess = null
  }
}

// Everything one deafness tick reads or changes outside itself, injected so
// the whole tick (clock, holds, early returns, respawn, state save) runs
// under test with fakes. Production values: defaultProbeTickDeps.
export interface ProbeLoopState {
  tick: ProbeTickState
  lastInboundRespawn: number
  warnedAmbiguous: boolean
  // The pending probe the read-limit warning was last logged for.
  warnedTruncatedFor?: number | null
  // The oldest respawn of the daily-ceiling episode last reported.
  ceilingReportedFor?: number | null
}

export interface ProbeRespawnSide {
  lastCrossPathRespawnAt(): number
  paneState(): PaneState | null
  restart(): { ok: boolean; error?: string }
}

export interface ProbeTickDeps {
  now(): number
  sessionExists(): boolean
  readMarker(): number | null
  transcriptDirs(): string[]
  scan(dirs: string[], sinceMs: number): IngestionScan
  countWriters(dirs: string[], sinceMs: number): number
  loadState(): ProbeLoopState
  saveState(state: ProbeLoopState): void
  // Loaded only when a respawn is due (lazy import, see RESPAWN_GRACE_MS).
  respawnSide(): Promise<ProbeRespawnSide>
  log: Pick<typeof logger, 'debug' | 'info' | 'warn' | 'error'>
}

export const defaultProbeTickDeps: ProbeTickDeps = {
  now: () => Date.now(),
  sessionExists: () => existsSync(SESSION_FILE),
  readMarker: readProbeLastSentMs,
  transcriptDirs: () => probeTranscriptDirs(),
  scan: (dirs, sinceMs) => scanIngestionAcross(dirs, sinceMs),
  countWriters: countTranscriptWritersSince,
  loadState: () => probeLoopState,
  saveState: (state) => { probeLoopState = state },
  respawnSide: async () => {
    const [{ hardRestartMarveenChannels, lastMainRespawnAt }, { detectPaneState }, { MAIN_CHANNELS_SESSION }] = await Promise.all([
      import('./channel-monitor.js'),
      import('../pane-state.js'),
      import('./main-agent.js'),
    ])
    return {
      lastCrossPathRespawnAt: lastMainRespawnAt,
      paneState: () => {
        // An unreadable pane maps to null: fail-open, it does not hold.
        const paneContent = capturePane(MAIN_CHANNELS_SESSION)
        return paneContent != null ? detectPaneState(paneContent) : null
      },
      restart: hardRestartMarveenChannels,
    }
  },
  log: logger,
}

// One deafness check. The threshold is probeIntervalMs *
// PROBE_TIMEOUT_MULTIPLIER, counted from the oldest unanswered probe.
export async function runInboundProbeTick(probeIntervalMs: number, deps: ProbeTickDeps): Promise<void> {
  // Resolved first, on every tick, so the active rotated plan dir is recorded
  // even while there is no session file or marker yet.
  const dirs = deps.transcriptDirs()

  // Session file absent: safe no-op.
  if (!deps.sessionExists()) return

  const markerTs = deps.readMarker()
  if (markerTs === null) {
    // No probe has been sent yet: nothing to check.
    return
  }

  const nowMs = deps.now()
  const state = deps.loadState()
  const scanSince = Math.min(state.tick.pendingSince ?? markerTs, markerTs)
  const scan = deps.scan(dirs, scanSince)
  const tick = decideProbeTick({
    state: state.tick,
    markerTs,
    scan,
    lastRespawnAt: state.lastInboundRespawn,
    probeTimeoutMs: probeIntervalMs * PROBE_TIMEOUT_MULTIPLIER,
    nowMs,
  })
  const next: ProbeLoopState = {
    ...state,
    tick: { pendingSince: tick.pendingSince, probeHeard: tick.probeHeard, disarmedAt: tick.disarmedAt, respawnTimes: tick.respawnTimes, dayRespawnTimes: tick.dayRespawnTimes },
  }
  if (tick.tripped) {
    deps.saveState(next)
    deps.log.error(
      { respawns: tick.respawnTimes.length },
      'Inbound probe still unanswered after the maximum deafness respawns without a probe ping heard in between -- not respawning again; the check stays disarmed until a new probe ping is heard. Check the prober account allowlist and the channel plugin by hand.',
    )
    return
  }
  if (tick.ceilingHeld) {
    const oldest = tick.dayRespawnTimes[0]
    if (state.ceilingReportedFor !== oldest) {
      deps.log.error(
        { respawns: tick.dayRespawnTimes.length, oldest },
        'Inbound probe unanswered, but the daily ceiling of deafness respawns is reached -- not respawning until the oldest of them is a day old. The hub may be intermittently deaf; check the channel plugin by hand.',
      )
    }
    deps.saveState({ ...next, ceilingReportedFor: oldest })
    return
  }
  if (!tick.respawn) {
    deps.saveState(next)
    if (tick.pendingSince != null && !tick.probeHeard) {
      deps.log.debug({ pendingSince: tick.pendingSince }, 'Inbound probe unanswered, but no probe ping has been seen inbound yet (prober not allowlisted?) -- not respawning')
    }
    return
  }
  const pendingSince = tick.pendingSince as number
  const lastIngestionTs = scan.lastTs

  if (deafnessRespawnHold({ transcriptWriters: deps.countWriters(dirs, pendingSince), paneState: null }) === 'ambiguous') {
    if (!state.warnedAmbiguous) {
      deps.log.warn({ pendingSince }, 'Inbound probe unanswered, but several transcripts were written meanwhile and the hub\'s own cannot be told apart -- not respawning')
    }
    deps.saveState({ ...next, warnedAmbiguous: true })
    return
  }
  deps.saveState({ ...next, warnedAmbiguous: false })

  // The read stopped at BACKSCAN_MAX_BYTES before reaching the pending probe:
  // the answer may lie further back. A missed respawn is cheaper than
  // restarting a healthy hub. While this probe stays unanswered the
  // transcript only grows, so every later due tick holds too (until an
  // inbound arrives or the dashboard restarts); warn once per pending probe.
  if (scan.truncated) {
    if (state.warnedTruncatedFor !== pendingSince) {
      deps.log.warn({ pendingSince }, 'Inbound probe unanswered, but the transcript written since then exceeds the read limit -- not respawning while this probe stays unanswered')
    }
    deps.saveState({ ...next, warnedAmbiguous: false, warnedTruncatedFor: pendingSince })
    return
  }

  let side: ProbeRespawnSide
  try {
    side = await deps.respawnSide()
  } catch (err) {
    deps.log.error({ err }, 'Inbound probe: failed to import channel-monitor for respawn')
    return
  }
  const nowAfterImport = deps.now()

  // Cross-path grace: skip if EITHER path has respawned recently (an
  // inbound-probe respawn must suppress the keepalive path and vice-versa).
  const crossPathAt = side.lastCrossPathRespawnAt()
  if (crossPathAt > 0 && nowAfterImport - crossPathAt < RESPAWN_GRACE_MS) {
    deps.log.info({ msSinceCrossPathRespawn: nowAfterImport - crossPathAt }, 'Inbound deafness detected but within cross-path respawn grace -- skipping')
    return
  }

  // Inbound-path self-rate-cap (covers the period before marveenLastHardRestart
  // is set by the async call completing).
  const lastInboundRespawn = deps.loadState().lastInboundRespawn
  if (lastInboundRespawn && nowAfterImport - lastInboundRespawn < RESPAWN_GRACE_MS) {
    deps.log.info({ msSinceLastRespawn: nowAfterImport - lastInboundRespawn }, 'Inbound deafness detected but within respawn grace -- skipping')
    return
  }

  // Busy guard, same signal as the keepalive path: a hub inside a long tool
  // call or with typed input is working, not deaf.
  const paneState = side.paneState()
  if (deafnessRespawnHold({ transcriptWriters: 1, paneState }) === 'busy') {
    deps.log.info({ paneState, pendingSince }, 'Inbound deafness detected but pane is busy -- deferring respawn')
    return
  }

  deps.log.warn({ markerTs, pendingSince, lastIngestionTs, nowMs }, 'Inbound deafness detected -- triggering respawn')

  // hardRestartMarveenChannels sets marveenLastHardRestart on success, which
  // automatically suppresses the keepalive path for KEEPALIVE_RESPAWN_GRACE_MS.
  const result = side.restart()
  if (result.ok) {
    // decideProbeTick drops probes sent at or before this moment: the clock
    // restarts with the next unanswered probe to the new process. The
    // respawn also counts toward the loop breaker.
    const cur = deps.loadState()
    deps.saveState({ ...cur, lastInboundRespawn: nowAfterImport, tick: recordDeafnessRespawn(cur.tick, nowAfterImport) })
    deps.log.warn('Inbound deafness respawn triggered successfully')
  } else {
    deps.log.error({ error: result.error }, 'Inbound deafness respawn failed')
  }
}

/**
 * Start the inbound-probe background loop.
 *
 * Called once during server startup (immediately after startChannelPluginMonitor).
 * A failure here must never crash the server — wrapped in try/catch at call site.
 *
 * The prober is a safe no-op when:
 *   - store/.watchdog-userbot.session is missing (account not set up)
 *   - ALLOWED_CHAT_ID is absent in .env
 *   - auth fails in the Python prober (exits 0 with warning)
 *
 * MANUAL GATE: the operator must run /telegram:access in the main channels session to
 * allowlist the prober account before messages will be delivered. Until then
 * the prober's sends still succeed and still write the probe-last-sent marker
 * (the allowlist drop happens later, in the channel plugin), so unanswered
 * probes pile up. No respawn is triggered for them as long as no probe ping
 * has been seen inbound: the check stays disarmed until then. If the prober
 * account is dropped by the allowlist only AFTER a ping was heard, the check
 * is armed and does respawn the hub, at most DEAFNESS_RESPAWN_LOOP_MAX times
 * without a probe ping heard in between, whatever the probe interval; then
 * the loop breaker disarms it until a new ping is heard (see
 * decideProbeTick). Independently, at most DEAFNESS_RESPAWN_DAY_MAX
 * respawns happen in any rolling DEAFNESS_RESPAWN_DAY_WINDOW_MS, so a hub
 * that is only intermittently deaf is restarted at most that often.
 *
 * Known limitation of that gate: the latch is in memory. After a dashboard
 * restart it re-arms only when a probe ping is found in the tail of a scanned
 * transcript. When the hub comes back deaf together with the dashboard (host
 * reboot, update, mass restart), its fresh transcript holds no ping, so the
 * check stays disarmed for the life of that dashboard process.
 */
export function startInboundProber(): void {
  const probeIntervalMs = readProbeIntervalMs()

  // Spawn the Python prober immediately (it manages its own send loop).
  spawnProber()
  // Record the active rotated plan dir now, not only at the first tick.
  probeTranscriptDirs()

  // TS-side check loop: runs at the same interval as the prober's send loop.
  // Each tick: re-spawn the prober if it died, then check the transcript.
  setInterval(() => {
    try {
      spawnProber()
      void runInboundProbeTick(probeIntervalMs, defaultProbeTickDeps).catch(err => logger.error({ err }, 'Inbound probe check tick failed'))
    } catch (err) {
      logger.error({ err }, 'Inbound probe check tick failed')
    }
  }, probeIntervalMs)

  logger.info({ probeIntervalMs }, 'Inbound prober started')
}
