import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The checkout is never written: PROJECT_ROOT points at a temp sandbox (so
// agentDir() resolves under <sandbox>/agents), and the sandbox borrows the
// real templates/ and scripts/ read-only through symlinks.
const sandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const realRoot = path.resolve(__dirname, '..', '..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-optout-'))
  for (const d of ['templates', 'scripts', 'src']) fs.symlinkSync(path.join(realRoot, d), path.join(root, d))
  fs.mkdirSync(path.join(root, 'agents'))
  fs.mkdirSync(path.join(root, 'store'))
  return { root, realRoot }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: sandbox.root, STORE_DIR: join(sandbox.root, 'store') }
})

// The sudo grant LOOSENS the fleet deny floor, so its source must not be
// writable by the agent it frees (review of d4c4f3a4). The install .env is
// stubbed here for SUDO_AGENTS only; every other key reads the real file, so
// config.ts boots exactly as it does in the rest of the suite.
const env = vi.hoisted(() => ({ SUDO_AGENTS: undefined as string | undefined }))
vi.mock('../env.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../env.js')>()
  return {
    ...orig,
    readEnvFile: (keys?: string[]) => {
      if (keys?.length === 1 && keys[0] === 'SUDO_AGENTS') {
        return env.SUDO_AGENTS === undefined ? {} : { SUDO_AGENTS: env.SUDO_AGENTS }
      }
      return orig.readEnvFile(keys)
    },
  }
})

import { writeAgentSettingsFromProfile, agentSettingsPath, FLEET_BASELINE_DENY, FLEET_SUDO_DENY } from '../web/agent-scaffold.js'
import { agentDir, agentMaySudo, parseSudoAgents } from '../web/agent-config.js'
import { listProfileTemplates, loadProfileTemplate, resolveProfilePlaceholders } from '../web/profiles.js'
import { SETTINGS_REGISTRY, getSettingDefinition } from '../config-registry.js'
import { MAIN_AGENT_ID } from '../config.js'

const NAME = 'sudo-optout-test-agent'
const OTHER = 'sudo-optout-test-other'
const dirs = [agentDir(NAME), agentDir(OTHER)]

const denyOf = (agent: string): string[] =>
  JSON.parse(readFileSync(agentSettingsPath(agent), 'utf-8')).permissions.deny as string[]
const setConfig = (agent: string, cfg: unknown) =>
  writeFileSync(join(agentDir(agent), 'agent-config.json'), JSON.stringify(cfg, null, 2))

beforeEach(() => {
  for (const dir of dirs) {
    // A pre-existing dir means we are not in a clean checkout: refuse rather
    // than delete something we did not create.
    if (existsSync(dir)) throw new Error(`refusing: ${dir} already exists`)
    mkdirSync(dir, { recursive: true })
  }
  setConfig(NAME, {})
  setConfig(OTHER, {})
  env.SUDO_AGENTS = undefined
})
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
afterAll(() => {
  // the symlinks are removed, never followed: rmSync does not recurse through them
  rmSync(sandbox.root, { recursive: true, force: true })
})

it('writes only inside the temp sandbox, never into the checkout', () => {
  expect(agentDir(NAME).startsWith(join(sandbox.root, 'agents'))).toBe(true)
  expect(agentDir(NAME).startsWith(join(sandbox.realRoot, 'agents'))).toBe(false)
})

describe('the sudo pair the opt-out lifts', () => {
  it('is part of the floor (a renamed rule would make the opt-out a silent no-op)', () => {
    expect(FLEET_SUDO_DENY).toEqual(['Bash(sudo:*)', 'Bash(*/sudo *)'])
    for (const rule of FLEET_SUDO_DENY) expect(FLEET_BASELINE_DENY).toContain(rule)
  })
})

describe('the grant comes from the install .env, not from anything the agent writes', () => {
  it('an agent writing allowSudo:true into its OWN agent-config.json gains nothing', () => {
    setConfig(NAME, { allowSudo: true, sudo: true, SUDO_AGENTS: NAME })
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    for (const rule of FLEET_SUDO_DENY) expect(denyOf(NAME)).toContain(rule)
    expect(agentMaySudo(NAME)).toBe(false)
  })

  it('SUDO_AGENTS is not a registry key, so POST /api/settings (shared token) cannot write it', () => {
    expect(getSettingDefinition('SUDO_AGENTS')).toBeUndefined()
    expect(SETTINGS_REGISTRY.filter(d => /SUDO/i.test(d.key))).toEqual([])
    const route = readFileSync(join(sandbox.realRoot, 'src/web/routes/settings.ts'), 'utf-8')
    expect(route).toContain('Unknown setting key')
  })

  it('a listed agent loses both sudo rules and keeps every other floor rule', () => {
    env.SUDO_AGENTS = NAME
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    const deny = denyOf(NAME)
    for (const rule of FLEET_SUDO_DENY) expect(deny).not.toContain(rule)
    const ctx = { HOME: homedir(), AGENT_DIR: agentDir(NAME) }
    for (const rule of FLEET_BASELINE_DENY.filter(r => !FLEET_SUDO_DENY.includes(r))) {
      expect(deny).toContain(resolveProfilePlaceholders(rule, ctx))
    }
    expect(deny).toContain('Bash(*/wget *)')
  })

  it('every agent NOT on the list keeps the deny, written in the same pass, on every profile', () => {
    env.SUDO_AGENTS = NAME
    const profiles = listProfileTemplates()
    expect(profiles.length).toBeGreaterThanOrEqual(7)
    for (const profile of profiles) {
      writeAgentSettingsFromProfile(NAME, loadProfileTemplate(profile.id))
      writeAgentSettingsFromProfile(OTHER, loadProfileTemplate(profile.id))
      for (const rule of FLEET_SUDO_DENY) expect(denyOf(OTHER), profile.id).toContain(rule)
    }
  })

  it('is default OFF: absent, empty and non-matching values keep the deny', () => {
    for (const v of [undefined, '', ' , ', `${NAME}x`, `x${NAME}`, NAME.toUpperCase(), `${NAME}*`, '*', 'all']) {
      env.SUDO_AGENTS = v
      writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
      for (const rule of FLEET_SUDO_DENY) expect(denyOf(NAME), String(v)).toContain(rule)
    }
  })

  it('removing the agent from the list restores the deny at the next respawn', () => {
    env.SUDO_AGENTS = NAME
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    expect(denyOf(NAME)).not.toContain('Bash(sudo:*)')
    env.SUDO_AGENTS = OTHER
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    for (const rule of FLEET_SUDO_DENY) expect(denyOf(NAME)).toContain(rule)
  })

  it('does not lift a sudo rule the profile declares itself', () => {
    // marketer carries Bash(sudo:*) in its own deny list: that is the
    // profile's policy, not the floor's.
    env.SUDO_AGENTS = NAME
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('marketer'))
    expect(denyOf(NAME)).toContain('Bash(sudo:*)')
  })

  it('never grants the main agent (its floor is the tracked project settings)', () => {
    env.SUDO_AGENTS = MAIN_AGENT_ID
    expect(agentMaySudo(MAIN_AGENT_ID)).toBe(false)
  })
})

describe('parseSudoAgents', () => {
  it('splits on commas and whitespace, dedupes, and drops what is not an agent name', () => {
    expect(parseSudoAgents('heimdall, argus  heimdall\tx/y ../z Bad *')).toEqual(['heimdall', 'argus'])
    expect(parseSudoAgents(undefined)).toEqual([])
    expect(parseSudoAgents(1)).toEqual([])
  })
})
