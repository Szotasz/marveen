import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { readFileOr } from './agent-config.js'
import { projectsDirFor } from './active-model.js'

// Read-only window into an agent's live session log, for operators who need to
// answer one question: is this agent working, or is it stuck?
//
// Claude Code writes one .jsonl per session under
// <config-root>/projects/<encoded-working-dir>/. Those files reach 90+ MB, so
// we never read one whole -- we seek to the end and take a fixed tail.
//
// WHY AN ALLOWLIST (do not remove this without reading it):
// A session log holds everything the agent saw: customer correspondence, fee
// negotiations, personal data of the principal it works for. Fleet rule 8 says
// one agent's mail is off-limits to everyone else. This endpoint is exposed
// behind the single shared dashboard bearer token, so *without* the allowlist
// any token holder could read any agent's log. The allowlist -- not the
// truncation -- is what keeps that from happening. Adding a name to it is an
// owner decision about who may read whose material, not a routine config edit.
const ALLOWLIST_PATH = join(PROJECT_ROOT, 'store', 'transcript-allowlist.json')

// Tail size in bytes. The owner asked for "about five pages" of readable text
// with whole (untruncated) events, so this cap is the only size limit.
//
// Sized from a measurement, not a guess: in the live cortex-router log the last
// 40 lines averaged 3148 bytes each (median 1449, max 23828 -- a single big
// tool_result can exceed 20 KB on its own). A 20 KB window therefore yielded
// ONE event in practice. 60 KB gives roughly 15-20 events, which is what five
// pages of readable text costs once JSON overhead is included. Callers can
// override with ?bytes= up to the max.
const DEFAULT_TAIL_BYTES = 60_000
const MAX_TAIL_BYTES = 400_000

export type TranscriptEventType = 'tool_use' | 'tool_result' | 'text' | 'thinking' | 'user'

export interface TranscriptEvent {
  ts: string | null
  tipus: TranscriptEventType
  nev: string | null
  szoveg: string
}

export interface TranscriptHeader {
  /** ISO timestamp of the most recent event, or null when the log is empty. */
  utolsoEsemeny: string | null
  /** Events seen in the tail whose timestamp falls in the last 10 minutes. */
  esemeny10Perc: number
  /** Session file mtime minus its first-seen ctime, in seconds; null if unknown. */
  sessionKorSec: number | null
}

export interface TranscriptResult {
  agent: string
  session: string | null
  header: TranscriptHeader
  events: TranscriptEvent[]
}

/** Agents whose transcript may be read. Missing/garbled file = nobody. */
export function readTranscriptAllowlist(): string[] {
  try {
    const parsed = JSON.parse(readFileOr(ALLOWLIST_PATH, '[]')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
  } catch {
    return []
  }
}

export function isTranscriptAllowed(agentName: string): boolean {
  return readTranscriptAllowlist().includes(agentName)
}

// Redact anything shaped like a credential. This is NOT truncation: only the
// matched secret is replaced, the surrounding text survives. Measured on
// 2026-08-26: the live token value appears zero times in the current logs
// (the shell substitutes it at run time, so only the command text is logged) --
// but one bad turn is enough to put it there, and then it is out.
// Labelled secrets: the capture group is the credential, the rest of the match
// (the "Bearer "/"token=" label, quotes) is kept so the reader still sees WHAT
// happened there. Replacing via the group -- not via an end-anchored search --
// matters because a trailing quote is part of the match and would otherwise
// defeat the anchor, taking the label down with it (caught by the tests).
const LABELLED_SECRET = /\b(?:Bearer|token|apikey|api_key|password|secret)\s*[:=]?\s*['"]?([A-Za-z0-9_\-.]{20,})['"]?/gi

// Self-identifying secrets: the whole match is the credential.
const STANDALONE_SECRETS: RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
]

export function maskSecrets(text: string): string {
  let out = text.replace(LABELLED_SECRET, (m, secret: string) => m.replace(secret, '<REDACTED>'))
  for (const re of STANDALONE_SECRETS) out = out.replace(re, '<REDACTED>')
  return out
}

/** Newest .jsonl in a directory by mtime, or null when there is none. */
function newestSessionFile(dir: string): { path: string; name: string } | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (files.length === 0) return null
  return { path: join(dir, files[0].f), name: files[0].f }
}

/**
 * Read the last `tailBytes` of a file without loading the rest. The first line
 * of the window is almost certainly cut in half; the caller drops it.
 */
