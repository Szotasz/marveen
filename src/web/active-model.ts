import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
