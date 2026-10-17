import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { SETTINGS_REGISTRY, validateSettingValue } from '../../config-registry.js'
import { clearOverride, getEffectiveSettingSource, getEffectiveSettingValue, getSettingFallback, setOverride } from '../../settings-store.js'
import { logConfigChange } from '../../db.js'
import { setStoreWriteActor } from '../../store-watcher.js'
import { syncRotationHeartbeatTask } from '../claude-rotation-heartbeat.js'
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
      // Which layer answered: 'override' (saved here, config-overrides.json),
      // 'env' or 'default'. The page offers "reset to default" on 'override'.
      source: getEffectiveSettingSource(def.key).source,
      // What the value becomes if the override is removed, and from which
      // layer -- so the page can show "now -> after" before a reset.
      resetValue: getSettingFallback(def.key).value,
      resetSource: getSettingFallback(def.key).source,
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

      const resolvedActor = typeof actor === 'string' && actor ? actor : 'dashboard'
      setStoreWriteActor(resolvedActor)
      const oldValue = getEffectiveSettingValue(key)
      const result = setOverride(key, value)
      if (!result.ok) {
        json(res, { error: result.error }, 400)
        return true
      }

      logConfigChange(key, oldValue, validation.value!, resolvedActor)
      logger.info({ key, oldValue, newValue: validation.value }, 'Setting updated')

      // The rotation switch also wires its heartbeat, in both directions: on
      // creates or re-enables it (otherwise the switch is inert, measured
      // 2026-09-26), off disables it (otherwise a leftover task keeps ticking,
      // PR #1602 review). See syncRotationHeartbeatTask.
      if (key === 'CLAUDE_ROTATION_ENABLED') syncRotationAfterChange()
      json(res, { ok: true, key, value: validation.value, requiresRestart: def.requiresRestart })
    } catch (err) {
      logger.error({ err }, 'Failed to update setting')
      json(res, { error: 'Failed to update setting' }, 500)
    }
    return true
  }

  // DELETE /api/settings/<KEY>: remove the saved override, so the value falls
  // back to .env or the registry default. Idempotent: no override -> ok, with
  // removed:false. The response names the layer that answers now, because
  // "reset" does not always mean "the registry default": a key that is also in
  // .env lands on the .env value, and the page has to say so.
  const resetMatch = /^\/api\/settings\/([A-Z][A-Z0-9_]*)$/.exec(path)
  if (resetMatch && method === 'DELETE') {
    try {
      const key = resetMatch[1]
      const def = SETTINGS_REGISTRY.find((s) => s.key === key)
      if (!def) {
        json(res, { error: `Unknown setting key: ${key}` }, 404)
        return true
      }
      if (def.secret) {
        json(res, { error: 'Secret settings cannot be changed via this endpoint' }, 403)
        return true
      }

      let actor = 'dashboard'
      try {
        const body = (await readBody(req)).toString()
        const parsed = body ? JSON.parse(body) : null
        if (parsed && typeof parsed.actor === 'string' && parsed.actor) actor = parsed.actor
      } catch {
        // A DELETE usually has no body; an unreadable one just keeps the default actor.
      }

      setStoreWriteActor(actor)
      const oldValue = getEffectiveSettingValue(key)
      const result = clearOverride(key)
      if (!result.ok) {
        json(res, { error: result.error }, 409)
        return true
      }
      const now = getEffectiveSettingSource(key)
      if (result.removed) {
        logConfigChange(key, oldValue, now.value, actor)
        logger.info({ key, oldValue, newValue: now.value, source: now.source }, 'Setting override removed')
        if (key === 'CLAUDE_ROTATION_ENABLED') syncRotationAfterChange()
      }
      json(res, { ok: true, key, removed: result.removed, value: now.value, source: now.source, requiresRestart: def.requiresRestart })
    } catch (err) {
      logger.error({ err }, 'Failed to reset setting')
      json(res, { error: 'Failed to reset setting' }, 500)
    }
    return true
  }

  return false
}

function syncRotationAfterChange(): void {
  try {
    const synced = syncRotationHeartbeatTask()
    if (synced !== 'unchanged' && synced !== 'rotation-off') logger.info({ task: 'claude-plan-rotate-check', result: synced }, 'Claude rotation heartbeat task synced')
  } catch (err) {
    logger.warn({ err }, 'Claude rotation heartbeat task sync failed')
  }
}
