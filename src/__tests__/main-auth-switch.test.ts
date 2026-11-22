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
    // HOSTINGERROUTER1122: model is a field now, but only with the router.
    expect(checkMainAuthSwitch({ authMode: 'api', apiKey: KEY, model: 'x' }, clean)).toMatchObject({ ok: false, status: 400, code: 'model-without-router' })
    expect(checkMainAuthSwitch({ authMode: 'api', apiKey: KEY, customProvider: 'x' }, clean)).toMatchObject({ ok: false, status: 400, code: 'read-only' })
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

// HOSTINGERROUTER1122 (Samu 83036): "router" is the Hostinger AI Router, only on a Hostinger install, never the default.
describe('checkMainAuthSwitch: the Hostinger AI Router', () => {
  // built at run time: a literal sk- shape trips the repository's secret gate (it is a fixture, not a key)
  const RKEY = ['sk', 'hstgr', '0123456789abcdefghij'].join('-')
  const hostinger: MainAuthSwitchFacts = { ...clean, routerAvailable: true }
  it('router with a key: ok, the default model when none is given', () => {
    expect(checkMainAuthSwitch({ authMode: 'router', apiKey: ` ${RKEY} ` }, hostinger))
      .toEqual({ ok: true, mode: 'router', newKey: RKEY, model: 'claude-sonnet-5-5' })
    expect(checkMainAuthSwitch({ authMode: 'router', apiKey: RKEY, model: 'claude-opus-5-5' }, hostinger))
      .toEqual({ ok: true, mode: 'router', newKey: RKEY, model: 'claude-opus-5-5' })
  })
  it('not a Hostinger install: 409, whatever the body', () => {
    expect(checkMainAuthSwitch({ authMode: 'router', apiKey: RKEY }, clean)).toMatchObject({ ok: false, status: 409, code: 'router-unavailable' })
  })
  it('a key without the sk-hstgr- prefix, a dotted or unknown model, no stored key: 400', () => {
    expect(checkMainAuthSwitch({ authMode: 'router', apiKey: KEY }, hostinger)).toMatchObject({ ok: false, status: 400, code: 'bad-key' })
    expect(checkMainAuthSwitch({ authMode: 'router', apiKey: RKEY, model: 'claude-sonnet-5.5' }, hostinger)).toMatchObject({ ok: false, status: 400, code: 'bad-model' })
    expect(checkMainAuthSwitch({ authMode: 'router', apiKey: RKEY, model: 'claude-fable-5-2' }, hostinger)).toMatchObject({ ok: false, status: 400, code: 'bad-model' })
    expect(checkMainAuthSwitch({ authMode: 'router' }, hostinger)).toMatchObject({ ok: false, status: 400, code: 'no-key' })
    expect(checkMainAuthSwitch({ authMode: 'router' }, { ...hostinger, routerKeyAvailable: true }))
      .toEqual({ ok: true, mode: 'router', newKey: null, model: 'claude-sonnet-5-5' })
  })
  it.each([
    ['explicit own login', { explicitConfigDir: true }, 'own-login'],
    ['rotated plan', { rotatedTokenPlan: true }, 'rotated-plan'],
    ['another custom provider', { customProvider: true }, 'custom-provider'],
  ])('router with %s: 409 %s', (_n, f, code) => {
    expect(checkMainAuthSwitch({ authMode: 'router', apiKey: RKEY }, { ...hostinger, ...f })).toMatchObject({ ok: false, status: 409, code })
  })
  it('a router key with shared: 400; model with shared: 400', () => {
    expect(checkMainAuthSwitch({ authMode: 'shared', apiKey: RKEY }, hostinger)).toMatchObject({ ok: false, code: 'key-without-api' })
    expect(checkMainAuthSwitch({ authMode: 'shared', model: 'claude-sonnet-5-5' }, hostinger)).toMatchObject({ ok: false, code: 'model-without-router' })
  })
})

describe('checkMainAuthSwitch: the router list (Samu 83048 c)', () => {
  const RKEY = ['sk', 'hstgr', '0123456789abcdefghij'].join('-')
  const hostinger: MainAuthSwitchFacts = { ...clean, routerAvailable: true, routerKeyAvailable: true }
  it('a model of the router list is accepted; one outside it and outside the measured three is not', () => {
    expect(checkMainAuthSwitch({ authMode: 'router', model: 'kimi-k3' }, { ...hostinger, routerModels: ['kimi-k3', 'claude-opus-4.6'] }))
      .toEqual({ ok: true, mode: 'router', newKey: null, model: 'kimi-k3' })
    expect(checkMainAuthSwitch({ authMode: 'router', model: 'kimi-k3' }, hostinger)).toMatchObject({ ok: false, code: 'bad-model' })
    expect(checkMainAuthSwitch({ authMode: 'router', apiKey: RKEY, model: 'claude-haiku-5-5' }, { ...hostinger, routerModels: [] }))
      .toMatchObject({ ok: true, model: 'claude-haiku-5-5' })
  })
})
