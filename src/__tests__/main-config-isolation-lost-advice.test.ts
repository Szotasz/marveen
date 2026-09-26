// The respawn-guard's isolation-lost notice may only say what it measured (card 8a4056ad).
//
// The old text was one fixed sentence: "store/config-overrides.json was deleted and there is no .env key",
// "auth rides the rotating shared session, 401 risk", "set MAIN_AGENT_ISOLATED_CONFIG=1 and restart". On
// 2026-09-21 all of it was false: the overrides file existed (it held only CLAUDE_ROTATION_ENABLED=1) and .env
// carried MAIN_AGENT_ISOLATED_CONFIG=0, an explicit, deliberate revert -- and the guard advised undoing it. The
// false reason travelled on into decisions that were built on it.
//
// So the notice now names where the setting's effective value comes from, read in the settings-store's own
// order (config-overrides.json > .env > registry default), and only a MISSING setting draws the "=1 and
// restart" advice.
//
// SANDBOX, ENFORCED (the settings-store suite's rule): config-overrides.json lives under STORE_DIR, which is
// baked into OVERRIDES_PATH at import, so both are mocked before the modules load; .env is a fake map. Nothing
// here can reach a real store/ or .env.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'isolation-advice-'))
const STORE = join(SANDBOX, 'store')
let ENV: Record<string, string> = {}
const sent: Array<[string, string, string]> = []

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'boss',
  PROJECT_ROOT: SANDBOX,
  STORE_DIR: STORE,
}))
vi.mock('../env.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readEnvFile: (keys?: string[]) =>
    Object.fromEntries(Object.entries(ENV).filter(([k]) => !keys || keys.includes(k))),
}))
vi.mock('../db.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createAgentMessage: (from: string, to: string, content: string) => { sent.push([from, to, content]); return 1 },
}))
// The launch itself is faked the way main-config-guard-wiring.test.ts fakes it: no isolated dir resolved, and
// .channels-config on disk -- the isolation-lost state. The verdict and the notice run for real.
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMainAgentConfigDir: () => null,
  resolveMainAgentRotatedConfigDir: () => null,
  resolveMainAgentRotatedTokenSecretId: () => null,
  ensureMainAgentIsolatedConfigDir: () => null,
  readMainSharedConfigState: (dir: string | null) => ({ isolatedConfigDir: dir, fleetToken: true, isolatedDirExists: true }),
}))

const { OVERRIDES_PATH, getEffectiveSettingSource, getEffectiveSettingValue, reloadOverridesForTest } =
  await import('../settings-store.js')
const { isolationLostAdvice, resolveMainConfigDecision } = await import('../web/main-config-decision.js')

const KEY = 'MAIN_AGENT_ISOLATED_CONFIG'
const ADVICE = 'MAIN_AGENT_ISOLATED_CONFIG=1'

function overrides(o: Record<string, string> | null): void {
  if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
  if (o) writeFileSync(OVERRIDES_PATH, JSON.stringify(o))
  reloadOverridesForTest()
}
function log(): string {
  const p = join(STORE, 'channels-failures.log')
  return existsSync(p) ? readFileSync(p, 'utf-8') : ''
}

beforeEach(() => {
  mkdirSync(STORE, { recursive: true })
  for (const f of ['channels-failures.log', '.main-config-guard-warned']) rmSync(join(STORE, f), { force: true })
  overrides(null)
  ENV = {}
  sent.length = 0
})
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

describe('the sandbox holds (nothing below may touch a real store/)', () => {
  it('OVERRIDES_PATH is inside the sandbox', () => {
    expect(OVERRIDES_PATH).toBe(join(STORE, 'config-overrides.json'))
  })
})

describe('getEffectiveSettingSource: the same order as getEffectiveSettingValue, and it says which layer answered', () => {
  it('registry default when neither layer has the key', () => {
    expect(getEffectiveSettingSource(KEY)).toEqual({ value: '0', source: 'default' })
  })
  it('.env when only .env has it', () => {
    ENV = { [KEY]: '0' }
    expect(getEffectiveSettingSource(KEY)).toEqual({ value: '0', source: 'env' })
  })
  it('config-overrides.json wins over .env', () => {
    ENV = { [KEY]: '1' }
    overrides({ [KEY]: '0' })
    expect(getEffectiveSettingSource(KEY)).toEqual({ value: '0', source: 'override' })
  })
  it('getEffectiveSettingValue gives the same value in every case (one resolution, not two)', () => {
    for (const [env, ov] of [[{}, null], [{ [KEY]: '0' }, null], [{ [KEY]: '1' }, { [KEY]: '0' }]] as const) {
      ENV = { ...env }
      overrides(ov ? { ...ov } : null)
      expect(getEffectiveSettingValue(KEY)).toBe(getEffectiveSettingSource(KEY).value)
    }
  })
})

