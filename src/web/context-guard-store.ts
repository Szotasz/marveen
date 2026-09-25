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

/**
 * Arm the context guard for an agent that has JUST been created.
 *
 * A new agent must come up with the guard ON (fleet policy, 2026-09-08). The
 * obvious implementation -- flipping DEFAULT_CONTEXT_GUARD.enabled to true --
 * is the wrong one, because that default is also the answer for every agent
 * that has NO entry, and some of those are deliberate:
 *
 *   - hidden technical workers (agents/heartbeat and friends) run with the
 *     saturation net ONLY; the proactive handoff/restart tiers are switched
 *     off for them on purpose (see context-guard-hidden-worker.test.ts), and
 *     a global default would arm them silently;
 *   - an operator who never opened the guard panel for an existing agent has
 *     not consented to handoff-and-restart cycles on it.
 *
 * Writing an EXPLICIT row at creation time keeps the default-off fallback
 * intact and changes exactly one thing: agents born from here on.
 *
 * Idempotent by design. An agent that already has a row keeps it untouched and
 * the function returns null -- re-running a creation/import path must never
 * overwrite an operator's deliberate `enabled: false`.
 */
export function seedContextGuardForNewAgent(name: string): ContextGuardConfig | null {
  const raw = readRaw()
  if (name in raw) return null
  return writeContextGuardConfig(name, { ...DEFAULT_CONTEXT_GUARD, enabled: true })
}
