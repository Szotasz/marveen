import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

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

// Resolve the session-log directory Claude Code writes for a working dir.
// Logs live under <config-root>/projects/<encoded-working-dir>/, where the
// config root is ~/.claude by default but an alternate one when the agent was
// launched with CLAUDE_CONFIG_DIR. Pass that absolute config root as configDir
// so we read the right project dir for agents on a non-default config.
export function projectsDirFor(workingDir: string, configDir?: string, homeDirOverride?: string): string {
  const base = configDir ?? join(homeDirOverride ?? homedir(), '.claude')
  const encoded = workingDir.replace(/[/.]/g, '-')
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
    const content = readFileSync(join(dir, jsonls[0].f), 'utf-8')
    const lines = content.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const entry = JSON.parse(line)
        const msg = entry?.message
        const model = msg?.model
        if (typeof model !== 'string' || model.startsWith('<')) continue
        if (sinceUnixSec !== undefined) {
          const ts = entry?.timestamp
          if (typeof ts !== 'string') continue
          const lineUnix = Math.floor(new Date(ts).getTime() / 1000)
          if (!Number.isFinite(lineUnix) || lineUnix < sinceUnixSec) continue
        }
        value = model
        break
      } catch { /* skip malformed JSON line */ }
    }
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
        const content = readFileSync(join(dir, jsonls[0].f), 'utf-8')
        const lines = content.split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim()
          if (!line) continue
          try {
            const u = JSON.parse(line)?.message?.usage
            if (u && typeof u === 'object') {
              const inp = Number(u.input_tokens) || 0
              const cr = Number(u.cache_read_input_tokens) || 0
              const cc = Number(u.cache_creation_input_tokens) || 0
              const total = inp + cr + cc
              if (total > 0) { value = total; break }
            }
          } catch { /* skip malformed JSON line */ }
        }
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
