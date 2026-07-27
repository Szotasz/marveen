import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { PROJECT_ROOT, DEFAULT_AGENT_MODEL } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  normalizeModelFallbackConfig,
  DEFAULT_MODEL_FALLBACK,
  DEFAULT_MODEL_CHAIN,
  type ModelFallbackConfig,
} from '../model-fallback.js'

// Single global config for the model-fallback-on-limit feature (one safety-net
// policy for the whole fleet, unlike per-agent auto-restart). Default disabled,
// so an upgrade is inert until the operator turns it on from the dashboard.
const STORE_PATH = join(PROJECT_ROOT, 'store', 'model-fallback.json')

// chain[0] is what the runner reverts UP to, so it has to be the model this
// install actually runs -- not the distribution literal in model-fallback.ts
// (kept zero-import there so the decision logic stays trivially testable).
// Without this, an install on a non-default DEFAULT_AGENT_MODEL would "revert"
// onto a model it never ran. Filtered first so a default that already sits
// further down the ladder cannot end up in the chain twice.
export function defaultChainForInstall(): string[] {
  return [DEFAULT_AGENT_MODEL, ...DEFAULT_MODEL_CHAIN.filter((m) => m !== DEFAULT_AGENT_MODEL)]
}

/** True when the stored JSON carries a chain normalize() would actually honour. */
function hasExplicitChain(parsed: unknown): boolean {
  const raw = (parsed && typeof parsed === 'object')
    ? (parsed as Record<string, unknown>).chain
    : undefined
  if (!Array.isArray(raw)) return false
  return raw.filter((m) => typeof m === 'string' && m.trim().length > 0).length >= 2
}

export function readModelFallbackConfig(): ModelFallbackConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
  } catch {
    return { ...DEFAULT_MODEL_FALLBACK, chain: defaultChainForInstall() }
  }
  const cfg = normalizeModelFallbackConfig(parsed)
  // normalize() substitutes the module's literal chain whenever the stored one
  // is missing or too short; swap in the install chain for exactly that case,
  // so an operator-configured chain is still never overridden.
  return hasExplicitChain(parsed) ? cfg : { ...cfg, chain: defaultChainForInstall() }
}

export function writeModelFallbackConfig(cfg: Partial<ModelFallbackConfig>): ModelFallbackConfig {
  const current = readModelFallbackConfig()
  const merged = normalizeModelFallbackConfig({ ...current, ...cfg })
  atomicWriteFileSync(STORE_PATH, JSON.stringify(merged, null, 2))
  return merged
}
