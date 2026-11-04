import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { SETTINGS_REGISTRY } from './config-registry.js'
import { logger } from './logger.js'
import { notifyOwner } from './notify.js'
import { getEffectiveSettingValue } from './settings-store.js'

// NETTARGETENV1104: the owner-gated network-target keys (where the shared token, a whole prompt or every memory text
// is sent) keep their documented .env form, so a change can arrive without the Settings page. On every dashboard boot
// the effective HOST of each is compared with the one recorded at the last boot; a difference is told to the owner
// once, with the key name and the old and new host. Never the full URL: a path or query may carry a secret, and the
// URL parser leaves any user:password out of the host.

/** Where the last seen host of each target key is recorded. */
export function netTargetRecordPath(storeDir: string = STORE_DIR): string {
  return join(storeDir, '.net-target-hosts.json')
}

/** The owner-gated keys, in registry order. */
export function netTargetKeys(): string[] {
  return SETTINGS_REGISTRY.filter((d) => d.ownerGated === true).map((d) => d.key)
}

/** The host (with port) of a target value: '(nincs)' when empty, '(érvénytelen)' when it does not parse as a URL. */
export function hostOf(value: string): string {
  const v = String(value ?? '').trim()
  if (!v) return '(nincs)'
  try { return new URL(v).host || '(érvénytelen)' } catch { return '(érvénytelen)' }
}

export interface NetTargetDeps {
  current?: () => Record<string, string>
  read?: () => Record<string, string> | null
  write?: (rec: Record<string, string>) => void
  notify?: (text: string) => Promise<unknown>
}

function defaultCurrent(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of netTargetKeys()) {
    try { out[key] = hostOf(String(getEffectiveSettingValue(key) ?? '')) } catch { out[key] = '(érvénytelen)' }
  }
  return out
}

/**
 * Compares the current target hosts with the recorded ones. The first sight (no record) only records. A difference is
 * told to the owner in ONE notice and recorded only after delivery (a failed send is retried at the next boot).
 * Never throws. Returns the keys whose host changed.
 */
export async function noticeNetTargetDrift(deps: NetTargetDeps = {}): Promise<string[]> {
  const read = deps.read ?? (() => {
    try { const f = netTargetRecordPath(); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) as Record<string, string> : null } catch { return null }
  })
  const write = deps.write ?? ((rec: Record<string, string>) => {
    try { writeFileSync(netTargetRecordPath(), JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 }) } catch (err) { logger.warn({ err }, 'net-target: record could not be written') }
  })
  const notify = deps.notify ?? ((text: string) => notifyOwner(text))
  try {
    const now = (deps.current ?? defaultCurrent)()
    const prev = read()
    if (prev === null || typeof prev !== 'object' || Array.isArray(prev)) { write(now); return [] }
    const changed = Object.keys(now).filter((k) => k in prev && prev[k] !== now[k])
    const added = Object.keys(now).filter((k) => !(k in prev))
    if (changed.length === 0) {
      if (added.length) write({ ...prev, ...now })
      return []
    }
    const lines = changed.map((k) => `- ${k}: ${prev[k]} -> ${now[k]}`)
    const text = [
      '⚠️ Megváltozott egy hálózati cél (ide megy a token, egy prompt vagy a memória szövege):',
      ...lines,
      'Ha nem te állítottad át, nézd meg a .env-et és a Beállítások oldalt, és szólj.',
    ].join('\n')
    logger.warn({ keys: changed }, 'net-target: a target host changed since the last boot')
    const sent = await notify(text)
    if (sent === false) return changed
    write({ ...prev, ...now })
    return changed
  } catch (err) {
    logger.warn({ err }, 'net-target: drift check failed')
    return []
  }
}
