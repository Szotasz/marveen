import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ENVRELAXGATE1104 (Samu 67797 (b), (c)): on every spawn the scaffold drops the keys that switch an agent's gate hooks
// off or rewrite their environment (disableAllHooks, env), from settings.json AND settings.local.json; it keeps every
// other key (effortLevel, emojiCompletionEnabled, enabledPlugins: measured on the live fleet) and puts the gate hooks
// back. settings.local.json is never deleted, not rewritten when clean, and left as it is when it does not parse.
// The checkout is never written: PROJECT_ROOT points at a temp sandbox (the agent-sudo-optout pattern).
const sandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  const realRoot = path.resolve(__dirname, '..', '..')
  // NOT under os.tmpdir(): on Linux that is /tmp, and isUnsafeHookCommand rightly refuses every hook command with a
  // /tmp/ path, so the scaffold would inject no gate at all and the gate assertions below would fail for the wrong
  // reason (#2497 CI, run 41826116808; macOS's /var/folders hid it). node_modules/.cache is untracked and not transient.
  const cacheDir = path.join(realRoot, 'node_modules', '.cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  const root = fs.mkdtempSync(path.join(cacheDir, 'settings-strip-'))
  for (const d of ['templates', 'scripts', 'src']) fs.symlinkSync(path.join(realRoot, d), path.join(root, d))
  fs.mkdirSync(path.join(root, 'agents'))
  fs.mkdirSync(path.join(root, 'store'))
  return { root, realRoot }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: sandbox.root, STORE_DIR: join(sandbox.root, 'store') }
})

import { writeAgentSettingsFromProfile, agentSettingsPath, sanitizeAgentLocalSettings, AGENT_SETTINGS_STRIPPED_KEYS } from '../web/agent-scaffold.js'
import { agentDir } from '../web/agent-config.js'
import { loadProfileTemplate } from '../web/profiles.js'

const NAME = 'settings-strip-test-agent'
const settings = () => JSON.parse(readFileSync(agentSettingsPath(NAME), 'utf-8')) as Record<string, unknown>
const localPath = () => join(agentDir(NAME), '.claude', 'settings.local.json')
const preToolUse = (s: Record<string, unknown>) => JSON.stringify((s.hooks as Record<string, unknown>)?.PreToolUse ?? [])

beforeEach(() => {
  if (existsSync(agentDir(NAME))) throw new Error(`refusing: ${agentDir(NAME)} already exists`)
  mkdirSync(join(agentDir(NAME), '.claude'), { recursive: true })
  writeFileSync(join(agentDir(NAME), 'agent-config.json'), '{}')
})
afterEach(() => { rmSync(agentDir(NAME), { recursive: true, force: true }) })
afterAll(() => { rmSync(sandbox.root, { recursive: true, force: true }) })

it('writes only inside the temp sandbox', () => {
  expect(agentDir(NAME).startsWith(join(sandbox.root, 'agents'))).toBe(true)
})

it('the stripped keys are exactly disableAllHooks and env', () => {
  expect([...AGENT_SETTINGS_STRIPPED_KEYS]).toEqual(['disableAllHooks', 'env'])
})

describe('settings.json on spawn', () => {
  it('drops disableAllHooks and env, keeps the user keys and a foreign key', () => {
    writeFileSync(agentSettingsPath(NAME), JSON.stringify({
      disableAllHooks: true, env: { PATH: '/tmp/evil', NODE_OPTIONS: '--require /tmp/x.js' },
      effortLevel: 'high', emojiCompletionEnabled: true, enabledPlugins: { 'x@y': true }, somethingElse: 1,
    }))
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    const s = settings()
    expect('disableAllHooks' in s).toBe(false)
    expect('env' in s).toBe(false)
    expect([s.effortLevel, s.emojiCompletionEnabled, s.enabledPlugins, s.somethingElse]).toEqual(['high', true, { 'x@y': true }, 1])
  })

  it('a gate hook the agent removed is put back from the template (measured from code: every inject* re-adds its entry)', () => {
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    const full = settings()
    for (const gate of ['self-pace-gate.mjs', 'db-write-gate.mjs']) expect(preToolUse(full)).toContain(gate)
    // the agent strips its gates and turns hooks off
    writeFileSync(agentSettingsPath(NAME), JSON.stringify({ ...full, hooks: {}, disableAllHooks: true }))
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    const back = settings()
    for (const gate of ['self-pace-gate.mjs', 'db-write-gate.mjs']) expect(preToolUse(back)).toContain(gate)
    expect('disableAllHooks' in back).toBe(false)
  })
})

describe('settings.local.json on spawn (qwen has one: its content is never read here, only the behaviour)', () => {
  it('absent: nothing is created', () => {
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    expect(existsSync(localPath())).toBe(false)
  })

  it('with the keys: they are dropped, everything else stays, the file is NOT deleted', () => {
    writeFileSync(localPath(), JSON.stringify({ disableAllHooks: true, env: { X: '1' }, permissions: { allow: ['Read(./x)'] }, model: 'y' }))
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    expect(existsSync(localPath())).toBe(true)
    expect(JSON.parse(readFileSync(localPath(), 'utf-8'))).toEqual({ permissions: { allow: ['Read(./x)'] }, model: 'y' })
  })

  it('clean: not rewritten (same bytes, same mtime)', () => {
    const text = '{\n  "permissions": {"allow": []}\n}\n'
    writeFileSync(localPath(), text)
    const before = statSync(localPath()).mtimeMs
    expect(sanitizeAgentLocalSettings(NAME)).toBe('clean')
    expect(readFileSync(localPath(), 'utf-8')).toBe(text)
    expect(statSync(localPath()).mtimeMs).toBe(before)
  })

  it('unparseable or not an object: left as it is', () => {
    for (const text of ['{ not json', '[1, 2]', '"x"']) {
      writeFileSync(localPath(), text)
      expect(sanitizeAgentLocalSettings(NAME)).toBe('unparseable')
      expect(readFileSync(localPath(), 'utf-8')).toBe(text)
    }
  })

  it('the return value names what happened', () => {
    expect(sanitizeAgentLocalSettings(NAME)).toBe('absent')
    writeFileSync(localPath(), JSON.stringify({ env: {} }))
    expect(sanitizeAgentLocalSettings(NAME)).toBe('stripped')
    expect(sanitizeAgentLocalSettings(NAME)).toBe('clean')
  })
})
