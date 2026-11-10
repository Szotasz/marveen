import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../../config.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import { parseCliInventoryDirs } from '../../config-registry.js'
import { AGENTS_BASE_DIR } from '../agent-config.js'
import { globalSkillsRoot } from '../skill-quarantine.js'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { mayActAsOwner, refuseOwner } from './auth.js'
import type { RouteContext } from './types.js'

// CLI inventory: the command-line tools the fleet can run (Printing Press
// CLIs for now). The connectors page lists MCP servers only, so a CLI that
// reaches a live account runs out of the owner's sight.
//
// The inventory itself is built by scripts/cli-inventory.py (no network of its
// own, deterministic) into store/cli-inventory.json. This route serves that
// file, regenerating it when it is missing, older than an hour, or on
// ?refresh=1. Bearer-gated like every /api/* route (the gate in web.ts answers
// 401 before any handler runs); strictly GET. The structure mirrors the
// adopted open-source inventory route (opensource-inventory.ts) on purpose.
//
// The generator RUNS each *-pp-cli binary it finds in the configured folders
// (agent-context, else --help), with a scrubbed environment and a timeout.
// Two rules follow from that:
//  - OFF BY DEFAULT: the CLI_INVENTORY_DIRS setting (owner-only, overrides-only)
//    is empty until the owner names folders whose binaries they trust; empty
//    means no inventory and no run ({ enabled: false }). It is read on every
//    request and passed to the generator as --dir.
//  - ONLY THE OWNER STARTS A RUN: a refresh, or the regeneration of a missing
//    or stale file, needs the owner gate (mayActAsOwner). Any other caller gets
//    the saved file (or { pending: true } when there is none yet) without a
//    run, and ?refresh=1 from it is a 403, as for every other owner action.

export const INVENTORY_MAX_AGE_MS = 60 * 60 * 1000
const GENERATOR_TIMEOUT_MS = 120_000

export interface CliInventoryPaths {
  script: string
  out: string
  agentsDir: string
  skillsDir: string
  python: string
}

function defaultPaths(): CliInventoryPaths {
  return {
    script: join(PROJECT_ROOT, 'scripts', 'cli-inventory.py'),
    out: join(STORE_DIR, 'cli-inventory.json'),
    agentsDir: AGENTS_BASE_DIR,
    skillsDir: globalSkillsRoot(),
    python: 'python3',
  }
}

let paths: CliInventoryPaths = defaultPaths()
let inflight: Promise<void> | null = null

/** Test seam: point the route at a fixture tree. Pass null to restore. */
export function _setCliInventoryPathsForTest(p: Partial<CliInventoryPaths> | null): void {
  paths = p ? { ...defaultPaths(), ...p } : defaultPaths()
  inflight = null
}

/** The configured folders: [] when the setting is empty (the inventory is
 *  off), null when the stored value is invalid. */
function configuredDirs(): string[] | null {
  return parseCliInventoryDirs(String(getEffectiveSettingValue('CLI_INVENTORY_DIRS') ?? ''))
}

/** The generator's --dir arguments from the CLI_INVENTORY_DIRS setting. An
 *  invalid stored value is an error, not a silent fallback, so the page shows
 *  why the folders are not read; an empty one never starts a run. */
export function cliDirArgs(): string[] {
  const dirs = configuredDirs()
  if (!dirs) throw new Error('invalid CLI_INVENTORY_DIRS value')
  if (dirs.length === 0) throw new Error('CLI_INVENTORY_DIRS is empty: the inventory is off')
  return dirs.flatMap((d) => ['--dir', d])
}

function regenerate(): Promise<void> {
  // Coalesce: a page load and a refresh click landing together run the
  // generator once, not twice against the same output file.
  if (inflight) return inflight
  const p = paths
  let dirArgs: string[]
  try {
    dirArgs = cliDirArgs()
  } catch (err) {
    return Promise.reject(err)
  }
  inflight = new Promise<void>((resolve, reject) => {
    execFile(
      p.python,
      [p.script, ...dirArgs, '--skills-dir', p.skillsDir, '--agents-dir', p.agentsDir, '--out', p.out],
      { timeout: GENERATOR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          const tail = String(stderr || '').trim().split('\n').slice(-3).join(' | ')
          reject(new Error(`${err.message}${tail ? `: ${tail}` : ''}`))
          return
        }
        resolve()
      },
    )
  }).finally(() => { inflight = null })
  return inflight
}

function fileAgeMs(file: string, now: number): number | null {
  try {
    return now - statSync(file).mtimeMs
  } catch {
    return null
  }
}

export async function tryHandleCliInventory(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  if (path !== '/api/cli-inventory' || method !== 'GET') return false

  // Off until the owner names a folder: no run, and no earlier file either.
  if (configuredDirs()?.length === 0) {
    json(res, { enabled: false })
    return true
  }

  const refresh = url.searchParams.get('refresh') === '1'
  const now = Date.now()
  const age = fileAgeMs(paths.out, now)
  const stale = age === null || age > INVENTORY_MAX_AGE_MS
  // Asked only when a run is due: the gate writes an audit line for a Bridge key.
  const mayRun = (refresh || stale) && mayActAsOwner(ctx.auth, req)
  if (refresh && !mayRun) {
    refuseOwner(res)
    return true
  }
  // A missing or stale file this caller may not regenerate is served as it is.
  const regenSkipped = stale && !mayRun
  if (regenSkipped && age === null) {
    json(res, { enabled: true, pending: true, regen_skipped: 'owner_session_required' })
    return true
  }
  let regenerated = false
  let regenError: string | null = null

  if (mayRun) {
    try {
      await regenerate()
      regenerated = true
    } catch (err) {
      regenError = err instanceof Error ? err.message : String(err)
      logger.warn({ err: regenError }, 'cli-inventory: generator failed')
    }
  }

  let data: Record<string, unknown>
  try {
    data = JSON.parse(readFileSync(paths.out, 'utf-8'))
  } catch {
    // No file at all (first run failed): say so, never an empty inventory --
    // an empty list would read as "no CLI tools here".
    json(res, { error: 'inventory unavailable', detail: regenError ?? 'no inventory file' }, 500)
    return true
  }
  const finalAge = fileAgeMs(paths.out, Date.now())
  json(res, {
    ...data,
    enabled: true,
    cache: {
      regenerated,
      age_seconds: finalAge === null ? null : Math.round(finalAge / 1000),
      max_age_seconds: INVENTORY_MAX_AGE_MS / 1000,
      // A failed regeneration serves the previous file, but visibly.
      regen_error: regenError,
      // Stale, but only the owner's session starts the generator.
      regen_skipped: regenSkipped ? 'owner_session_required' : null,
    },
  })
  return true
}
