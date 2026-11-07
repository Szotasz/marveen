// GROMZOBRIDGEWIZARD1107 D1 (Samu 72469 (2), 72485): the server sees an owner's Gromzo approval through without the
// dashboard panel open. The rules (pace, "used", final answers, restore) are in gromzo-agents.test.ts; here: the
// saved file (0600, written whole), one watcher round that finishes a switch with no panel, and its wiring in web.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const logged: string[] = []
vi.mock('../logger.js', () => {
  const rec = (...args: unknown[]) => { logged.push(JSON.stringify(args)) }
  const l: Record<string, unknown> = { info: rec, warn: rec, error: rec, debug: rec, trace: rec, fatal: rec }
  l.child = () => l
  return { logger: l }
})

const { fileConsentStore, consentWatchTick, stopGromzoConsentWatchForTest, PENDING_LOG_GAP_MS } = await import('../web/routes/gromzo.js')
const { enableGromzoAgent, resetPendingGromzoConsents, setPendingConsentStore, pendingGromzoConsentSlug, CHECK_GAP_MS } = await import('../web/gromzo-agents.js')
type Deps = import('../web/gromzo-agents.js').GromzoAgentDeps
type Reply = import('../web/mxd-dash.js').MxdDashReply

const ID = 'consent-aaaaaaaaaaaa'
let dir = ''
beforeEach(() => { resetPendingGromzoConsents(); logged.length = 0; dir = mkdtempSync(join(tmpdir(), 'gz-consent-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function deps(replies: Record<string, Reply[]>, clock: { t: number }) {
  const writes: Array<[string, boolean]> = []
  const restarted: string[] = []
  const d: Deps = {
    call: async (req) => {
      const r = replies[req.verb]?.shift()
      if (!r) throw new Error(`unscripted ${req.verb}`)
      return r
    },
    agents: () => ['zara'],
    readFlag: (s) => writes.some(([w, on]) => w === s && on),
    writeFlag: (s, on) => { writes.push([s, on]) },
    displayName: (s) => s,
    isRunning: () => true,
    held: async () => new Set(),
    readAvatar: () => ({ ok: false, code: 'no_avatar' }),
    avatarProblem: () => 'no_avatar',
    restartOne: (s) => { restarted.push(s) },
    now: () => clock.t,
  }
  return { d, writes, restarted }
}

describe('the saved pending consent: store/gromzo-agent-consent.json', () => {
  it('written whole with mode 0600, read back; an empty list removes the file', () => {
    const p = join(dir, 'gromzo-agent-consent.json')
    const st = fileConsentStore(p)
    expect(st.read()).toEqual([])
    const entry = { slug: 'zara', consentId: ID, expiresAt: 2_000, startedAt: 1_000 }
    st.write([entry])
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(st.read()).toEqual([entry])
    expect(existsSync(`${p}.${process.pid}.tmp`)).toBe(false)
    st.write([])
    expect(existsSync(p)).toBe(false)
  })
  it('an unreadable file restores nothing (and says so); a failed save keeps the switch working, logged', () => {
    const p = join(dir, 'gromzo-agent-consent.json')
    writeFileSync(p, '{not json')
    expect(fileConsentStore(p).read()).toEqual([])
    expect(logged.join('\n')).toContain('could not be read')
    const bad = fileConsentStore(join(dir, 'missing-dir', 'x.json'))
    expect(() => bad.write([{ slug: 'zara', consentId: ID, expiresAt: 2, startedAt: 1 }])).not.toThrow()
    expect(logged.join('\n')).toContain('could NOT be saved')
  })
})

describe('one watcher round, with no panel open', () => {
  it('nothing pending: no call', async () => {
    const clock = { t: 1_000_000 }
    const { d } = deps({}, clock)
    expect(await consentWatchTick(d)).toBeNull()
  })
  it('the owner approved in the app: the round finishes the switch (flag, restart) and logs that the server did it', async () => {
    const clock = { t: 1_000_000 }
    const { d, writes, restarted } = deps({ agent_add: [{ ok: true, consent_id: ID, expires_in: 600 }] }, clock)
    const saved: unknown[] = []
    setPendingConsentStore({ read: () => [], write: (e) => { saved.push(e) } })
    await enableGromzoAgent('zara', d)
    expect(pendingGromzoConsentSlug()).toBe('zara')
    ;(d as { call: Deps['call'] }).call = async (req) => {
      expect(req).toEqual({ verb: 'agent_add_check', id: ID })
      return { ok: true, state: 'pending' }
    }
    expect(await consentWatchTick(d)).toMatchObject({ ok: true, state: 'pending' })
    clock.t += CHECK_GAP_MS
    ;(d as { call: Deps['call'] }).call = async () => ({ ok: true, state: 'added', slug: 'zara', restart: true })
    expect(await consentWatchTick(d)).toEqual({ ok: true, state: 'added' })
    expect(writes).toEqual([['zara', true]])
    expect(restarted).toEqual(['zara'])
    expect(pendingGromzoConsentSlug()).toBeNull()
    expect(saved.at(-1)).toEqual([])
    expect(logged.join('\n')).toContain('the server finished the switch')
  })
  // D1 expiry edge (b): the watcher's rounds leave a trace. Before, a pending round logged nothing and the lapse dropped
  // the consent silently, so the QA-VPS log could not tell a lost approval from a watcher that never ran.
  it('a pending round is logged, at most once per PENDING_LOG_GAP_MS', async () => {
    stopGromzoConsentWatchForTest()
    const clock = { t: 1_000_000 }
    const { d } = deps({ agent_add: [{ ok: true, consent_id: ID, expires_in: 600 }] }, clock)
    await enableGromzoAgent('zara', d)
    ;(d as { call: Deps['call'] }).call = async () => ({ ok: true, state: 'pending' })
    const real = Date.now
    let wall = 5_000_000
    Date.now = () => wall
    try {
      await consentWatchTick(d)
      clock.t += CHECK_GAP_MS; wall += CHECK_GAP_MS
      await consentWatchTick(d)
      expect(logged.filter((l) => l.includes('still waiting for the owner')).length).toBe(1)
      clock.t += PENDING_LOG_GAP_MS; wall += PENDING_LOG_GAP_MS
      await consentWatchTick(d)
      expect(logged.filter((l) => l.includes('still waiting for the owner')).length).toBe(2)
    } finally { Date.now = real }
  })
  it('the lapse is logged with its reason; the final check after the expiry is the one that says it', async () => {
    const clock = { t: 1_000_000 }
    const { d, writes } = deps({ agent_add: [{ ok: true, consent_id: ID, expires_in: 60 }] }, clock)
    await enableGromzoAgent('zara', d)
    clock.t += 60_000
    ;(d as { call: Deps['call'] }).call = async () => ({ ok: true, state: 'pending' })
    expect(await consentWatchTick(d)).toEqual({ ok: true, state: 'expired' })
    expect(writes).toEqual([])
    const line = logged.find((l) => l.includes('the approval request expired'))
    expect(line).toContain('pending_after_expiry')
    expect(pendingGromzoConsentSlug()).toBeNull()
  })
  it('a failed check keeps the consent and says so (no throw)', async () => {
    const clock = { t: 1_000_000 }
    const { d } = deps({ agent_add: [{ ok: true, consent_id: ID, expires_in: 600 }] }, clock)
    await enableGromzoAgent('zara', d)
    ;(d as { call: Deps['call'] }).call = async () => { throw new Error('ECONNREFUSED') }
    expect(await consentWatchTick(d)).toBeNull()
    expect(pendingGromzoConsentSlug()).toBe('zara')
    expect(logged.join('\n')).toContain('the approval is kept')
  })
})

describe('the wiring in web.ts', () => {
  const web = readFileSync(new URL('../web.ts', import.meta.url), 'utf8')
  it('the saved consent comes back at start; the watcher runs only with the background services on', () => {
    expect(web).toMatch(/initGromzoConsentWatch\(\{ watch: !servicesOff \}\)/)
    expect(web.indexOf('initGromzoConsentWatch(')).toBeGreaterThan(web.indexOf('const servicesOff = !services.run'))
  })
})
