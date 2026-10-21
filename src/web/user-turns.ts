import { closeSync, openSync, readdirSync, readSync, statSync, type Stats } from 'node:fs'
import { join } from 'node:path'

// GET /api/overview counts "real" user turns (operator prompts, Telegram
// messages) across every Claude Code session transcript under
// ~/.claude/projects, and asks twice per request: today and yesterday. The old
// counter re-read every *.jsonl in full on both calls, which on a busy install
// held the request on the event loop for seconds. Transcripts are append-only,
// so everything but the newest bytes answer the same as last time. This
// counter remembers per file its identity (dev + ino), size, mtime, how far it
// has been consumed and the bytes just before that point, plus the timestamp
// of every qualifying turn so far; a call then reads only the bytes appended
// since (an unchanged file is not read at all) and answers any [fromMs, toMs)
// window from the remembered timestamps. A file that did not merely grow
// (first sight, another inode, shorter, or rewritten in place to a larger
// size, which the remembered bytes before the consumed offset give away -- a
// heuristic: a rewrite that leaves those bytes intact reads as an append) is
// parsed whole again, turns reset, exactly what the old counter did on every
// call. And since the root can hold many transcripts, the memo must be
// bounded: every call also forgets what the walk did not see and what has not
// been modified within retainMs, reading such a file whole again when a later
// call needs it.

const ANCHOR_BYTES = 64

// How long a memo survives its file going unmodified. A line's timestamp is
// never newer than the file that holds it, and the overview's oldest window
// starts at yesterday 00:00, never more than 48 h back, so a memo past 49 h
// can never be asked for again.
const DEFAULT_RETAIN_MS = 49 * 60 * 60 * 1000

type FileTurns = {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  // the byte just past the last '\n' consumed; bytes after it are an unfinished line
  offset: number
  // the up-to-ANCHOR_BYTES bytes just before `offset`: an in-place rewrite to a larger size changes them
  anchor: Buffer
  // epoch ms of every qualifying user turn in [0, offset), whatever window was asked
  turns: number[]
}

// The qualifying rule of the old counter in the overview route, kept identical
// so the two can never disagree: a non-meta user line with a truthy timestamp,
// whose content is a string other than a local-command / command-name echo, or
// an array of blocks holding no tool_result.
function turnTs(e: any): number | undefined {
  // A line that parses to a non-object (null, a number) is skipped, where the
  // old counter threw on it and stopped counting that file.
  if (!e || typeof e !== 'object' || e.type !== 'user' || e.isMeta) return undefined
  const ts = e.timestamp ? Date.parse(e.timestamp) : 0
  if (!ts) return undefined
  const content = e.message?.content
  if (typeof content === 'string') {
    if (content.startsWith('<local-command') || content.startsWith('<command-name>')) return undefined
    return ts
  }
  if (Array.isArray(content)) {
    const hasToolResult = content.some((b: any) => b && b.type === 'tool_result')
    return hasToolResult ? undefined : ts
  }
  return undefined
}

// The up-to-ANCHOR_BYTES bytes ending at the consume offset: the last of
// `tail` (the anchor of `from`) followed by the last of buf[0, end). Copied
// out, not a view -- a view would pin the whole range it was read into.
function anchorBefore(tail: Buffer, buf: Buffer, end: number): Buffer {
  const take = Math.min(ANCHOR_BYTES, tail.length + end)
  const anchor = Buffer.alloc(take)
  const fromBuf = Math.min(end, take)
  buf.copy(anchor, take - fromBuf, end - fromBuf, end)
  tail.copy(anchor, 0, tail.length - (take - fromBuf))
  return anchor
}

