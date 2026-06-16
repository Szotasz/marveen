import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { SETTINGS_REGISTRY, validateSettingValue } from '../../config-registry.js'
import { getEffectiveSettingValue, setOverride } from '../../settings-store.js'
import { logConfigChange } from '../../db.js'
import type { RouteContext } from './types.js'

export async function tryHandleSettings(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/settings' && method === 'GET') {
    // secret:true entries are filtered out entirely -- not just the value,
    // the whole row -- per spec: a secret's existence is exposed elsewhere
    // (the vault page), not duplicated here.
    const settings = SETTINGS_REGISTRY.filter((def) => !def.secret).map((def) => ({
      key: def.key,
      type: def.type,
      value: getEffectiveSettingValue(def.key),
      default: def.default,
      description: def.description,
      module: def.module,
      requiresRestart: def.requiresRestart,
      valueSet: def.valueSet,
      min: def.min,
      max: def.max,
    }))
    json(res, { settings })
    return true
  }

  if (path === '/api/settings' && method === 'POST') {
    try {
      const body = await readBody(req)
      const { key, value, actor } = JSON.parse(body.toString())

      if (!key || typeof key !== 'string') {
        json(res, { error: 'Missing or invalid "key"' }, 400)
        return true
      }

      const def = SETTINGS_REGISTRY.find((s) => s.key === key)
      if (!def) {
        json(res, { error: `Unknown setting key: ${key}` }, 404)
        return true
      }
      if (def.secret) {
        // Defensive: v1 has no secret entries, but a future registry entry
        // marked secret must never be settable through this generic route.
        json(res, { error: 'Secret settings cannot be changed via this endpoint' }, 403)
        return true
      }

      // Validate before touching anything. setOverride re-validates
      // internally too, but checking here lets us read the "old" value for
      // the change log without assuming the write will succeed.
      const validation = validateSettingValue(def, value)
      if (!validation.ok) {
        json(res, { error: validation.error }, 400)
        return true
      }

      const oldValue = getEffectiveSettingValue(key)
      const result = setOverride(key, value)
      if (!result.ok) {
        json(res, { error: result.error }, 400)
        return true
      }

      logConfigChange(key, oldValue, validation.value!, typeof actor === 'string' && actor ? actor : 'dashboard')
      logger.info({ key, oldValue, newValue: validation.value }, 'Setting updated')
      json(res, { ok: true, key, value: validation.value, requiresRestart: def.requiresRestart })
    } catch (err) {
      logger.error({ err }, 'Failed to update setting')
      json(res, { error: 'Failed to update setting' }, 500)
    }
    return true
  }

  return false
}
