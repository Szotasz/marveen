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
