// The dashboard's Security switches (src/config-registry.ts, module 'security'), read from a hook.
//
// The value comes from store/config-overrides.json only (an empty string included), then the default
// the caller passes. The install .env is NOT read: a loosening write to the overrides file needs an
// owner credential (SettingDefinition.loosens on the settings route), a line in .env does not, so a
// .env source would let a gate be loosened around the owner-only rule. The registry marks these keys
// `overridesOnly`, so the dashboard shows the value the hooks use. A hook cannot import the
// dashboard's settings store (it lives in dist/ and pulls in the logger), so this is the small,
// dependency-free copy of that lookup.
//
// Fail safe: an unreadable or malformed overrides file, or a value outside `allowed`, reads as the
// default, and every default the callers pass is the strict, shipped behaviour. A sub-agent cannot
// write config-overrides.json (self-pace-gate PROTECTED_STORE_FILES).
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

// The effective value of `key`, or `fallback` when it is unset or (with `allowed`) not one of the
// allowed values.
export function securitySetting(key, fallback, allowed = null, root = securitySettingsRoot()) {
  const v = overrideValue(root, key)
  if (v === undefined) return fallback
  const t = v.trim()
  if (allowed && !allowed.includes(t)) return fallback
  return t
}
