// Measures the INSTALLED Claude Code CLI version for the model picker gate
// (PICKERCLIKAPU923). Best effort and cached: a probe failure is a
// measurement result (`version: null`), never an exception, because the
// consumer fails OPEN on an unmeasured version.
import { execFile } from 'node:child_process'
import { tryResolveFromPath } from '../platform.js'
import { parseClaudeVersion } from '../claude-cli-support.js'

export interface ClaudeCliVersionResult {
  /** Parsed dotted version, or null when not measurable. */
  version: string | null
  /** Epoch ms of the measurement. */
  measuredAt: number
  /** Why `version` is null; null when measured. */
  error: string | null
  /** 'probe' for a real `claude --version`, 'env' for the MARVEEN_CLAUDE_CLI_VERSION override. */
  source: 'probe' | 'env'
}

/** Operator/test override: when set, no binary is probed. Empty string means "unmeasured". */
export const CLI_VERSION_OVERRIDE_ENV = 'MARVEEN_CLAUDE_CLI_VERSION'
const CACHE_TTL_MS = 10 * 60 * 1000
const PROBE_TIMEOUT_MS = 10_000

let cache: ClaudeCliVersionResult | null = null

function fromEnv(): ClaudeCliVersionResult | null {
  const raw = process.env[CLI_VERSION_OVERRIDE_ENV]
  if (raw === undefined) return null
  const version = parseClaudeVersion(raw)
  return { version, measuredAt: Date.now(), error: version ? null : `override ${CLI_VERSION_OVERRIDE_ENV} carries no version`, source: 'env' }
}

/** Measures (or returns the cached) installed CLI version. `fresh` bypasses the cache. */
export function measureClaudeCliVersion(opts: { fresh?: boolean } = {}): Promise<ClaudeCliVersionResult> {
  const env = fromEnv()
  if (env) return Promise.resolve(env)
  if (!opts.fresh && cache && Date.now() - cache.measuredAt < CACHE_TTL_MS) return Promise.resolve(cache)
  return new Promise((resolve) => {
    const bin = tryResolveFromPath('claude')
    if (!bin) {
      cache = { version: null, measuredAt: Date.now(), error: 'claude binary not found on PATH', source: 'probe' }
      resolve(cache)
      return
    }
    execFile(bin, ['--version'], { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      const version = parseClaudeVersion(String(stdout ?? ''))
      const error = err ? `claude --version failed: ${err.message.slice(0, 120)}` : version ? null : `unparseable output: ${String(stdout).slice(0, 60)}`
      cache = { version: err ? null : version, measuredAt: Date.now(), error: err ? error : (version ? null : error), source: 'probe' }
      resolve(cache)
    })
  })
}

/** Test hook: forget the cached measurement. */
export function resetClaudeCliVersionCache(): void { cache = null }