function readTail(path: string, tailBytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - tailBytes)
    const length = size - start
    if (length <= 0) return ''
    const buf = Buffer.allocUnsafe(length)
    readSync(fd, buf, 0, length, start)
    return buf.toString('utf-8')
  } finally {
    closeSync(fd)
  }
}

function blockText(block: unknown): string {
  if (typeof block === 'string') return block
  if (!block || typeof block !== 'object') return ''
  const b = block as Record<string, unknown>
  if (typeof b.text === 'string') return b.text
  if (typeof b.thinking === 'string') return b.thinking
  if (b.input !== undefined) {
    try { return JSON.stringify(b.input) } catch { return '' }
  }
  if (typeof b.content === 'string') return b.content
  if (Array.isArray(b.content)) return b.content.map(blockText).join(' ')
  return ''
}

/** Flatten one jsonl line into zero or more display events. */
function eventsFromLine(line: string): TranscriptEvent[] {
  let entry: Record<string, unknown>
  try { entry = JSON.parse(line) as Record<string, unknown> } catch { return [] }
  const ts = typeof entry.timestamp === 'string' ? entry.timestamp : null
  const msg = entry.message as Record<string, unknown> | undefined
  const content = msg?.content
  if (!Array.isArray(content)) {
    // Plain-string content (rare) still carries the user's prompt.
    if (typeof content === 'string' && content.trim() !== '') {
      return [{ ts, tipus: 'user', nev: null, szoveg: maskSecrets(content) }]
    }
    return []
  }
  const out: TranscriptEvent[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    const kind = b.type
    let tipus: TranscriptEventType | null = null
    if (kind === 'tool_use') tipus = 'tool_use'
    else if (kind === 'tool_result') tipus = 'tool_result'
    else if (kind === 'thinking') tipus = 'thinking'
    else if (kind === 'text') tipus = entry.type === 'user' ? 'user' : 'text'
    if (tipus === null) continue
    const raw = blockText(b)
    if (raw.trim() === '') continue
    out.push({
      ts,
      tipus,
      nev: typeof b.name === 'string' ? b.name : null,
      szoveg: maskSecrets(raw),
    })
  }
  return out
}

export interface ReadTranscriptOptions {
  workingDir: string
  configDir?: string
  tailBytes?: number
  /** ISO string; events at or before it are dropped. */
  since?: string
  nowMs?: number
}

export function readAgentTranscript(agentName: string, opts: ReadTranscriptOptions): TranscriptResult {
  const tailBytes = Math.min(MAX_TAIL_BYTES, Math.max(1_000, opts.tailBytes ?? DEFAULT_TAIL_BYTES))
  const dir = projectsDirFor(opts.workingDir, opts.configDir)
  const file = newestSessionFile(dir)
  const empty: TranscriptResult = {
    agent: agentName,
    session: null,
    header: { utolsoEsemeny: null, esemeny10Perc: 0, sessionKorSec: null },
    events: [],
  }
  if (!file) return empty

  const raw = readTail(file.path, tailBytes)
  const lines = raw.split('\n')
  // The window starts mid-line unless we happened to land on a boundary.
  if (lines.length > 1) lines.shift()

  let events: TranscriptEvent[] = []
  for (const line of lines) {
    const t = line.trim()
    if (t === '') continue
    events.push(...eventsFromLine(t))
  }
  if (opts.since) {
    const cutoff = Date.parse(opts.since)
    if (!Number.isNaN(cutoff)) {
      events = events.filter(e => e.ts !== null && Date.parse(e.ts) > cutoff)
    }
  }

  const nowMs = opts.nowMs ?? Date.now()
  const tenMinAgo = nowMs - 10 * 60_000
  let last: string | null = null
  let recent = 0
  for (const e of events) {
    if (e.ts === null) continue
    const ms = Date.parse(e.ts)
    if (Number.isNaN(ms)) continue
    if (last === null || ms > Date.parse(last)) last = e.ts
    if (ms >= tenMinAgo) recent++
  }

  let ageSec: number | null = null
  try {
    const st = statSync(file.path)
    ageSec = Math.max(0, Math.round((nowMs - st.birthtimeMs) / 1000))
  } catch { ageSec = null }

  return {
    agent: agentName,
    session: file.name.replace(/\.jsonl$/, ''),
    header: { utolsoEsemeny: last, esemeny10Perc: recent, sessionKorSec: ageSec },
    events,
  }
}
