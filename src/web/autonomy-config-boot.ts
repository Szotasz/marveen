// EMAILMAX3-1115: the dashboard runs the autonomy-config seed merge at start, so a release that raises a
// ceiling (email_send maxLevel 2 -> 3) reaches an existing install on the restart that brings the new dist,
// the same day, not one update.sh run later. One logic: this imports scripts/lib/autonomy-config-merge.mjs,
// the file update.sh runs. Idempotent (no change, no write); the level is never touched; a raise applies
// only while the install still holds the factory value. The dashboard process may write
// store/autonomy-config.json (routes/autonomy.ts does); the db-write-gate stops an AGENT from writing it.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'

export interface AutonomyBootMergeResult {
  readonly added: number
  readonly raised: readonly string[]
  readonly wrote: boolean
  readonly line: string
}

/** null when there is nothing to merge (no script, no seed, or no config yet: the installer seeds that). */
export async function mergeAutonomyConfigAtBoot(
  opts: { readonly root?: string; readonly store?: string } = {},
): Promise<AutonomyBootMergeResult | null> {
  const root = opts.root ?? PROJECT_ROOT
  const script = join(root, 'scripts', 'lib', 'autonomy-config-merge.mjs')
  const seed = join(root, 'seed-config', 'autonomy-config.json')
  const target = join(opts.store ?? STORE_DIR, 'autonomy-config.json')
  if (!existsSync(script) || !existsSync(seed) || !existsSync(target)) return null
  const mod = (await import(pathToFileURL(script).href)) as {
    mergeAutonomyConfigFiles: (seedPath: string, targetPath: string) => { added: number; raised: string[]; wrote: boolean }
    describeMerge: (r: { added: number; raised: string[] }) => string
  }
  const r = mod.mergeAutonomyConfigFiles(seed, target)
  return { ...r, line: mod.describeMerge(r) }
}
