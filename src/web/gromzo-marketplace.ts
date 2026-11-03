// GROMZOMXDINSTALL1102 Q5 (Samu 66755): the gromzo-local plugin marketplace, registered by the
// dashboard, with no `claude plugin` run (a child claude in a channel session kills its poller).
//
// The Bridge's "Gromzo on" stages the gromzo-channel marketplace into
// ~/marveen-local-plugins/gromzo (installer #86, the plugin step, as the agent user). Claude Code
// knows a plugin from two shared files under ~/.claude/plugins, which every agent start copies
// into the agent's own config dir (provisionIsolatedConfigDir, seeded on EVERY start). This
// function writes the gromzo-local entries there if they are missing, in the shape the live
// install carries (a "directory" marketplace; an installed entry with the version).
//
// MEASURED (Claude Code 2.1.316, a throwaway CLAUDE_CONFIG_DIR, no plugin started): entries written
// this way are accepted: `claude plugin list` shows gromzo-channel@gromzo-local enabled, "Read
// from" the marketplace dir itself (installPath), and `plugin details` finds its `gromzo` MCP server.
//
// It never overwrites: an existing gromzo-local pointing elsewhere is the owner's own setup
// ('other_path'), an unreadable file is left alone ('failed'). Writes are atomic and keep every
// other key and the file's mode.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const GROMZO_MARKETPLACE = 'gromzo-local'
export const GROMZO_PLUGIN_KEY = 'gromzo-channel@gromzo-local'

export type GromzoMarketplaceResult = 'present' | 'registered' | 'no_plugin' | 'other_path' | 'failed'

export interface GromzoMarketplaceOpts {
  /** The shared ~/.claude/plugins dir. */
  pluginsDir: string
  /** Where the staged marketplace lives (~/marveen-local-plugins/gromzo). */
  pluginRoot: string
  /** The project path of the installed entry (each agent's seeding re-points it at its own cwd). */
  projectRoot: string
  now?: () => Date
}

/** The staged marketplace's plugin version, or null when the dir is not a gromzo-local marketplace. */
export function stagedGromzoVersion(pluginRoot: string): string | null {
  try {
    const mp = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'marketplace.json'), 'utf-8')) as { name?: unknown }
    if (mp.name !== GROMZO_MARKETPLACE) return null
    const pj = JSON.parse(readFileSync(join(pluginRoot, 'gromzo-channel', '.claude-plugin', 'plugin.json'), 'utf-8')) as { version?: unknown }
    return typeof pj.version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(pj.version) ? pj.version : null
  } catch {
    return null
  }
}

/** undefined: absent; null: present but not a JSON object (never overwritten). */
function readJsonObject(path: string): Record<string, unknown> | undefined | null {
  if (!existsSync(path)) return undefined
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function writeJsonAtomicKeepMode(path: string, value: unknown): void {
  let mode = 0o600
  try { mode = statSync(path).mode & 0o777 } catch { /* new file */ }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode })
  renameSync(tmp, path)
}

export function ensureGromzoMarketplace(o: GromzoMarketplaceOpts): GromzoMarketplaceResult {
  const version = stagedGromzoVersion(o.pluginRoot)
  if (!version) return 'no_plugin'
  const now = (o.now ?? (() => new Date()))().toISOString()
  const knownPath = join(o.pluginsDir, 'known_marketplaces.json')
  const installedPath = join(o.pluginsDir, 'installed_plugins.json')
  const known = readJsonObject(knownPath)
  const installed = readJsonObject(installedPath)
  if (known === null || installed === null) return 'failed'
  if (!existsSync(o.pluginsDir)) return 'failed'

  let wrote = false
  const k = known ?? {}
  const entry = k[GROMZO_MARKETPLACE] as { source?: { source?: unknown; path?: unknown } } | undefined
  if (entry) {
    if (entry.source?.source !== 'directory' || entry.source?.path !== o.pluginRoot) return 'other_path'
  } else {
    k[GROMZO_MARKETPLACE] = { source: { source: 'directory', path: o.pluginRoot }, installLocation: o.pluginRoot, lastUpdated: now }
    writeJsonAtomicKeepMode(knownPath, k)
    wrote = true
  }

  const inst = installed ?? { version: 2, plugins: {} }
  const plugins = (inst.plugins && typeof inst.plugins === 'object' && !Array.isArray(inst.plugins) ? inst.plugins : {}) as Record<string, unknown>
  const rows = plugins[GROMZO_PLUGIN_KEY]
  if (!Array.isArray(rows) || rows.length === 0) {
    plugins[GROMZO_PLUGIN_KEY] = [{
      scope: 'project',
      projectPath: o.projectRoot,
      installPath: join(o.pluginRoot, 'gromzo-channel'),
      version,
      installedAt: now,
      lastUpdated: now,
    }]
    inst.plugins = plugins
    if (inst.version === undefined) inst.version = 2
    writeJsonAtomicKeepMode(installedPath, inst)
    wrote = true
  }
  return wrote ? 'registered' : 'present'
}
