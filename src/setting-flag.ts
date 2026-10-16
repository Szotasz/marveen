// One reading of an on/off setting for every runtime reader. src/config.ts
// reads a boolean flag (HEARTBEAT_AGENT_ENABLED, SUBAGENT_TELEGRAM_WAKE_ENABLED,
// ...) as on for any of these values, and scripts/patch-telegram-plugin.py
// (TRUTHY) does the same; the Settings page itself writes "1". A reader that
// accepts only "1" sees a hand-written TELEGRAM_TOPICS_ENABLED=true as off
// while the plugin patch is on: a half-switched install.

import { getEffectiveSettingValue } from './settings-store.js'

export const SETTING_ON_VALUES: readonly string[] = ['1', 'true', 'yes', 'on']

export function isSettingValueOn(raw: unknown): boolean {
  return SETTING_ON_VALUES.includes(String(raw ?? '').trim().toLowerCase())
}

/** The effective value (override > .env > default) read as on/off; an unknown key is off. */
export function isSettingOn(key: string): boolean {
  try { return isSettingValueOn(getEffectiveSettingValue(key)) } catch { return false }
}
