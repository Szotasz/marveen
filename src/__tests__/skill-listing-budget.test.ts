import { it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Same sandbox as agent-claudemd-excludes.test.ts: PROJECT_ROOT is a temp dir, the checkout is never written.
const sandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const realRoot = path.resolve(__dirname, '..', '..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-budget-'))
  for (const d of ['templates', 'scripts', 'src']) fs.symlinkSync(path.join(realRoot, d), path.join(root, d))
  fs.mkdirSync(path.join(root, 'agents'))
  fs.mkdirSync(path.join(root, 'store'))
  return { root }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: sandbox.root, STORE_DIR: join(sandbox.root, 'store') }
})

import { writeAgentSettingsFromProfile } from '../web/agent-scaffold.js'
import { agentDir } from '../web/agent-config.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID } from '../config.js'
import { getSettingDefinition, skillListingBudgetFraction, validateSettingValue } from '../config-registry.js'
import { setOverride, clearOverride } from '../settings-store.js'

const KEY = 'SKILL_LISTING_BUDGET_FRACTION'
const FIELD = 'skillListingBudgetFraction'
const NAME = 'skillbudget-test-agent'
const AGENTS = [NAME, MAIN_AGENT_ID]
// the file the scaffold writes for ANY name (agentSettingsPath maps the main agent to ~/.claude, which no test may touch)
const settingsFile = (a: string) => join(agentDir(a), '.claude', 'settings.json')
const settingsOf = (a: string) => JSON.parse(readFileSync(settingsFile(a), 'utf-8')) as Record<string, unknown>
const spawn = (a: string) => writeAgentSettingsFromProfile(a, loadProfileTemplate('default'))

beforeEach(() => {
  for (const a of AGENTS) {
    if (existsSync(agentDir(a))) throw new Error(`refusing: ${agentDir(a)} already exists`)
    mkdirSync(agentDir(a), { recursive: true })
    writeFileSync(join(agentDir(a), 'agent-config.json'), '{}')
  }
  clearOverride(KEY)
})
afterEach(() => { clearOverride(KEY); for (const a of AGENTS) rmSync(agentDir(a), { recursive: true, force: true }) })
afterAll(() => rmSync(sandbox.root, { recursive: true, force: true }))

it(`${KEY}: unset writes no ${FIELD}, so Claude Code's own default applies`, () => {
  spawn(NAME)
  expect(settingsOf(NAME)).not.toHaveProperty(FIELD)
})

it(`${KEY}: a sub-agent's settings.json gets the value as a number`, () => {
  expect(setOverride(KEY, '0.005')).toEqual({ ok: true })
  spawn(NAME)
  expect(settingsOf(NAME)[FIELD]).toBe(0.005)
})

it(`${KEY}: clearing the setting drops the key at the next spawn, a hand-written one too`, () => {
  expect(setOverride(KEY, '0.005')).toEqual({ ok: true })
  spawn(NAME)
  clearOverride(KEY)
  spawn(NAME)
  expect(settingsOf(NAME)).not.toHaveProperty(FIELD)
  const s = settingsOf(NAME)
  writeFileSync(settingsFile(NAME), JSON.stringify({ ...s, [FIELD]: 0.5, effortLevel: 'high' }))
  spawn(NAME)
  expect(settingsOf(NAME)).not.toHaveProperty(FIELD)
  expect(settingsOf(NAME).effortLevel).toBe('high') // a key the dashboard does not own stays
})

it(`${KEY}: the main agent's settings are neither given the key nor cleaned of it`, () => {
  expect(setOverride(KEY, '0.005')).toEqual({ ok: true })
  spawn(MAIN_AGENT_ID)
  expect(settingsOf(MAIN_AGENT_ID)).not.toHaveProperty(FIELD)
  writeFileSync(settingsFile(MAIN_AGENT_ID), JSON.stringify({ ...settingsOf(MAIN_AGENT_ID), [FIELD]: 0.02 }))
  clearOverride(KEY)
  spawn(MAIN_AGENT_ID)
  expect(settingsOf(MAIN_AGENT_ID)[FIELD]).toBe(0.02)
})

it(`${KEY}: settings.local.json (the operator's manual override) stays byte-identical, key set or unset`, () => {
  const local = join(agentDir(NAME), '.claude', 'settings.local.json')
  mkdirSync(join(agentDir(NAME), '.claude'), { recursive: true })
  const body = JSON.stringify({ [FIELD]: 0.03 })
  writeFileSync(local, body)
  for (const v of ['0.005', '']) {
    if (v) expect(setOverride(KEY, v)).toEqual({ ok: true })
    else clearOverride(KEY)
    spawn(NAME)
    expect(readFileSync(local, 'utf-8')).toBe(body)
  }
})

it(`${KEY}: a fraction in (0, 1] or empty; anything else is refused and never reaches a settings file`, async () => {
  const def = getSettingDefinition(KEY)!
  for (const ok of ['0.005', '.005', '0.01', '1', ' 0.002 ', '']) expect(validateSettingValue(def, ok).ok, ok).toBe(true)
  for (const bad of ['0', '0.0', '1.5', '-0.1', '1e-3', 'abc', '0,005', '5%']) expect(validateSettingValue(def, bad).ok, bad).toBe(false)
  expect(setOverride(KEY, '1.5').ok).toBe(false)
  expect(skillListingBudgetFraction('')).toBeNull()
  expect(skillListingBudgetFraction('2')).toBeNull()
  expect(skillListingBudgetFraction(' 0.002 ')).toBe(0.002)
  // a bad value that got past the route (the settings read mocked to return it) counts as cleared
  expect(setOverride(KEY, '0.004')).toEqual({ ok: true })
  spawn(NAME)
  expect(settingsOf(NAME)[FIELD]).toBe(0.004)
  const store = await import('../settings-store.js')
  const read = vi.spyOn(store, 'getEffectiveSettingValue').mockReturnValue('lots')
  spawn(NAME)
  read.mockRestore()
  expect(settingsOf(NAME)).not.toHaveProperty(FIELD)
})
