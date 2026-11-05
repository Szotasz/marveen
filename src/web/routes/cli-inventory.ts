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
// (agent-context, else --help), with a scrubbed environment and a timeout:
// the CLI_INVENTORY_DIRS setting (store/config-overrides.json, .env, default
// ~/printing-press/library) must name only folders whose binaries the owner
// trusts. It is read on every regeneration and passed as --dir.

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

/** The generator's --dir arguments from the CLI_INVENTORY_DIRS setting. An
 *  invalid stored value (hand-edited .env) is an error, not a silent
 *  fallback, so the page shows why the folders are not read. */
export function cliDirArgs(): string[] {
  const raw = String(getEffectiveSettingValue('CLI_INVENTORY_DIRS') ?? '')
  const dirs = parseCliInventoryDirs(raw)
  if (!dirs) throw new Error('invalid CLI_INVENTORY_DIRS value')
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
  const { res, path, method, url } = ctx
  if (path !== '/api/cli-inventory' || method !== 'GET') return false

  const refresh = url.searchParams.get('refresh') === '1'
  const now = Date.now()
  const age = fileAgeMs(paths.out, now)
  const stale = age === null || age > INVENTORY_MAX_AGE_MS
  let regenerated = false
  let regenError: string | null = null

  if (refresh || stale) {
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
    cache: {
      regenerated,
      age_seconds: finalAge === null ? null : Math.round(finalAge / 1000),
      max_age_seconds: INVENTORY_MAX_AGE_MS / 1000,
      // A failed regeneration serves the previous file, but visibly.
      regen_error: regenError,
    },
  })
  return true
}
