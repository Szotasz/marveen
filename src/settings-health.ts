import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'
import { notifyOwner } from './notify.js'
import { getIgnoredEnvKeys, getOverridesFileState, getOverridesOnlyKeys, onOverridesReload } from './settings-store.js'

// ENVRELAXGATE1104 step 2: the two states of the settings layer the owner must SEE, because each one silently changes
// a security control.
//  1. A .env line that the overrides-only rule ignores (it would loosen a security key). Named in the boot log, the
//     update output and the Settings page; never on Slack (Dani 67934: the very key ignored may be the notice target).
//  2. An unreadable config-overrides.json. Every override drops out, a TIGHTENING one too (e.g. VAULT_ACL_MODE=enforce
//     saved on the dashboard), so this is a security step back. Boot log, the Settings page, and ONE owner notice per
//     state change (Samu 67962), recorded in a store file so a restart does not repeat it.
// Both messages carry key NAMES and the file state only, never a value.

/** Where the last notified overrides state is recorded ('ok' or 'unreadable'). */
export function overridesHealthStatePath(storeDir: string = STORE_DIR): string {
  return join(storeDir, '.overrides-health-state')
}

/** Boot log: one line per ignored .env key, the name only. Returns the names (for tests). */
export function logIgnoredEnvKeys(keys: string[] = getIgnoredEnvKeys()): string[] {
  for (const key of keys) {
    logger.warn({ key }, `settings: the .env line for ${key} is IGNORED (it would loosen a security control; set it on the Settings page instead)`)
  }
  return keys
}

export function unreadableNotice(cause: string | undefined, keys: string[]): string {
  return [
    `⚠️ A store/config-overrides.json nem olvasható (ok: ${cause ?? 'ismeretlen'}).`,
    'Amíg így marad, a dashboardon mentett MINDEN beállítás kiesik, a szigorítók is.',
    `Ezek a biztonsági kulcsok most az alapértéken állnak (vagy a .env szigorító során): ${keys.join(', ')}.`,
    'Teendő: a fájl helyreállítása (jogosultság vagy JSON-hiba).',
  ].join('\n')
}

export const RECOVERED_NOTICE = '✅ A store/config-overrides.json újra olvasható: a dashboardon mentett beállítások ismét hatnak.'

export interface OverridesHealthDeps {
  state?: () => { state: string; cause?: string }
  keys?: () => string[]
  read?: () => string | null
  write?: (v: string) => void
  notify?: (text: string) => Promise<unknown>
}

/**
 * Checks config-overrides.json and tells the owner once per state change: on turning unreadable, and on recovering.
 * The first sight of a readable file only records. Never throws. Returns whether a notice went out (a notifier that
 * resolves to false, or throws, counts as not delivered, and the state stays unrecorded so the next check retries).
 */
export async function checkOverridesHealth(deps: OverridesHealthDeps = {}): Promise<{ state: 'ok' | 'unreadable'; notified: boolean }> {
  const read = deps.read ?? (() => { try { const f = overridesHealthStatePath(); return existsSync(f) ? readFileSync(f, 'utf-8').trim() : null } catch { return null } })
  const write = deps.write ?? ((v: string) => { try { writeFileSync(overridesHealthStatePath(), v + '\n', { mode: 0o600 }) } catch (err) { logger.warn({ err }, 'settings: overrides health state could not be recorded') } })
  const notify = deps.notify ?? ((text: string) => notifyOwner(text))
  let current: 'ok' | 'unreadable' = 'ok'
  try {
    const file = (deps.state ?? getOverridesFileState)()
    current = file.state === 'unreadable' ? 'unreadable' : 'ok'
    const keys = (deps.keys ?? getOverridesOnlyKeys)()
    if (current === 'unreadable') {
      logger.error({ cause: file.cause, keys }, 'settings: config-overrides.json is UNREADABLE: every saved override is dropped, tightening ones too')
    }
    const last = read()
    if (last === current || (last === null && current === 'ok')) {
      if (last === null) write(current)
      return { state: current, notified: false }
    }
    // Recorded only after a delivered notice: a failed or channel-less send is tried again at the next check.
    const sent = await notify(current === 'unreadable' ? unreadableNotice(file.cause, keys) : RECOVERED_NOTICE)
    if (sent === false) return { state: current, notified: false }
    write(current)
    return { state: current, notified: true }
  } catch (err) {
    logger.warn({ err }, 'settings: overrides health check failed')
    return { state: current, notified: false }
  }
}

/** Dashboard boot: log the ignored .env keys, check the overrides file now and after every outside edit of it. */
export function startSettingsHealth(): void {
  logIgnoredEnvKeys()
  void checkOverridesHealth()
  onOverridesReload(() => { void checkOverridesHealth() })
}
