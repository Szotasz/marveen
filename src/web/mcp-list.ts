import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import {
  applyRefreshOutcome,
  scrubPaths as scrubPathsBase,
  type McpListEntry,
} from '../mcp-list-parser.js'

const CLAUDE = resolveFromPath('claude')

function scrubPaths(msg: string): string {
  return scrubPathsBase(msg, homedir())
}

// On refresh failure, keep the previous (stale) entries so a transient CLI
// error does not blank out the UI. Callers can distinguish fresh / stale via
// lastRefreshed and error fields.
export interface McpListCache {
  entries: McpListEntry[]
  lastRefreshed: number
  refreshing: boolean
  error?: string
}

let mcpListCache: McpListCache = {
  entries: [],
  lastRefreshed: 0,
  refreshing: false,
}

// Declared ahead of refreshMcpListCache so the function body's reference
// is past the TDZ even if a future caller reaches it earlier in module
// initialisation (e.g. during import-time side effects).
let inflightRefresh: Promise<McpListCache> | null = null

export function getMcpListCache(): McpListCache {
  return mcpListCache
}

// Private working directory for `claude mcp list`. Running from /tmp
// directly was tempting (no project-local .mcp.json to spawn), but on
// multi-user hosts any user with write access to /tmp can plant a
// .mcp.json there and poison the list the dashboard builds. A dashboard-
// owned temp dir has 0700 permissions and is immune to that. Created
// lazily so a failure here does not crash boot.
let mcpListWorkingDir: string | null = null
function getMcpListWorkingDir(): string {
  if (mcpListWorkingDir && existsSync(mcpListWorkingDir)) return mcpListWorkingDir
  mcpListWorkingDir = mkdtempSync(join(tmpdir(), 'marveen-mcp-list-'))
  return mcpListWorkingDir
}

// Cleanup on process shutdown so long-running hosts don't accumulate
// empty 0700 dirs across restarts. Only hook 'exit' (always fires, no
// matter how the process terminates except SIGKILL). Handling SIGTERM
// / SIGINT separately would race the index.ts shutdown listener, which
// calls process.exit(0) and may prevent our cleanup from running.
const cleanupMcpListWorkingDir = () => {
  if (!mcpListWorkingDir) return
  try { rmSync(mcpListWorkingDir, { recursive: true, force: true }) } catch { /* best effort */ }
  mcpListWorkingDir = null
}
process.once('exit', cleanupMcpListWorkingDir)

export function refreshMcpListCache(): Promise<McpListCache> {
  // If a refresh is already in flight, return the same promise so every
  // concurrent caller ends up with identical (fresh) cache state without
  // spawning `claude mcp list` more than once per burst.
  if (inflightRefresh) return inflightRefresh
  inflightRefresh = (async () => {
    mcpListCache.refreshing = true
    const previousCount = mcpListCache.entries.length
    try {
      // Async exec so the event loop keeps serving other HTTP requests
      // while `claude mcp list` runs (up to 30s if a plugin's health
      // check is slow). Run from /tmp so no project-local .mcp.json
      // gets picked up; the global enabledPlugins list is scanned
      // regardless of cwd. maxBuffer is bumped to 10 MiB so a verbose
      // status output with auth warnings cannot blow up with ENOBUFS.
      const { stdout, stderr, execError } = await new Promise<{
        stdout: string
        stderr: string
        execError: Error | null
      }>((resolve, reject) => {
        execFile(CLAUDE, ['mcp', 'list'], {
          cwd: getMcpListWorkingDir(),
          timeout: 30_000,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
        }, (err, stdoutStr, stderrStr) => {
          // A non-zero exit is not fatal on its own: `claude mcp list`
          // can exit with code 1 when any one of the configured servers
          // fails its health check (a realistic steady state when e.g.
          // an OAuth token has lapsed). The stdout still carries the
          // full list in that case, so try to parse it before giving
          // up. We only reject when there is nothing usable at all
          // (launch failure, timeout without output, SIGKILL).
          if (err && !stdoutStr) {
            reject(err)
            return
          }
          resolve({ stdout: stdoutStr ?? '', stderr: stderrStr ?? '', execError: err ?? null })
        })
      })
      const stderrTrimmed = stderr ? stderr.trim() : ''
      if (stderrTrimmed) {
        logger.debug({ stderr: scrubPaths(stderrTrimmed.slice(0, 500)) }, 'claude mcp list stderr')
      }
      const outcome = applyRefreshOutcome({
        stdout,
        execError,
        previousEntries: mcpListCache.entries,
      })
      // Defensive: if a previously populated cache collapses to zero
      // entries via a clean exit (parser / format regression), log it
      // loudly. The retainedStale case is a legitimate transient
      // failure and is already surfaced via cache.error, not a warn.
      if (previousCount > 0 && outcome.entries.length === 0 && !outcome.retainedStale) {
        logger.warn({
          previousCount,
          stderr: scrubPaths(stderrTrimmed.slice(0, 500)),
          execError: execError ? scrubPaths(execError.message) : null,
        }, 'MCP list cache refresh returned 0 entries after non-empty cache')
      }
      mcpListCache = {
        entries: outcome.entries,
        lastRefreshed: Date.now(),
        refreshing: false,
        error: outcome.error ? scrubPaths(outcome.error) : undefined,
      }
      logger.info({
        count: outcome.entries.length,
        retainedStale: outcome.retainedStale,
        softError: execError && !outcome.error ? scrubPaths(execError.message) : null,
      }, 'MCP list cache refreshed')
    } catch (err) {
      // Keep the previous entries on failure so a transient CLI error
      // does not wipe the UI. The error field lets callers surface it.
      const rawMsg = err instanceof Error ? err.message : String(err)
      mcpListCache = {
        entries: mcpListCache.entries,
        lastRefreshed: mcpListCache.lastRefreshed,
        refreshing: false,
        error: scrubPaths(rawMsg),
      }
      logger.warn({ err: scrubPaths(rawMsg) }, 'MCP list cache refresh failed; keeping stale entries')
    } finally {
      inflightRefresh = null
    }
    return mcpListCache
  })()
  return inflightRefresh
}

export function startMcpListChecker(): void {
  // Delayed first run so the main main-channels tmux session has time to
  // claim the telegram poller token before `claude mcp list` tries to
  // health-check the plugin. No periodic auto-refresh: every run spawns
  // the telegram plugin for a health check, which can race the live bot.
  setTimeout(() => { refreshMcpListCache().catch(() => {}) }, 30_000)
}
