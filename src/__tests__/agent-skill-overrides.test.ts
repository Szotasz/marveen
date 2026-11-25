import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Same sandbox as isolated-channel-config.test.ts: homedir() -> the shared ~/.claude, agentDir() -> the agent.
let SANDBOX = ''
let OVERRIDES: Record<string, Record<string, string>> = {}
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentDir: (name: string) => join(SANDBOX, 'agents', name),
    readAgentSkillOverrides: (name: string) => OVERRIDES[name] ?? null,
  }
})

const { ensureIsolatedChannelConfigDir } = await import('../web/agent-process.js')
const { skillOverridesError } = await import('../web/agent-config.js')
const { checkAgentPutFields, agentPutOwnerFields } = await import('../web/agent-put-fields.js')

const SHARED_OFF = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`bundled-${i}`, 'off']))

function provision(): Record<string, unknown> {
  const cfg = ensureIsolatedChannelConfigDir('testagent', 'telegram')!
  return JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
}

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'skillovr-'))
  OVERRIDES = {}
  mkdirSync(join(SANDBOX, 'home', '.claude'), { recursive: true })
  writeFileSync(join(SANDBOX, 'home', '.claude', 'settings.json'), JSON.stringify({ skillOverrides: SHARED_OFF, skillListingMaxDescChars: 300 }))
  mkdirSync(join(SANDBOX, 'agents', 'testagent'), { recursive: true })
})
afterEach(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('per-agent skillOverrides merge', () => {
  it('adds the agent entries to the shared ones by skill name', () => {
    OVERRIDES.testagent = { 'skill-a': 'name-only', 'skill-b': 'name-only' }
    const s = provision()
    expect(Object.keys(s.skillOverrides as object)).toHaveLength(18)
    expect((s.skillOverrides as Record<string, string>)['skill-a']).toBe('name-only')
    expect((s.skillOverrides as Record<string, string>)['bundled-0']).toBe('off')
  })

  it("the agent's value wins on the same skill name", () => {
    OVERRIDES.testagent = { 'bundled-3': 'name-only' }
    const s = provision()
    expect((s.skillOverrides as Record<string, string>)['bundled-3']).toBe('name-only')
    expect(Object.keys(s.skillOverrides as object)).toHaveLength(16)
  })

  it('without agent overrides the shared object is copied unchanged', () => {
    const s = provision()
    expect(s.skillOverrides).toEqual(SHARED_OFF)
    expect(s.skillListingMaxDescChars).toBe(300)
  })

  it('works when the shared settings have no skillOverrides', () => {
    writeFileSync(join(SANDBOX, 'home', '.claude', 'settings.json'), '{}')
    OVERRIDES.testagent = { 'skill-a': 'off' }
    expect(provision().skillOverrides).toEqual({ 'skill-a': 'off' })
  })
})

describe('skillOverrides validation', () => {
  it('accepts the three narrowing values and an empty object', () => {
    expect(skillOverridesError({ a: 'name-only', b: 'user-invocable-only', c: 'off' })).toBeNull()
    expect(skillOverridesError({})).toBeNull()
  })
  it('rejects other values and shapes', () => {
    expect(skillOverridesError({ a: 'on' })).toMatch(/must be one of/)
    expect(skillOverridesError({ a: true })).toMatch(/must be one of/)
    expect(skillOverridesError({ ' ': 'off' })).toMatch(/empty skill name/)
    expect(skillOverridesError(['off'])).toMatch(/must be an object/)
    expect(skillOverridesError('off')).toMatch(/must be an object/)
  })
  it('is a writable PUT field', () => {
    expect(checkAgentPutFields('x', { skillOverrides: { a: 'off' } })).toEqual({ ok: true })
  })
  it('needs the owner only when it hides a skill', () => {
    expect(agentPutOwnerFields({ skillOverrides: { a: 'name-only', b: 'name-only' } })).toEqual([])
    expect(agentPutOwnerFields({ skillOverrides: null })).toEqual([])
    expect(agentPutOwnerFields({ skillOverrides: { a: 'name-only', b: 'off' } })).toEqual(['skillOverrides'])
    expect(agentPutOwnerFields({ skillOverrides: { a: 'user-invocable-only' } })).toEqual(['skillOverrides'])
    expect(agentPutOwnerFields({ skillOverrides: 'off' })).toEqual(['skillOverrides'])
  })
})
