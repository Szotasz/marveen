import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  normalizeContextGuardConfig,
  DEFAULT_CONTEXT_GUARD,
  type ContextGuardConfig,
} from '../context-guard.js'

// Per-agent context-guard config in one JSON map keyed by agent name (the main
// orchestrator included, under its agent id) -- same shape as auto-restart.json.
// Like auto-restart, the guard is DEFAULT-OFF (opt-in): an agent with no entry
// is unprotected until an operator enables it. Default-off keeps the guard from
// double-restarting against the existing context-clean path (#525) until the two
// systems share a trigger.
const STORE_PATH = join(PROJECT_ROOT, 'store', 'context-guard.json')

function readRaw(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** All explicitly-configured agents, normalized. */
export function readAllContextGuardConfigs(): Record<string, ContextGuardConfig> {
  const raw = readRaw()
  const out: Record<string, ContextGuardConfig> = {}
  for (const [name, cfg] of Object.entries(raw)) {
    out[name] = normalizeContextGuardConfig(cfg)
  }
  return out
}

/** One agent's config, normalized; the DISABLED default when unset. */
export function readContextGuardConfig(name: string): ContextGuardConfig {
  const raw = readRaw()
  return name in raw ? normalizeContextGuardConfig(raw[name]) : { ...DEFAULT_CONTEXT_GUARD }
}

/** Persist one agent's config (normalized first so the store stays clean). */
export function writeContextGuardConfig(name: string, cfg: unknown): ContextGuardConfig {
  const normalized = normalizeContextGuardConfig(cfg)
  const raw = readRaw()
  raw[name] = normalized
  atomicWriteFileSync(STORE_PATH, JSON.stringify(raw, null, 2))
  return normalized
}
