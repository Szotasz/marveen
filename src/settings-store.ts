import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { readEnvFile } from './env.js'
import { atomicWriteFileSync } from './web/atomic-write.js'
import { getSettingDefinition, validateSettingValue, type SettingDefinition } from './config-registry.js'

// Writable override layer for registry-backed settings. Resolution order for
// any registered key is: config-overrides.json > .env > registry default.
// Writes are atomic (tmp file + rename, via atomicWriteFileSync) so a crash
// mid-write can never leave a half-written or zero-byte overrides file. A
// directory watch keeps the in-memory cache in sync if the file is edited
// outside this process (e.g. by hand over SSH); our own writes update the
// cache directly without waiting for the watch event.
export const OVERRIDES_PATH = join(STORE_DIR, 'config-overrides.json')

let cache: Record<string, string | number> = {}
let watcher: FSWatcher | undefined

function loadFromDisk(): Record<string, string | number> {
  try {
    if (!existsSync(OVERRIDES_PATH)) return {}
    const raw = readFileSync(OVERRIDES_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return {}
  } catch {
    return {}
  }
}

cache = loadFromDisk()

// Lazily start the directory watch on first use rather than at import time,
// so importing this module in a test (no STORE_DIR yet) does not throw.
function ensureWatching(): void {
  if (watcher) return
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    watcher = watch(STORE_DIR, { persistent: false }, (_event, filename) => {
      if (filename === 'config-overrides.json') cache = loadFromDisk()
    })
  } catch {
    // Best-effort: if the platform/FS doesn't support watching the
    // directory, the cache simply stays as of the last read/write from this
    // process -- still correct for the common single-process case.
  }
}

export function getOverrides(): Record<string, string | number> {
  ensureWatching()
  return { ...cache }
}

function coerce(def: SettingDefinition, raw: string | number): string | number {
  if (def.type === 'int') return typeof raw === 'number' ? raw : parseInt(raw, 10)
  return String(raw)
}

// Resolves the effective value for a registered key: override > .env >
// registry default. Reads .env fresh (cheap, scoped to one key) rather than
// relying on the boot-time config.ts constants, so this resolution stays
// correct independent of when the process last restarted.
export function getEffectiveSettingValue(key: string): string | number {
  ensureWatching()
  const def = getSettingDefinition(key)
  if (!def) throw new Error(`Unknown setting key: ${key}`)
  if (key in cache) return coerce(def, cache[key])
  const envValue = readEnvFile([key])[key]
  if (envValue !== undefined) return coerce(def, envValue)
  return def.default
}

export interface SetOverrideResult {
  ok: boolean
  error?: string
}

// Validates against the registry, then atomically persists the whole
// overrides file and updates the in-memory cache. Validation happens before
// any disk write, so an invalid value never reaches the file -- combined
// with the atomic write, a failure at any point leaves the previous state
// fully intact (no partial save).
export function setOverride(key: string, rawValue: unknown): SetOverrideResult {
  const def = getSettingDefinition(key)
  if (!def) return { ok: false, error: `Ismeretlen kulcs: ${key}` }

  const validation = validateSettingValue(def, rawValue)
  if (!validation.ok) return { ok: false, error: validation.error }

  ensureWatching()
  mkdirSync(STORE_DIR, { recursive: true })
  const next = { ...loadFromDisk(), [key]: validation.value! }
  atomicWriteFileSync(OVERRIDES_PATH, JSON.stringify(next, null, 2))
  cache = next
  return { ok: true }
}

// Test-only escape hatch: forces the in-memory cache back to whatever is
// currently on disk (or empty if absent), bypassing the watch debounce.
export function reloadOverridesForTest(): void {
  cache = loadFromDisk()
}
