// One autonomy category's level, for a SERVER-side gate (MARVEENGAPS1020 (a)).
//
// The levels in store/autonomy-config.json (1 = only report, 2 = propose and
// wait for approval, 3 = act and report) were until now read only by agent
// prompts and the email approval hook. A route that enforces a level reads it
// here. A missing or unreadable config, or a missing key, is level 1: the level
// the seed-config ships for every category, so a deleted or broken config never
// switches a gate to its most permissive setting (docs/heartbeat-autonomy.md).
// `maxLevel` caps the configured level, as the dashboard does.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'

export type AutonomyLevel = 1 | 2 | 3
export interface AutonomyReading {
  level: AutonomyLevel
  source: 'config' | 'missing-key' | 'missing-config' | 'unreadable'
}

export function autonomyConfigPath(): string {
  return join(STORE_DIR, 'autonomy-config.json')
}

export function readAutonomyLevel(key: string, path: string = autonomyConfigPath()): AutonomyReading {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    return { level: 1, source: (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing-config' : 'unreadable' }
  }
  try {
    const cfg = JSON.parse(text) as { categories?: Array<{ key?: unknown; level?: unknown; maxLevel?: unknown }> }
    const cat = (cfg.categories ?? []).find((c) => c && c.key === key)
    if (!cat) return { level: 1, source: 'missing-key' }
    const raw = Number(cat.level)
    if (!Number.isInteger(raw)) return { level: 1, source: 'unreadable' }
    const cap = Number.isInteger(cat.maxLevel) ? (cat.maxLevel as number) : 3
    const level = Math.max(1, Math.min(3, raw, cap)) as AutonomyLevel
    return { level, source: 'config' }
  } catch {
    return { level: 1, source: 'unreadable' }
  }
}
