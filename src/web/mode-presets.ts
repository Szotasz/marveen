// MODEPRESETS1109: owner-defined modes are the shared token's bounded write authority.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { isValidModelId } from '../model-id.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'

export const MODE_PRESETS_PATH = join(STORE_DIR, 'mode-presets.json')
export const MODE_PRESET_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
export interface ModePreset {
  customProvider: string
  model: string
  contextGuard?: { limitTokens?: number | null; actPct?: number; hardPct?: number }
  agents: string[]
}
export interface ModePresets { presets: Record<string, ModePreset> }
export const defaultModePresets = (): ModePresets => ({ presets: {} })

function object(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
}
function knownKeys(raw: Record<string, unknown>, keys: string[]): void {
  const unknown = Object.keys(raw).filter(k => !keys.includes(k))
  if (unknown.length) throw new Error(`Unknown keys: ${unknown.join(', ')}`)
}
function parsePreset(raw: unknown, strict: boolean): ModePreset {
  if (!object(raw)) throw new Error('Preset must be an object')
  if (strict) knownKeys(raw, ['customProvider', 'model', 'contextGuard', 'agents'])
  if (typeof raw.customProvider !== 'string' || typeof raw.model !== 'string') {
    throw new Error('customProvider and model must be strings')
  }
  if (!isValidModelId(raw.model)) throw new Error('Invalid model id')
  if (!Array.isArray(raw.agents) || !raw.agents.length || !raw.agents.every(a => typeof a === 'string' && /^[a-zA-Z0-9_-]+$/.test(a))) {
    throw new Error('agents must be a non-empty array of explicit agent names')
  }
  const out: ModePreset = { customProvider: raw.customProvider, model: raw.model, agents: [...raw.agents] }
  if (raw.contextGuard !== undefined) {
    if (!object(raw.contextGuard)) throw new Error('contextGuard must be an object')
    const cg = raw.contextGuard
    if (strict) knownKeys(cg, ['limitTokens', 'actPct', 'hardPct'])
    out.contextGuard = {}
    if ('limitTokens' in cg) {
      if (cg.limitTokens !== null && !(typeof cg.limitTokens === 'number' && Number.isInteger(cg.limitTokens) && cg.limitTokens > 0)) {
        throw new Error('limitTokens must be a positive integer or null')
      }
      out.contextGuard.limitTokens = cg.limitTokens as number | null
    }
    for (const key of ['actPct', 'hardPct'] as const) {
      if (!(key in cg)) continue
      if (typeof cg[key] !== 'number' || !Number.isFinite(cg[key]) || cg[key] <= 0 || cg[key] > 1) {
        throw new Error(`${key} must be a number greater than 0 and at most 1`)
      }
      out.contextGuard[key] = cg[key]
    }
    if (out.contextGuard.actPct !== undefined && out.contextGuard.hardPct !== undefined && out.contextGuard.actPct > out.contextGuard.hardPct) {
      throw new Error('actPct must not exceed hardPct')
    }
  }
  return out
}

/** Strict owner PUT validator: returns the clean value or throws a reason. */
export function validateModePresets(raw: unknown): ModePresets {
  if (!object(raw)) throw new Error('Expected an object containing presets')
  knownKeys(raw, ['presets'])
  if (!object(raw.presets)) throw new Error('presets must be an object')
  const out = defaultModePresets()
  for (const [name, value] of Object.entries(raw.presets)) {
    if (!MODE_PRESET_NAME.test(name)) throw new Error(`Invalid preset name: ${name}`)
    out.presets[name] = parsePreset(value, true)
  }
  return out
}

/** Drop unknown fields and invalid entries; never invent permission for an agent. */
export function normaliseModePresets(raw: unknown): ModePresets {
  const out = defaultModePresets()
  if (!object(raw) || !object(raw.presets)) return out
  for (const [name, value] of Object.entries(raw.presets)) {
    if (!MODE_PRESET_NAME.test(name)) continue
    try { out.presets[name] = parsePreset(value, false) } catch { /* Invalid entries grant nothing. */ }
  }
  return out
}
export function readModePresets(path = MODE_PRESETS_PATH): ModePresets {
  if (!existsSync(path)) return defaultModePresets()
  try { return normaliseModePresets(JSON.parse(readFileSync(path, 'utf-8'))) } catch {
    logger.warn({ path }, 'mode-presets: unreadable, treating as no presets')
    return defaultModePresets()
  }
}
export function writeModePresets(value: ModePresets, path = MODE_PRESETS_PATH): void {
  atomicWriteFileSync(path, JSON.stringify(normaliseModePresets(value), null, 2))
}
