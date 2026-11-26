// AGENT_EFFORT_LEVEL (opt-in, default empty): the dashboard sets the session effort of the agents at spawn.
// Pins: the grammar (empty, bare level, name=level pairs, '*', explicit name beats '*', invalid), the sub-agent's
// project effortLevel, and the config-root env writer (other keys and env entries kept; null = byte-identical).
import { it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Same sandbox as skill-listing-budget.test.ts: PROJECT_ROOT is a temp dir, the checkout is never written.
const sandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const realRoot = path.resolve(__dirname, '..', '..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-level-'))
  for (const d of ['templates', 'scripts', 'src']) fs.symlinkSync(path.join(realRoot, d), path.join(root, d))
  fs.mkdirSync(path.join(root, 'agents'))
  fs.mkdirSync(path.join(root, 'store'))
  return { root }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: sandbox.root, STORE_DIR: join(sandbox.root, 'store') }
})

import { writeAgentSettingsFromProfile, ensureEffortEnvInSettingsFile, agentEffortLevel } from '../web/agent-scaffold.js'
import { agentDir } from '../web/agent-config.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID } from '../config.js'
import { getSettingDefinition, effortLevelFor, validateSettingValue } from '../config-registry.js'
import { setOverride, clearOverride } from '../settings-store.js'

const KEY = 'AGENT_EFFORT_LEVEL'
const NAME = 'effort-test-agent'
const settingsFile = join(agentDir(NAME), '.claude', 'settings.json')
const settingsOf = () => JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>
const spawn = () => writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))

beforeEach(() => {
  if (existsSync(agentDir(NAME))) throw new Error(`refusing: ${agentDir(NAME)} already exists`)
  mkdirSync(agentDir(NAME), { recursive: true })
  writeFileSync(join(agentDir(NAME), 'agent-config.json'), '{}')
  clearOverride(KEY)
})
afterEach(() => { clearOverride(KEY); rmSync(agentDir(NAME), { recursive: true, force: true }) })
afterAll(() => rmSync(sandbox.root, { recursive: true, force: true }))

it(`${KEY}: grammar -- empty, bare level, pairs, '*', explicit name beats '*', invalid counts as empty`, () => {
  expect(effortLevelFor('', 'a')).toBeNull()
  expect(effortLevelFor('  ', 'a')).toBeNull()
  expect(effortLevelFor('medium', 'a')).toBe('medium')
  expect(effortLevelFor(' high ', MAIN_AGENT_ID)).toBe('high')
  expect(effortLevelFor('a=low,b=max', 'b')).toBe('max')
  expect(effortLevelFor('a=low', 'b')).toBeNull()
  expect(effortLevelFor('*=medium', 'b')).toBe('medium')
  expect(effortLevelFor('*=medium,uzemelteto=high', 'uzemelteto')).toBe('high')
  expect(effortLevelFor('uzemelteto=high, *=medium', 'uzemelteto')).toBe('high')
  expect(effortLevelFor('*=medium,uzemelteto=high', 'bongeszo')).toBe('medium')
  for (const bad of ['xhigh', 'HIGH', 'auto', 'a=xhigh', 'a=', '=high', 'a=high,', 'a=high=low', 'a b=high', '*=medium;b=low']) {
    expect(effortLevelFor(bad, 'a'), bad).toBeNull()
  }
  const def = getSettingDefinition(KEY)!
  expect(def.requiresRestart).toBe(true)
  expect(def.default).toBe('')
  for (const ok of ['', 'low', 'max', '*=medium,uzemelteto=high', 'a=low']) expect(validateSettingValue(def, ok).ok, ok).toBe(true)
  for (const bad of ['xhigh', 'a=', 'a=high,', 'medium,high']) expect(validateSettingValue(def, bad).ok, bad).toBe(false)
})

it(`${KEY}: unset writes no effortLevel, and a hand-written one stays untouched`, () => {
  spawn()
  expect(settingsOf()).not.toHaveProperty('effortLevel')
  writeFileSync(settingsFile, JSON.stringify({ ...settingsOf(), effortLevel: 'high' }))
  spawn()
  expect(settingsOf().effortLevel).toBe('high')
})

it(`${KEY}: a sub-agent's project settings.json gets its effortLevel; no env key there (ENVRELAXGATE1104 intact)`, () => {
  expect(setOverride(KEY, `*=low,${NAME}=max`)).toEqual({ ok: true })
  spawn()
  expect(settingsOf().effortLevel).toBe('max')
  expect(settingsOf()).not.toHaveProperty('env')
  expect(setOverride(KEY, 'medium')).toEqual({ ok: true })
  spawn()
  expect(settingsOf().effortLevel).toBe('medium')
  // clearing does not roll back: the last written level stays
  clearOverride(KEY)
  spawn()
  expect(settingsOf().effortLevel).toBe('medium')
})

it(`${KEY}: an invalid stored value counts as empty at apply time`, async () => {
  const store = await import('../settings-store.js')
  const read = vi.spyOn(store, 'getEffectiveSettingValue').mockReturnValue('lots')
  expect(agentEffortLevel(NAME)).toBeNull()
  read.mockRestore()
})

it(`${KEY}: config-root writer keeps every other key and env entry; null and same level leave the file byte-identical`, () => {
  const dir = join(sandbox.root, 'cfgroot')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'settings.json')
  const body = JSON.stringify({ statusLine: { type: 'command', command: 'x' }, env: { FOO: '1', CLAUDE_CODE_EFFORT_LEVEL: 'high' }, enabledPlugins: { a: true } })
  writeFileSync(p, body)
  expect(ensureEffortEnvInSettingsFile(p, null)).toBe(false)
  expect(readFileSync(p, 'utf-8')).toBe(body)
  expect(ensureEffortEnvInSettingsFile(p, 'medium')).toBe(true)
  const s = JSON.parse(readFileSync(p, 'utf-8'))
  expect(s).toEqual({ statusLine: { type: 'command', command: 'x' }, env: { FOO: '1', CLAUDE_CODE_EFFORT_LEVEL: 'medium' }, enabledPlugins: { a: true } })
  const after = readFileSync(p, 'utf-8')
  expect(ensureEffortEnvInSettingsFile(p, 'medium')).toBe(false)
  expect(readFileSync(p, 'utf-8')).toBe(after)
  // a file with no env gets one with just this key; an unparseable one is left alone
  writeFileSync(p, '{"model":"x"}')
  expect(ensureEffortEnvInSettingsFile(p, 'low')).toBe(true)
  expect(JSON.parse(readFileSync(p, 'utf-8'))).toEqual({ model: 'x', env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } })
  writeFileSync(p, '{not json')
  expect(ensureEffortEnvInSettingsFile(p, 'low')).toBe(false)
  expect(readFileSync(p, 'utf-8')).toBe('{not json')
  // no folder -> nothing created
  expect(ensureEffortEnvInSettingsFile(join(sandbox.root, 'nope', 'settings.json'), 'low')).toBe(false)
  expect(existsSync(join(sandbox.root, 'nope'))).toBe(false)
})
