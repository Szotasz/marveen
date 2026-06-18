import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../../config.js'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { setStoreWriteActor } from '../../store-watcher.js'
import type { RouteContext } from './types.js'

const CONFIG_PATH = join(PROJECT_ROOT, 'store', 'autonomy-config.json')

interface AutonomyCategory {
  key: string
  label: string
  level: number
  locked: boolean
  maxLevel: number
}

interface AutonomyConfig {
  version: number
  updated_at: number
  _doc?: string
  categories: AutonomyCategory[]
}

function loadConfig(): AutonomyConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error('autonomy-config.json not found')
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
}

function saveConfig(config: AutonomyConfig): void {
  config.updated_at = Math.floor(Date.now() / 1000)
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

export async function tryHandleAutonomy(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/autonomy' && method === 'GET') {
    try {
      const config = loadConfig()
      json(res, config)
    } catch (err) {
      logger.error({ err }, 'Failed to load autonomy config')
      json(res, { error: 'Config not found' }, 404)
    }
    return true
  }

  if (path === '/api/autonomy' && method === 'POST') {
    try {
      const body = await readBody(req)
      const { key, level } = JSON.parse(body.toString())

      if (!key || typeof level !== 'number' || level < 1 || level > 3) {
        json(res, { error: 'Invalid key or level (must be 1-3)' }, 400)
        return true
      }

      const config = loadConfig()
      const cat = config.categories.find(c => c.key === key)
      if (!cat) {
        json(res, { error: `Category "${key}" not found` }, 404)
        return true
      }

      if (cat.locked && level > 1) {
        json(res, { error: `Category "${key}" is locked at level 1 (safety constraint)` }, 403)
        return true
      }

      if (level > cat.maxLevel) {
        json(res, { error: `Category "${key}" max level is ${cat.maxLevel}` }, 400)
        return true
      }

      cat.level = level
      setStoreWriteActor('dashboard')
      saveConfig(config)
      logger.info({ key, level }, 'Autonomy level updated')
      json(res, { ok: true, key, level, updated_at: config.updated_at })
    } catch (err) {
      logger.error({ err }, 'Failed to update autonomy config')
      json(res, { error: 'Failed to update' }, 500)
    }
    return true
  }

  return false
}
