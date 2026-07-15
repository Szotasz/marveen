// Background reconciler for the capability-summary cache. Every tick it
// finds locally-cached summaries whose sources changed (or that never
// existed) and regenerates a SMALL batch through the shared one-shot LLM
// machinery (runAgent -- worker session, serialized; SDK fallback). The
// catalog degrades gracefully to skills-only until it fills.
//
// Discipline (adversarially reviewed):
//   - single-flight: a tick that finds a run still in flight is a no-op --
//     generations must never pile up on the worker chain
//   - the stale pick is computed INSIDE the guarded run, against the current
//     cache, so consecutive runs never regenerate the same agent twice
//   - per-call timeout (5min) + timeoutAsError so a wedged generation cannot
//     hold the worker for the 20min global default nor cache an apology text
//   - failure backoff + privacy-rejection markers live in capabilities.ts
//   - federation disabled -> idle (no LLM spend for a feature that is off)
import { logger } from '../../logger.js'
import { runAgent } from '../../agent.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import { getFederationConfig } from './config.js'
import { catalogAgentNames } from './local-catalog.js'
import {
  CAPABILITY_GENERATION_TIMEOUT_MS,
  generateOneSummary,
  pickStaleAgents,
  pruneCapabilityCache,
  readCapabilityCache,
  readSummarySource,
  summarySourceHash,
} from './capabilities.js'

export const CAPABILITY_RUNNER_INITIAL_DELAY_MS = 65_000 // free slot (5/10/20/25/30/35/40/45/50/55/90 taken)
export const CAPABILITY_RUNNER_INTERVAL_MS = 5 * 60_000
// Cold start (empty cache) may take a slightly bigger batch so a fresh
// enable does not need an hour to populate a 5-agent fleet; steady state
// regenerates one at a time.
const COLD_START_BATCH = 3

let inflight: Promise<void> | null = null

function resolveLang(): 'hu' | 'en' {
  try {
    return getEffectiveSettingValue('DASHBOARD_LANG') === 'en' ? 'en' : 'hu'
  } catch {
    return 'hu'
  }
}

async function runOnce(): Promise<void> {
  const cfg = getFederationConfig()
  if (!cfg.enabled) return
  const names = catalogAgentNames()
  pruneCapabilityCache(new Set(names))
  const cache = readCapabilityCache()
  const lang = resolveLang()
  const candidates = names.map((name) => ({ name, sourceHash: summarySourceHash(readSummarySource(name), lang) }))
  const batch = pickStaleAgents(candidates, cache, Date.now(), Object.keys(cache).length === 0 ? COLD_START_BATCH : 1)
  for (const name of batch) {
    // Per-item isolation: one failed generation must not abort the batch.
    try {
      await generateOneSummary(name, lang, async (prompt) => {
        const r = await runAgent(prompt, undefined, undefined, false, undefined, undefined, {
          timeoutMs: CAPABILITY_GENERATION_TIMEOUT_MS,
          timeoutAsError: true,
        })
        return { text: r.text, error: r.error }
      })
    } catch (err) {
      logger.warn({ err, agent: name }, 'capability runner: generation attempt threw')
    }
  }
}

function tick(): void {
  if (inflight) return // single-flight: never enqueue a second run
  inflight = runOnce()
    .catch((err) => logger.warn({ err }, 'capability runner: tick error'))
    .finally(() => { inflight = null })
}

export function startCapabilitySummaryRunner(): NodeJS.Timeout {
  setTimeout(tick, CAPABILITY_RUNNER_INITIAL_DELAY_MS).unref()
  return setInterval(tick, CAPABILITY_RUNNER_INTERVAL_MS)
}

/** Test seam. */
export function _capabilityRunnerTickForTest(): Promise<void> {
  tick()
  return inflight ?? Promise.resolve()
}
