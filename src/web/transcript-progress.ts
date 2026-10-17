// ROUTERSTUCK1012 (MODSPROBA1004): when did an agent's session last make
// progress, read from its own transcript.
//
// The router's busy-STUCK escalation decided from the pane state and the
// elapsed time alone. Measured 2026-10-05..10-11 on the trial agents: 14 such
// alerts, and in all 14 the agent was working -- pane and mode busy, the
// transcript moving within 0-5 minutes. A busy pane cannot tell a long turn
// from a wedged tool call; the transcript can, because a working turn keeps
// writing assistant output and tool results into it.
//
// What counts as progress, and what deliberately does not:
//   - an `assistant` entry (model output, tool calls);
//   - a `user` entry that is neither meta nor the compaction summary: tool
//     results, and prompts the session actually took (a '<'-prefixed
//     task-notification or channel line included -- taking input is progress);
//   - NOT the compaction summary (`isCompactSummary`): after a compaction the
//     last user line is "This session is being continued ...", and that line
//     alone proves nothing about the turn after it;
//   - NOT `queue-operation`: mail arriving for a busy session is written there
//     whether or not the session ever takes it, so it is exactly what a stuck
//     session with a growing backlog looks like;
//   - NOT attachments, system lines, titles, modes or snapshots.
//
// Reading: only the newest session file of the agent's project dir and that
// session's own sub-agent files (a main thread waiting on a long Task writes
// nothing while the sub-agent works), and of each only the LAST
// TAIL_BYTES -- async, so a large transcript never blocks the router's event
// loop. Anything unreadable or unparseable is null, and the caller then keeps
// today's behaviour.

import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** How much of each file's end is read. A single entry larger than this (a huge tool result) is skipped. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024
/** At most this many of the newest sub-agent files of the session are read. */
const MAX_SUBAGENT_FILES = 5

interface TranscriptEntry {
  type?: unknown
  timestamp?: unknown
  isMeta?: unknown
  isCompactSummary?: unknown
}

function isProgressEntry(e: TranscriptEntry): boolean {
  if (e.type === 'assistant') return true
  if (e.type === 'user') return e.isMeta !== true && e.isCompactSummary !== true
  return false
}

/**
 * Pure: the newest progress timestamp (ms) in a transcript tail, or null when
 * there is none. `cutAtStart` says the text starts mid-file, so its first line
 * may be a fragment and is dropped.
 */
export function lastProgressAtFromTail(text: string, cutAtStart: boolean): number | null {
  const lines = text.split('\n')
  if (cutAtStart) lines.shift()
  let best: number | null = null
  for (const line of lines) {
    if (!line.trim()) continue
    let e: TranscriptEntry
    try {
      e = JSON.parse(line) as TranscriptEntry
    } catch {
      continue
    }
    if (!e || typeof e !== 'object' || !isProgressEntry(e) || typeof e.timestamp !== 'string') continue
    const t = Date.parse(e.timestamp)
    if (Number.isFinite(t) && (best == null || t > best)) best = t
  }
  return best
}

async function tailProgressAt(file: string): Promise<number | null> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return lastProgressAtFromTail(buf.toString('utf-8'), size > len)
  } finally {
    await fh.close()
  }
}

async function newestJsonl(dir: string, limit: number): Promise<string[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  const withTimes = await Promise.all(names.map(async (f) => {
    try { return { f, m: (await stat(join(dir, f))).mtimeMs } } catch { return null }
  }))
  return withTimes
    .filter((x): x is { f: string; m: number } => x != null)
    .sort((a, b) => b.m - a.m)
    .slice(0, limit)
    .map((x) => join(dir, x.f))
}

/**
 * The newest progress timestamp (ms) of the session in `projectDir` (Claude
 * Code's per-cwd transcript dir), its sub-agents included; null when the dir,
 * the files or a progress entry are missing, or anything fails to read.
 */
export async function readTranscriptProgressAt(projectDir: string): Promise<number | null> {
  try {
    const [session] = await newestJsonl(projectDir, 1)
    if (!session) return null
    const files = [session]
    const sessionId = session.slice(projectDir.length + 1, -'.jsonl'.length)
    try {
      files.push(...await newestJsonl(join(projectDir, sessionId, 'subagents'), MAX_SUBAGENT_FILES))
    } catch { /* no sub-agents: the session file alone */ }
    let best: number | null = null
    for (const f of files) {
      let t: number | null = null
      try { t = await tailProgressAt(f) } catch { /* unreadable file: skip it */ }
      if (t != null && (best == null || t > best)) best = t
    }
    return best
  } catch {
    return null
  }
}
