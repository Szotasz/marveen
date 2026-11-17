// TEAMSPAIRED1115: with Teams as the main channel the setup wizard kept reopening at the pairing step although the
// channel worked: GET /api/onboarding/status said paired=false, because paired() read only <state dir>/access.json,
// which the Teams plugin never writes. The plugin (claude-channel-teams 0.3.0, src/pairing/allowlist.ts and
// src/config.ts) keeps its paired users in <stateDir>/allowlist.json, {"version":1,"entries":[{"aad_object_id":...}]}.
// The state dir here has NO access.json at all, as on a real Teams install.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const H = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  return { ...a, PROJECT_ROOT: H.root, STORE_DIR: `${H.root}/store-dir`, CHANNEL_PROVIDER: 'teams' as const }
})
vi.mock('node:os', async (orig) => {
  const a = await orig<typeof import('node:os')>()
  const homedir = () => `${H.root}/fakehome`
  return { ...a, homedir, default: { ...a, homedir } }
})

const tmpRoot = mkdtempSync(join(tmpdir(), 'onb-teams-'))
H.root = tmpRoot
mkdirSync(join(tmpRoot, 'fakehome'), { recursive: true })
const STATE = join(tmpRoot, 'teams-state')
mkdirSync(STATE, { recursive: true })
// The plugin and the dashboard agree on one dir through TEAMS_STATE_DIR (channels.sh exports it; the plugin reads it
// as its legacy alias, src/config.ts resolveStateDir).
const origStateEnv = process.env.TEAMS_STATE_DIR
process.env.TEAMS_STATE_DIR = STATE
const binDir = join(tmpRoot, 'bin')
mkdirSync(binDir, { recursive: true })
writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\nexit 1\n')
chmodSync(join(binDir, 'tmux'), 0o755)
const origPath = process.env.PATH
process.env.PATH = `${binDir}:${origPath ?? ''}`

const { tryHandleOnboarding } = await import('../web/routes/onboarding.js')

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeAll(() => { Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' }) })
afterAll(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  process.env.PATH = origPath
  if (origStateEnv === undefined) delete process.env.TEAMS_STATE_DIR
  else process.env.TEAMS_STATE_DIR = origStateEnv
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function status() {
  let out = ''
  const req = Object.assign(Readable.from([]), { headers: {} })
  const res = { setHeader() {}, writeHead() {}, end(b?: string) { out = b ?? '' } }
  const url = new URL('http://localhost/api/onboarding/status')
  await tryHandleOnboarding({ req, res, path: url.pathname, method: 'GET', url, auth: { kind: 'session', user: 'owner' } } as any)
  return JSON.parse(out) as { paired: boolean; channelProvider?: string }
}
const ALLOWLIST = join(STATE, 'allowlist.json')
const entry = (id: string) => ({ aad_object_id: id, added_at: '2026-11-15T16:00:00Z' })

describe('paired() on a Teams main channel reads the plugin allowlist (TEAMSPAIRED1115)', () => {
  beforeEach(() => { rmSync(ALLOWLIST, { force: true }) })

  it('the state dir has no access.json, as on a real Teams install', () => {
    expect(existsSync(join(STATE, 'access.json'))).toBe(false)
  })

  it('one paired user in allowlist.json: paired', async () => {
    writeFileSync(ALLOWLIST, JSON.stringify({ version: 1, entries: [entry('6f1c2d3e-0000-4000-8000-000000000001')] }))
    expect((await status()).paired).toBe(true)
  })

  it('no allowlist.json, or an empty list: not paired', async () => {
    expect((await status()).paired).toBe(false)
    writeFileSync(ALLOWLIST, JSON.stringify({ version: 1, entries: [] }))
    expect((await status()).paired).toBe(false)
  })

  it('a shape the plugin itself treats as empty is not paired: another version, no array, no id, garbage', async () => {
    for (const text of [
      JSON.stringify({ version: 2, entries: [entry('a')] }),
      JSON.stringify({ version: 1, entries: {} }),
      JSON.stringify({ version: 1, entries: [{ added_at: 'x' }, { aad_object_id: '' }, { aad_object_id: 7 }, null] }),
      '{ not json',
    ]) {
      writeFileSync(ALLOWLIST, text)
      expect((await status()).paired, text).toBe(false)
    }
  })
})

describe('the wizard pairing text names Teams on a Teams install (TEAMSPAIRED1115)', () => {
  const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
  const HU = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
  const EN = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

  it('step 3 picks the Teams keys when the provider is teams, the old keys otherwise', () => {
    const i = APP.indexOf('function onbStep3Html(s) {')
    const body = APP.slice(i, APP.indexOf('\nfunction ', i + 10))
    expect(body).toMatch(/onboardingChannelProvider === 'teams'\s*\?[^:]*onboarding\.step3\.li1_teams[^:]*onboarding\.step3\.li2_teams/)
    expect(body).toContain("t('onboarding.step3.li1')")
  })

  it('both keys exist in hu and en, and name Teams', () => {
    for (const [lang, src] of [['hu', HU], ['en', EN]] as const) {
      for (const key of ['onboarding.step3.li1_teams', 'onboarding.step3.li2_teams']) {
        const m = src.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'([^']+)'`))
        expect(m, `${lang} ${key}`).not.toBeNull()
        expect(m![1], `${lang} ${key}`).toMatch(/Teams/)
      }
    }
  })
})
