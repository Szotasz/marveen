// The dashboard's Security switches (src/config-registry.ts, module 'security'), read from a hook.
//
// Same resolution order as the TypeScript settings store (getEffectiveSettingSource): a key present
// in store/config-overrides.json wins (an empty string included), then a KEY= line in the install
// .env, then the default the caller passes. A hook cannot import the dashboard's settings store (it
// lives in dist/ and pulls in the logger), so this is the small, dependency-free copy of that order.
//
// Fail safe: an unreadable or malformed overrides file, or a value outside `allowed`, reads as the
// default, and every default the callers pass is the strict, shipped behaviour. A sub-agent cannot
// write config-overrides.json (self-pace-gate PROTECTED_STORE_FILES), and a loosening write through
// the settings route needs an owner credential (SettingDefinition.loosens).
//
// SECURITY_SETTINGS_ROOT points the reader at another install root (tests).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function securitySettingsRoot() {
  return process.env.SECURITY_SETTINGS_ROOT || DEFAULT_ROOT
}

function overrideValue(root, key) {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'store', 'config-overrides.json'), 'utf-8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, key)) return String(raw[key])
  } catch { /* missing or malformed: no override */ }
  return undefined
}

function envFileValue(root, key) {
  let text
  try { text = readFileSync(join(root, '.env'), 'utf-8') } catch { return undefined }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
    if (!m || m[1] !== key) continue
    let v = m[2].trim()
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1)
    return v
  }
  return undefined
}

// The effective value of `key`, or `fallback` when it is unset or (with `allowed`) not one of the
// allowed values.
export function securitySetting(key, fallback, allowed = null, root = securitySettingsRoot()) {
  const v = overrideValue(root, key) ?? envFileValue(root, key)
  if (v === undefined) return fallback
  const t = v.trim()
  if (allowed && !allowed.includes(t)) return fallback
  return t
}
