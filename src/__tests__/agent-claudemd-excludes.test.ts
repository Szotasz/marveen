import { it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Same sandbox as agent-sudo-optout.test.ts: PROJECT_ROOT is a temp dir, the checkout is never written.
const sandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const realRoot = path.resolve(__dirname, '..', '..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudemd-excl-'))
  for (const d of ['templates', 'scripts', 'src']) fs.symlinkSync(path.join(realRoot, d), path.join(root, d))
  fs.mkdirSync(path.join(root, 'agents'))
  fs.mkdirSync(path.join(root, 'store'))
  return { root }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: sandbox.root, STORE_DIR: join(sandbox.root, 'store') }
})

const KEY = 'ROOT_CLAUDEMD_EXCLUDE_AGENTS'
const env = vi.hoisted(() => ({ value: undefined as string | undefined }))
vi.mock('../env.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../env.js')>()
  return {
    ...orig,
    readEnvFile: (keys?: string[]) =>
      keys?.length === 1 && keys[0] === 'ROOT_CLAUDEMD_EXCLUDE_AGENTS'
        ? (env.value === undefined ? {} : { [keys[0]]: env.value })
        : orig.readEnvFile(keys),
  }
})

import { writeAgentSettingsFromProfile, agentSettingsPath, ROOT_ONLY_RULE_GROUPS } from '../web/agent-scaffold.js'
import { agentDir, agentExcludesRootClaudeMd } from '../web/agent-config.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID } from '../config.js'
import { getSettingDefinition } from '../config-registry.js'
import { logger } from '../logger.js'

const NAME = 'mdexcl-test-agent'
const OTHER = 'mdexcl-test-other'
const ROOT_MD = join(sandbox.root, 'CLAUDE.md')
const settingsOf = (a: string) => JSON.parse(readFileSync(agentSettingsPath(a), 'utf-8')) as Record<string, unknown>
const spawn = (a: string) => writeAgentSettingsFromProfile(a, loadProfileTemplate('default'))

beforeEach(() => {
  for (const a of [NAME, OTHER]) {
    if (existsSync(agentDir(a))) throw new Error(`refusing: ${agentDir(a)} already exists`)
    mkdirSync(agentDir(a), { recursive: true })
    writeFileSync(join(agentDir(a), 'agent-config.json'), '{}')
  }
  env.value = undefined
})
afterEach(() => { vi.restoreAllMocks(); for (const a of [NAME, OTHER]) rmSync(agentDir(a), { recursive: true, force: true }) })
afterAll(() => rmSync(sandbox.root, { recursive: true, force: true }))

it(`${KEY}: listed sub-agent gets the root CLAUDE.md excluded, an unlisted one does not`, () => {
  env.value = `${NAME}, nobody`
  const info = vi.spyOn(logger, 'info')
  spawn(NAME)
  spawn(OTHER)
  expect(settingsOf(NAME).claudeMdExcludes).toEqual([ROOT_MD])
  expect(settingsOf(OTHER)).not.toHaveProperty('claudeMdExcludes')
  // One dashboard-log line per listed agent, none for the unlisted one; it names the root-only rule groups it loses.
  const lines = info.mock.calls.filter((c) => String(c[1]).includes(KEY))
  expect(lines).toHaveLength(1)
  expect(lines[0][0]).toEqual({ agent: NAME, lost: ROOT_ONLY_RULE_GROUPS })
  for (const g of ROOT_ONLY_RULE_GROUPS) expect(String(lines[0][1])).toContain(g)
})

it(`${KEY}: the spawn line never names the facts-vs-guesses rule, even before the agent's evidence block exists`, () => {
  // The line runs before ensureEvidenceSection on the same start, so a missing block here says nothing about the agent.
  env.value = NAME
  writeFileSync(join(agentDir(NAME), 'CLAUDE.md'), '# x, no evidence block yet\n')
  const info = vi.spyOn(logger, 'info')
  spawn(NAME)
  const lines = info.mock.calls.filter((c) => String(c[1]).includes(KEY))
  expect(lines).toHaveLength(1)
  expect(lines[0][0]).toEqual({ agent: NAME, lost: ROOT_ONLY_RULE_GROUPS })
  expect(JSON.stringify(lines[0])).not.toMatch(/facts/i)
})

it(`${KEY}: '*' covers every sub-agent, also one not named anywhere, but never the main agent`, () => {
  for (const v of ['*', ' * ', `nobody,*`]) {
    env.value = v
    spawn(NAME)
    spawn(OTHER)
    expect(settingsOf(NAME).claudeMdExcludes, v).toEqual([ROOT_MD])
    expect(settingsOf(OTHER).claudeMdExcludes, v).toEqual([ROOT_MD])
    expect(agentExcludesRootClaudeMd(MAIN_AGENT_ID), v).toBe(false)
  }
  // a '*' inside a name is not the wildcard
  env.value = 'mdexcl-*'
  spawn(NAME)
  expect(settingsOf(NAME)).not.toHaveProperty('claudeMdExcludes')
})

it(`${KEY}: unset or cleared env removes the key at the next spawn (and a stale value too)`, () => {
  env.value = NAME
  spawn(NAME)
  expect(settingsOf(NAME).claudeMdExcludes).toEqual([ROOT_MD])
  for (const v of [undefined, '', OTHER]) {
    env.value = NAME
    spawn(NAME)
    env.value = v
    spawn(NAME)
    expect(settingsOf(NAME), String(v)).not.toHaveProperty('claudeMdExcludes')
  }
})

it(`${KEY}: an agent's own agent-config.json cannot grant it, and the main agent never qualifies`, () => {
  writeFileSync(join(agentDir(NAME), 'agent-config.json'), JSON.stringify({ [KEY]: NAME, claudeMdExcludes: ['**'] }))
  spawn(NAME)
  expect(settingsOf(NAME)).not.toHaveProperty('claudeMdExcludes')
  env.value = MAIN_AGENT_ID
  expect(agentExcludesRootClaudeMd(MAIN_AGENT_ID)).toBe(false)
})

it(`${KEY}: settings.local.json (the operator's manual override) stays byte-identical, key set or unset`, () => {
  // Deliberately compact, no trailing newline, foreign pattern: any rewrite would change the bytes.
  const local = `{"claudeMdExcludes":["${ROOT_MD}","**/x.md"],"effortLevel":"high"}`
  const localPath = join(agentDir(NAME), '.claude', 'settings.local.json')
  for (const v of [NAME, undefined]) {
    mkdirSync(join(agentDir(NAME), '.claude'), { recursive: true })
    writeFileSync(localPath, local)
    env.value = v
    spawn(NAME)
    expect(readFileSync(localPath, 'utf-8'), String(v)).toBe(local)
  }
})

it(`${KEY}: not a settings-registry key, so POST /api/settings cannot write it`, () => {
  expect(getSettingDefinition(KEY)).toBeUndefined()
})
