import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  normalizeAutoRestartConfig,
  DEFAULT_AUTO_RESTART,
  type AutoRestartConfig,
} from '../auto-restart.js'

// Per-agent auto-restart config lives in one JSON map keyed by agent name
// (the main orchestrator included, under its agent id). A single file keeps the
// main session and sub-agents uniform and sidesteps the per-agent-dir vs
// PROJECT_ROOT config-path split.
const STORE_PATH = join(PROJECT_ROOT, 'store', 'auto-restart.json')

function readRaw(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** All configured agents, normalized. Agents with no entry are simply absent. */
export function readAllAutoRestartConfigs(): Record<string, AutoRestartConfig> {
  const raw = readRaw()
  const out: Record<string, AutoRestartConfig> = {}
  for (const [name, cfg] of Object.entries(raw)) {
    out[name] = normalizeAutoRestartConfig(cfg)
  }
  return out
}

/** One agent's config, normalized; the disabled default when unset. */
export function readAutoRestartConfig(name: string): AutoRestartConfig {
  const raw = readRaw()
  return name in raw ? normalizeAutoRestartConfig(raw[name]) : { ...DEFAULT_AUTO_RESTART }
}

/**
 * Persist a PUT body for one agent: MERGE it over the stored config, so a key
 * the caller leaves out keeps its current value, then normalize the result so
 * the store stays clean.
 *
 * This used to REPLACE the row with the normalized body, and
 * normalize() fills every omitted key with its default. So a body without
 * `enabled` answered 200 {ok:true} while switching auto-restart OFF, and the
 * dashboard's own save -- which never sends openQuestionDeferralCapHours --
 * reset that cap to 24 on every agent it saved.
 *
 * dailyTime and intervalHours are mutually exclusive (normalize() keeps
 * dailyTime when both are set), so a plain merge would make a schedule switch
 * fail silently: `{"intervalHours": 6}` over a stored dailyTime would keep the
 * daily restart and drop the interval. So a VALID value for one of the pair,
 * sent without the other, clears the other. "Valid" is decided by normalize()
 * itself, so the two rules cannot drift apart. A null or malformed value
 * switches nothing: it clears or coerces only its own key, as before.
 *
 * An explicit null is a value, not an omission: `{"dailyTime": null}` still
 * clears the daily schedule. An agent with no row merges over the disabled
 * default, so a partial PUT never enables a restart nobody switched on.
 */
export function writeAutoRestartConfig(name: string, patch: unknown): AutoRestartConfig {
  const raw = readRaw()
  const current = name in raw ? normalizeAutoRestartConfig(raw[name]) : { ...DEFAULT_AUTO_RESTART }
  const fields = (patch && typeof patch === 'object' && !Array.isArray(patch)) ? patch as Record<string, unknown> : {}
  const merged: Record<string, unknown> = { ...current, ...fields }
  if ('dailyTime' in fields && !('intervalHours' in fields) &&
      normalizeAutoRestartConfig({ dailyTime: fields.dailyTime }).dailyTime !== null) {
    merged.intervalHours = null
  }
  if ('intervalHours' in fields && !('dailyTime' in fields) &&
      normalizeAutoRestartConfig({ intervalHours: fields.intervalHours }).intervalHours !== null) {
    merged.dailyTime = null
  }
  const normalized = normalizeAutoRestartConfig(merged)
  raw[name] = normalized
  atomicWriteFileSync(STORE_PATH, JSON.stringify(raw, null, 2))
  return normalized
}