export function createUserTurnCounter(root: string, opts: { retainMs?: number } = {}): {
  count(fromMs: number, toMs?: number): number
  bytesReadForTests(): number
  rememberedFilesForTests(): number
} {
  const files = new Map<string, FileTurns>()
  const retainMs = opts.retainMs ?? DEFAULT_RETAIN_MS
  let bytesRead = 0

  // Consumes the complete lines of [from, to): reads the range, keeps it up to
  // and including the LAST '\n' (bytes past it are an unfinished line, left
  // for the call that sees its terminator), decodes that as utf-8 -- both cut
  // points fall just after a newline, so on character boundaries -- and
  // appends the timestamps of the qualifying lines to `turns`. `tail` is the
  // anchor of `from`, so the anchor of the new offset comes out of the bytes
  // just read without a second read. Returns the new offset with its anchor.
  function consume(file: string, from: number, to: number, tail: Buffer, turns: number[]): { offset: number; anchor: Buffer } {
    if (to <= from) return { offset: from, anchor: tail }
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(to - from)
      let got = 0
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, from + got)
        if (n === 0) break
        got += n
      }
      bytesRead += got
      const end = buf.lastIndexOf(0x0a) + 1
      if (end === 0) return { offset: from, anchor: tail } // no complete line in the range yet
      for (const line of buf.subarray(0, end).toString('utf-8').split('\n')) {
        if (!line) continue
        let e: any
        try { e = JSON.parse(line) } catch { continue }
        const ts = turnTs(e)
        if (ts !== undefined) turns.push(ts)
      }
      return { offset: from + end, anchor: anchorBefore(tail, buf, end) }
    } finally { closeSync(fd) }
  }

  // Whether `file` still holds exactly `want` at `at`. A short or failing read
  // says the file is not what was remembered, so the caller reads it whole.
  function sameBytes(file: string, at: number, want: Buffer): boolean {
    if (want.length === 0) return true
    const got = Buffer.alloc(want.length)
    try {
      const fd = openSync(file, 'r')
      try {
        if (readSync(fd, got, 0, want.length, at) !== want.length) return false
      } finally { closeSync(fd) }
    } catch { return false }
    bytesRead += want.length
    return got.equals(want)
  }

  // Brings a file's remembered state up to date and returns its turn
  // timestamps. Same identity with the same size and mtime: nothing is read.
  // Same identity and grown, with the bytes just before the consumed offset
  // still what they were: only the appended bytes are. Anything else: parsed
  // whole from byte 0, turns reset.
  function refresh(file: string, st: Stats): number[] {
    const prev = files.get(file)
    if (prev && prev.dev === st.dev && prev.ino === st.ino) {
      if (st.size === prev.size && st.mtimeMs === prev.mtimeMs) return prev.turns
      if (st.size > prev.size && sameBytes(file, prev.offset - prev.anchor.length, prev.anchor)) {
        const { offset, anchor } = consume(file, prev.offset, st.size, prev.anchor, prev.turns)
        files.set(file, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, offset, anchor, turns: prev.turns })
        return prev.turns
      }
    }
    const turns: number[] = []
    const { offset, anchor } = consume(file, 0, st.size, Buffer.alloc(0), turns)
    files.set(file, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, offset, anchor, turns })
    return turns
  }

  function count(fromMs: number, toMs: number = Number.POSITIVE_INFINITY): number {
    let total = 0
    const seen = new Set<string>()
    try {
      for (const projectDir of readdirSync(root)) {
        const absDir = join(root, projectDir)
        let dstat: Stats
        try { dstat = statSync(absDir) } catch { continue }
        if (!dstat.isDirectory()) continue
        let names: string[]
        try { names = readdirSync(absDir) } catch { continue }
        for (const fname of names) {
          if (!fname.endsWith('.jsonl')) continue
          const absFile = join(absDir, fname)
          let fstat: Stats
          try { fstat = statSync(absFile) } catch { continue }
          seen.add(absFile)
          if (fstat.mtimeMs < fromMs) continue
          let turns: number[]
          try { turns = refresh(absFile, fstat) } catch { continue /* skip unreadable file */ }
          for (const ts of turns) {
            if (ts >= fromMs && ts < toMs) total++
          }
        }
      }
    } catch { /* a missing root, or a walk that broke midway: what counted so far stands */ }
    // a tree that is pruned or moved away must not pin the map forever, and
    // neither may a transcript nobody has written to lately: forget what this
    // walk did not see and what fell past retainMs. A forgotten file that a
    // later call does need is simply parsed whole again.
    const expired = Date.now() - retainMs
    for (const [key, memo] of files) {
      if (!seen.has(key) || memo.mtimeMs < expired) files.delete(key)
    }
    return total
  }

  return {
    count,
    bytesReadForTests: () => bytesRead,
    rememberedFilesForTests: () => files.size,
  }
}