describe('isolationLostAdvice: each branch says only what it measured', () => {
  it('file missing, key missing: the absence is stated, and only here comes the =1 advice', () => {
    const t = isolationLostAdvice({ value: '0', source: 'default', overridesFileExists: false })
    expect(t).toContain('sehol nincs beallitva')
    expect(t).toContain('store/config-overrides.json nem letezik')
    expect(t).toContain(ADVICE)
    expect(t).toContain('ujrainditasa')
  })
  it('file present without the key, key missing from .env: the absence is stated with the file that exists', () => {
    const t = isolationLostAdvice({ value: '0', source: 'default', overridesFileExists: true })
    expect(t).toContain('letezik, de ezt a kulcsot nem tartalmazza')
    expect(t).toContain(ADVICE)
  })
  it('explicit 0 in .env: a deliberate setting, no advice to write 1, no restart', () => {
    const t = isolationLostAdvice({ value: '0', source: 'env', overridesFileExists: true })
    expect(t).toContain('szandekos beallitas (=0)')
    expect(t).toContain('a .env-ben')
    expect(t).not.toContain(ADVICE)
    expect(t).not.toMatch(/ujraindit/i)
  })
  it('explicit 0 in config-overrides.json: named as that file', () => {
    const t = isolationLostAdvice({ value: '0', source: 'override', overridesFileExists: true })
    expect(t).toContain('szandekos beallitas (=0)')
    expect(t).toContain('a store/config-overrides.json-ban')
    expect(t).not.toContain(ADVICE)
  })
  it('1 and still the shared root: the cause is unknown, and no restart is advised', () => {
    const t = isolationLostAdvice({ value: '1', source: 'env', overridesFileExists: false })
    expect(t).toContain('az oka ismeretlen')
    expect(t).not.toContain(ADVICE)
    expect(t).not.toMatch(/ujraindit/i)
  })
  it('a value that is neither 0 nor 1 is quoted, not interpreted', () => {
    const t = isolationLostAdvice({ value: 'yes', source: 'env', overridesFileExists: false })
    expect(t).toContain('"yes"')
    expect(t).toContain('csak az 1 kapcsolja be')
    expect(t).not.toContain(ADVICE)
  })
  it('an unreadable source: said so, no advice', () => {
    const t = isolationLostAdvice(null)
    expect(t).toContain('nem olvashato')
    expect(t).not.toContain(ADVICE)
  })
  it('no branch repeats the unmeasured claims of the old text', () => {
    const all = [
      isolationLostAdvice({ value: '0', source: 'default', overridesFileExists: false }),
      isolationLostAdvice({ value: '0', source: 'default', overridesFileExists: true }),
      isolationLostAdvice({ value: '0', source: 'env', overridesFileExists: true }),
      isolationLostAdvice({ value: '0', source: 'override', overridesFileExists: true }),
      isolationLostAdvice({ value: '1', source: 'override', overridesFileExists: true }),
      isolationLostAdvice({ value: 'yes', source: 'env', overridesFileExists: false }),
      isolationLostAdvice(null),
    ]
    for (const t of all) {
      expect(t.startsWith('[GUARD] ')).toBe(true)
      expect(t).not.toMatch(/torlodott|401|rotalodo|elveszett|valoszinuleg/)
    }
  })
})

describe('end to end through resolveMainConfigDecision, the real settings-store in the sandbox', () => {
  it('THE 2026-09-21 STATE: overrides file without the key, .env=0 -> "szandekos beallitas (=0)", not the lost-setting advice', () => {
    overrides({ CLAUDE_ROTATION_ENABLED: '1' })
    ENV = { [KEY]: '0' }
    const d = resolveMainConfigDecision()
    expect(d.trigger).toBe('isolation-lost')
    expect(sent).toHaveLength(1)
    expect(sent[0][2]).toContain('szandekos beallitas (=0)')
    expect(sent[0][2]).toContain('letezik, de ezt a kulcsot nem tartalmazza')
    expect(sent[0][2]).not.toContain(ADVICE)
    expect(sent[0][2]).not.toMatch(/torlodott|elveszett/)
    expect(log()).toContain('WARN isolation-lost')
    expect(log()).toContain(`${KEY}=0 from .env`)
  })
  it('the setting really missing (no file, no key): the notice says so and keeps the =1 advice', () => {
    const d = resolveMainConfigDecision()
    expect(d.trigger).toBe('isolation-lost')
    expect(sent[0][2]).toContain('store/config-overrides.json nem letezik')
    expect(sent[0][2]).toContain(ADVICE)
    expect(log()).toContain(`${KEY}=0 from registry default`)
  })
  it('an override of 0 over a .env of 1 is reported as the override (the precedence, measured through the store)', () => {
    overrides({ [KEY]: '0' })
    ENV = { [KEY]: '1' }
    resolveMainConfigDecision()
    expect(sent[0][2]).toContain('a store/config-overrides.json-ban')
    expect(log()).toContain(`${KEY}=0 from store/config-overrides.json`)
  })
})
