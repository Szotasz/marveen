import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  normalizeModelFallbackConfig,
  DEFAULT_MODEL_FALLBACK,
  type ModelFallbackConfig,
} from '../model-fallback.js'

// Single global config for the model-fallback-on-limit feature (one safety-net
// policy for the whole fleet, unlike per-agent auto-restart). Default disabled,
// so an upgrade is inert until the operator turns it on from the dashboard.
const STORE_PATH = join(PROJECT_ROOT, 'store', 'model-fallback.json')

export function readModelFallbackConfig(): ModelFallbackConfig {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    return normalizeModelFallbackConfig(parsed)
  } catch {
    return { ...DEFAULT_MODEL_FALLBACK, chain: [...DEFAULT_MODEL_FALLBACK.chain] }
  }
}

export function writeModelFallbackConfig(cfg: Partial<ModelFallbackConfig>): ModelFallbackConfig {
  const current = readModelFallbackConfig()
  const merged = normalizeModelFallbackConfig({ ...current, ...cfg })
  atomicWriteFileSync(STORE_PATH, JSON.stringify(merged, null, 2))
  return merged
}
