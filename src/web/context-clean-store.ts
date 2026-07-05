import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  normalizeContextCleanConfig,
  defaultContextCleanForModel,
  type ContextCleanConfig,
} from '../context-clean.js'

// Per-agent context-clean config lives in one JSON map keyed by agent name,
// mirroring auto-restart.json. An agent with no entry gets the model-appropriate
// default (a [1m] model warms at 400k/500k; a standard ~200k-window model far
// lower, at 120k/160k), so the feature works out of the box and is tunable per
// agent by editing this file.
const STORE_PATH = join(PROJECT_ROOT, 'store', 'context-clean.json')

function readRaw(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * One agent's config, normalized. When there is no explicit entry, the
 * model-appropriate default is returned (pass the agent's resolved model id so a
 * standard-window model gets the lower thresholds). A partial explicit entry
 * falls back field-by-field onto that same model-appropriate base.
 */
export function readContextCleanConfig(name: string, model?: string | null): ContextCleanConfig {
  const base = defaultContextCleanForModel(model)
  const raw = readRaw()
  return name in raw ? normalizeContextCleanConfig(raw[name], base) : base
}

/** Persist one agent's config (normalized first so the store stays clean). */
export function writeContextCleanConfig(name: string, cfg: unknown, model?: string | null): ContextCleanConfig {
  const normalized = normalizeContextCleanConfig(cfg, defaultContextCleanForModel(model))
  const raw = readRaw()
  raw[name] = normalized
  atomicWriteFileSync(STORE_PATH, JSON.stringify(raw, null, 2))
  return normalized
}
