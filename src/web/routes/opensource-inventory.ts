import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../../config.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import { parseOssNotesDirs, parseOssOwnOwners } from '../../config-registry.js'
import { AGENTS_BASE_DIR } from '../agent-config.js'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

// "Adopted open-source projects": the open-source code the agents vendored
// into their own folders (skills rewritten from GitHub repos, pinned npm
// packages, Python venvs, git clones, npx MCP servers). The connectors page's
// "GitHub repos" counter only sees repos installed through the dashboard, so
// it reads 0 while the fleet may in fact run on dozens of adopted projects,
// and a 0 is easily taken at face value.
//
// The inventory itself is built by scripts/opensource-inventory.py (read-only,
// no network, deterministic) into store/opensource-inventory.json. This route
// serves that file, regenerating it when it is missing, older than an hour, or
// on ?refresh=1. Bearer-gated like every /api/* route (the gate in web.ts
// answers 401 before any handler runs); strictly GET.
//
// The research-notes folders come from the OSS_INVENTORY_NOTES_DIRS setting
// (store/config-overrides.json, .env, default "research"), read on every
// regeneration and passed to the generator as --notes-dir.
//
// Clones: clones the scan reaches that have a readable http(s) or ssh origin
// are listed unless their origin owner name is in OSS_INVENTORY_OWN_OWNERS
// (passed as --own-owner); a matched clone is counted in
// summary.unlisted_clones (by_reason.owner_in_setting). What the scan does not
// look inside: scripts/opensource-inventory.py, "Git clones". Ownership is not
// inferred from the installation's remotes. Clones without a readable http(s)
// or ssh origin are counted, not listed (by_reason.no_http_ssh_origin).

export const INVENTORY_MAX_AGE_MS = 60 * 60 * 1000
const GENERATOR_TIMEOUT_MS = 60_000

export interface InventoryPaths {
  script: string
  out: string
  agentsDir: string
  python: string
}

function defaultPaths(): InventoryPaths {
  return {
    script: join(PROJECT_ROOT, 'scripts', 'opensource-inventory.py'),
    out: join(STORE_DIR, 'opensource-inventory.json'),
    agentsDir: AGENTS_BASE_DIR,
    python: 'python3',
  }
}

let paths: InventoryPaths = defaultPaths()
let inflight: Promise<void> | null = null

/** Test seam: point the route at a fixture tree. Pass null to restore. */
export function _setInventoryPathsForTest(p: Partial<InventoryPaths> | null): void {
  paths = p ? { ...defaultPaths(), ...p } : defaultPaths()
  inflight = null
}

/** The generator's --notes-dir arguments from the OSS_INVENTORY_NOTES_DIRS
 *  setting. An invalid stored value (hand-edited .env) is an error, not a
 *  silent fallback, so the page shows why the notes are not read. */
export function notesDirArgs(): string[] {
  const raw = String(getEffectiveSettingValue('OSS_INVENTORY_NOTES_DIRS') ?? '')
  const dirs = parseOssNotesDirs(raw)
  if (!dirs) throw new Error('invalid OSS_INVENTORY_NOTES_DIRS value')
  return dirs.flatMap((d) => ['--notes-dir', d])
}

/** The generator's --own-owner arguments from the OSS_INVENTORY_OWN_OWNERS
 *  setting; an invalid stored value is an error, like the notes setting. */
export function ownOwnerArgs(): string[] {
  const raw = String(getEffectiveSettingValue('OSS_INVENTORY_OWN_OWNERS') ?? '')
  const owners = parseOssOwnOwners(raw)
  if (!owners) throw new Error('invalid OSS_INVENTORY_OWN_OWNERS value')
  return owners.flatMap((o) => ['--own-owner', o])
}

function regenerate(): Promise<void> {
  // Coalesce: a page load and a refresh click landing together run the
  // generator once, not twice against the same output file.
  if (inflight) return inflight
  const p = paths
  let settingArgs: string[]
  try {
    settingArgs = [...notesDirArgs(), ...ownOwnerArgs()]
  } catch (err) {
    return Promise.reject(err)
  }
  inflight = new Promise<void>((resolve, reject) => {
    execFile(
      p.python,
      [p.script, '--agents-dir', p.agentsDir, ...settingArgs, '--out', p.out],
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

export async function tryHandleOpensourceInventory(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (path !== '/api/opensource-inventory' || method !== 'GET') return false

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
      logger.warn({ err: regenError }, 'opensource-inventory: generator failed')
    }
  }

  let data: Record<string, unknown>
  try {
    data = JSON.parse(readFileSync(paths.out, 'utf-8'))
  } catch {
    // No file at all (first run failed): say so, never an empty inventory --
    // an empty list here would repeat exactly the "0" this view exists to fix.
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
