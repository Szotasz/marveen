/**
 * The main agent's co-listen plugins are enabled through a launch-time
 * --settings file, never through a settings layer the sub-agents also read.
 * Twin of scripts/main-extra-plugins-settings.sh (same file, same content);
 * see its header for the measurement (SLACKDMVESZT1006).
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function mainExtraPluginsSettingsPath(installDir: string): string {
  return join(installDir, 'store', '.main-extra-plugins.settings.json')
}

/** Pure: the settings object the flag file carries. */
export function mainExtraPluginsSettings(pluginIds: readonly string[]): { enabledPlugins: Record<string, true> } {
  const enabledPlugins: Record<string, true> = {}
  for (const id of pluginIds) if (id) enabledPlugins[id] = true
  return { enabledPlugins }
}

/**
 * Write the file and return its path, or null when there are no extras (the
 * launch then carries no flag at all). A write failure returns null too: the
 * session still starts, as it did before this flag existed.
 */
export function writeMainExtraPluginsSettings(installDir: string, pluginIds: readonly string[]): string | null {
  const ids = pluginIds.filter(Boolean)
  if (ids.length === 0) return null
  const path = mainExtraPluginsSettingsPath(installDir)
  try {
    mkdirSync(join(installDir, 'store'), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(mainExtraPluginsSettings(ids), null, 2) + '\n')
    renameSync(tmp, path)
    return path
  } catch {
    return null
  }
}
