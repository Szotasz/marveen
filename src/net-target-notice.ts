import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { SETTINGS_REGISTRY } from './config-registry.js'
import { logger } from './logger.js'
import { notifyOwner } from './notify.js'
import { getEffectiveSettingValue } from './settings-store.js'

// NETTARGETENV1104: the owner-gated network-target keys (where the shared token, a whole prompt or every memory text
// is sent) keep their documented .env form, so a change can arrive without the Settings page. On every dashboard boot
// the effective ORIGIN (scheme + host + port) of each is compared with the one recorded at the last boot; a difference
// is told to the owner once, with the key name and the old and new origin. The scheme counts (Dani 68849, Samu
// 68838): an https -> http step on the same host sends the token in clear. A path change stays silent. Never the full
// URL: a path or query may carry a secret, and the URL parser leaves any user:password out of the host.
// A key seen for the first time (no record, a deleted record, a key new to it) is recorded; if its origin is not its
// registry default's, the owner is told once ("első rögzítés, nem alapérték"), so a target rewritten before the first
// record does not become the baseline unseen (Samu 68838/68852). Every first record is written to the boot log, origins
// only (Marveen 68843). The record file is on the db-write-gate's protected list (Dani 68849).

/** Where the last seen host of each target key is recorded. */
export function netTargetRecordPath(storeDir: string = STORE_DIR): string {
  return join(storeDir, '.net-target-hosts.json')
}

/** The owner-gated keys, in registry order. */
export function netTargetKeys(): string[] {
  return SETTINGS_REGISTRY.filter((d) => d.ownerGated === true).map((d) => d.key)
}

/**
 * The origin of a target value: scheme + '//' + host (with a non-default port). '(nincs)' when empty, '(érvénytelen)'
 * when it does not parse as a URL with a host.
 */
export function originOf(value: string): string {
  const v = String(value ?? '').trim()
  if (!v) return '(nincs)'
  try {
    const u = new URL(v)
    return u.host ? `${u.protocol}//${u.host}` : '(érvénytelen)'
  } catch { return '(érvénytelen)' }
}

export interface NetTargetDeps {
  current?: () => Record<string, string>
  defaults?: () => Record<string, string>
  read?: () => Record<string, string> | null
  write?: (rec: Record<string, string>) => void
  notify?: (text: string) => Promise<unknown>
}

function defaultCurrent(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of netTargetKeys()) {
    try { out[key] = originOf(String(getEffectiveSettingValue(key) ?? '')) } catch { out[key] = '(érvénytelen)' }
  }
  return out
}

/** Each target key's registry default, as an origin: what a first sight is compared against. */
export function defaultOrigins(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const d of SETTINGS_REGISTRY) if (d.ownerGated === true) out[d.key] = originOf(String(d.default ?? ''))
  return out
}

/**
 * Compares the current target origins with the recorded ones. A difference, and a first sight that is not the default,
 * are told to the owner in ONE notice and recorded only after delivery (a failed send is retried at the next boot). A
 * first sight at the default only records. Never throws. Returns the keys told to the owner.
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
    const defaults = (deps.defaults ?? defaultOrigins)()
    const raw = read()
    const prev: Record<string, string> = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const changed = Object.keys(now).filter((k) => k in prev && prev[k] !== now[k])
    const added = Object.keys(now).filter((k) => !(k in prev))
    if (added.length) {
      logger.info({ recorded: Object.fromEntries(added.map((k) => [k, now[k]])) }, 'net-target: first record of these target origins')
    }
    const firstOff = added.filter((k) => now[k] !== (defaults[k] ?? '(nincs)'))
    const told = [...changed, ...firstOff]
    if (told.length === 0) {
      if (added.length) write({ ...prev, ...now })
      return []
    }
    const lines = [
      ...changed.map((k) => `- ${k}: ${prev[k]} -> ${now[k]}`),
      ...firstOff.map((k) => `- ${k}: ${now[k]} (első rögzítés, nem alapérték)`),
    ]
    const text = [
      '⚠️ Megváltozott vagy először rögzítve nem alapértéken áll egy hálózati cél (ide megy a token, egy prompt vagy a memória szövege):',
      ...lines,
      'Ha nem te állítottad át, nézd meg a .env-et és a Beállítások oldalt, és szólj.',
    ].join('\n')
    logger.warn({ changed, firstNonDefault: firstOff }, 'net-target: a target origin changed or was first seen off its default')
    const sent = await notify(text)
    if (sent === false) return told
    write({ ...prev, ...now })
    return told
  } catch (err) {
    logger.warn({ err }, 'net-target: drift check failed')
    return []
  }
}
