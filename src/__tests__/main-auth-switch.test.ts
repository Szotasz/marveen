// MAINAUTHSWITCH1107 (APIKULCSINDITAS1004 D): the main agent's PUT opens for authMode + apiKey only, for the owner,
// with the conflicts main-auth.ts would otherwise turn into a silent fallback refused up front.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkMainAuthSwitch, type MainAuthSwitchFacts } from '../web/main-auth-switch.js'

const KEY = 'fake-main-api-key-value-0123456789abcdef'
const clean: MainAuthSwitchFacts = { explicitConfigDir: false, rotatedConfigDir: false, rotatedTokenPlan: false, customProvider: false, keyAvailable: false }

describe('checkMainAuthSwitch', () => {
  it('api with a new key: ok, the key trimmed', () => {
    expect(checkMainAuthSwitch({ authMode: 'api', apiKey: `  ${KEY} ` }, clean)).toEqual({ ok: true, mode: 'api', newKey: KEY })
  })
  it('api without a new key: ok only when a key is already there', () => {
    expect(checkMainAuthSwitch({ authMode: 'api' }, { ...clean, keyAvailable: true })).toEqual({ ok: true, mode: 'api', newKey: null })
    expect(checkMainAuthSwitch({ authMode: 'api' }, clean)).toMatchObject({ ok: false, status: 400, code: 'no-key' })
  })
  it('back to shared: ok, whatever else is set up (it never bills)', () => {
    expect(checkMainAuthSwitch({ authMode: 'shared' }, { ...clean, explicitConfigDir: true, customProvider: true })).toEqual({ ok: true, mode: 'shared', newKey: null })
  })
  it.each([
    ['explicit own login', { explicitConfigDir: true }, 'own-login'],
    ['rotated plan dir', { rotatedConfigDir: true }, 'rotated-plan'],
    ['rotated token plan', { rotatedTokenPlan: true }, 'rotated-plan'],
    ['custom provider', { customProvider: true }, 'custom-provider'],
  ])('api with %s: 409 %s, before any key check', (_n, f, code) => {
    expect(checkMainAuthSwitch({ authMode: 'api', apiKey: KEY }, { ...clean, ...f })).toMatchObject({ ok: false, status: 409, code })
  })
  it('own_team: 409; an unknown mode: 400', () => {
    expect(checkMainAuthSwitch({ authMode: 'own_team' }, clean)).toMatchObject({ ok: false, status: 409, code: 'own-team' })
    expect(checkMainAuthSwitch({ authMode: 'x' }, clean)).toMatchObject({ ok: false, status: 400, code: 'bad-mode' })
    expect(checkMainAuthSwitch({}, clean)).toMatchObject({ ok: false, status: 400, code: 'bad-mode' })
  })
  it('everything else stays read-only', () => {
    expect(checkMainAuthSwitch({ authMode: 'api', apiKey: KEY, model: 'x' }, clean)).toMatchObject({ ok: false, status: 400, code: 'read-only' })
    expect(checkMainAuthSwitch({ claudeMd: 'x' }, clean)).toMatchObject({ ok: false, code: 'read-only' })
    expect(checkMainAuthSwitch(null, clean)).toMatchObject({ ok: false, code: 'bad-body' })
    expect(checkMainAuthSwitch([], clean)).toMatchObject({ ok: false, code: 'bad-body' })
  })
  it('a key with shared, or a key that is not one: 400', () => {
    expect(checkMainAuthSwitch({ authMode: 'shared', apiKey: KEY }, clean)).toMatchObject({ ok: false, code: 'key-without-api' })
    expect(checkMainAuthSwitch({ authMode: 'api', apiKey: 'short' }, clean)).toMatchObject({ ok: false, code: 'bad-key' })
    expect(checkMainAuthSwitch({ authMode: 'api', apiKey: 'has a space inside 0123456789' }, clean)).toMatchObject({ ok: false, code: 'bad-key' })
    expect(checkMainAuthSwitch({ authMode: 'api', apiKey: 42 }, clean)).toMatchObject({ ok: false, code: 'bad-key' })
    expect(checkMainAuthSwitch({ authMode: 'api', apiKey: 'x'.repeat(513) }, clean)).toMatchObject({ ok: false, code: 'bad-key' })
  })
})

describe('the route: owner gate first, nothing stored before the checks and the live probe', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'web', 'routes', 'agents.ts'), 'utf-8')
  const start = src.indexOf('// MAINAUTHSWITCH1107 (APIKULCSINDITAS1004 D): read-only except')
  const block = src.slice(start, src.indexOf("    const body = await readBody(req)\n    const configRoot = agentConfigRoot(name)", start))
  const at = (needle: string) => { const i = block.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i }
  it('the order', () => {
    const gate = at('if (!mayActAsOwner(ctx.auth, req)) {')
    const verdict = at('const verdict = checkMainAuthSwitch(mdata, {')
    const probe = at('probe = await liveProbeAuth({ ANTHROPIC_API_KEY: verdict.newKey })')
    const rejected = at("if (probe === 'auth-rejected') {")
    const store = at('setSecret(`agent-${name}-api-key`')
    const mode = at('writeAgentAuthMode(name, verdict.mode)')
    expect(at('onlySwitchFields')).toBeLessThan(gate)
    expect(gate).toBeLessThan(verdict)
    expect(verdict).toBeLessThan(probe)
    expect(probe).toBeLessThan(rejected)
    expect(rejected).toBeLessThan(store)
    expect(store).toBeLessThan(mode)
  })
  it('the explicit-dir rule mirrors main-agent-isolated-config.mjs, and the key never reaches a reply or a log', () => {
    expect(block).toContain('explicitConfigDir: explicit !== null && !(explicitConfigDirLacksOwnLogin(explicit) && fleetTokenUsable)')
    expect(block).not.toMatch(/json\(res, \{[^}]*newKey/)
    // logged as a boolean only (!!verdict.newKey), never the value
    for (const l of block.split('\n').filter((x) => /logger\.\w+\(/.test(x))) expect(l.replace(/!!verdict\.newKey/g, '')).not.toContain('verdict.newKey')
  })
  it('the agent detail of the main agent carries the last launch record', () => {
    expect(src).toContain('...(isMainChannelsAgent(name) ? { mainAuthLaunched: readMainAuthLaunched() } : {}),')
  })
})
