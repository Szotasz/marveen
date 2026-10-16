/**
 * SECSZIVEK1007: values that reach the channels launch command are validated
 * where they are written, not only where they are read.
 *
 * - MAIN_AGENT_CONFIG_DIR through /api/settings: the same path rules as an
 *   agent's claudeConfigDir and a plan's configDir (expandAndValidateConfigDir).
 * - POST /api/agents: the model id is checked BEFORE the agent dir is
 *   scaffolded (it used to be checked by writeAgentModel, after the scaffold,
 *   so a malformed id left a half-created agent behind).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS_REGISTRY, validateSettingValue } from '../config-registry.js'

const def = SETTINGS_REGISTRY.find((d) => d.key === 'MAIN_AGENT_CONFIG_DIR')!

describe('MAIN_AGENT_CONFIG_DIR write validation', () => {
  it('accepts unset, a ~/ path and an absolute path', () => {
    expect(validateSettingValue(def, '')).toEqual({ ok: true, value: '' })
    expect(validateSettingValue(def, '~/.claude-bot')).toEqual({ ok: true, value: '~/.claude-bot' })
    expect(validateSettingValue(def, '/var/lib/claude-bot')).toEqual({ ok: true, value: '/var/lib/claude-bot' })
  })
  it('refuses characters outside the config-dir rules, .. segments and a mid-string ~', () => {
    for (const bad of ["/tmp/it's dir", '/tmp/a b', '~/../etc', '/x/~y', '~other/x']) {
      expect(validateSettingValue(def, bad).ok, bad).toBe(false)
    }
  })
  it('the registry entry carries the validator (other string settings are untouched)', () => {
    expect(typeof def.validate).toBe('function')
    const plain = SETTINGS_REGISTRY.find((d) => d.type === 'string' && !d.validate && !d.valueSet)!
    expect(validateSettingValue(plain, "anything 'goes' here")).toEqual({ ok: true, value: "anything 'goes' here" })
  })
})

describe('agent create: the model id is checked before anything is created', () => {
  const SRC = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf-8')
  const start = SRC.indexOf("if (path === '/api/agents' && method === 'POST') {")
  const handler = SRC.slice(start, SRC.indexOf("json(res, { ok: true, name })", start))
  it('isValidModelId runs before scaffoldAgentDir and answers 400', () => {
    const check = handler.indexOf('if (!isValidModelId(model)) { json(res, { error: new InvalidModelIdError(model).message }, 400); return true }')
    expect(start).toBeGreaterThan(0)
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(handler.indexOf('scaffoldAgentDir(name)'))
    expect(check).toBeLessThan(handler.indexOf('refuseIfCliCannotLaunch(model)'))
  })
})
