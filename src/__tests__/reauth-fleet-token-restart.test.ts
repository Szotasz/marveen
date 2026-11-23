// TOKENSWAPRESTART1123 (a): a fleet-token sub-agent with a dead session token is restarted (it re-reads the fleet
// token file), not sent /login, and only once the fleet token itself probes healthy.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fx = vi.hoisted(() => ({
  probe: 'healthy' as 'healthy' | 'quarantined' | 'inconclusive' | 'no-token',
  restarts: [] as Array<{ name: string; opts: unknown }>,
  execCalls: [] as unknown[][],
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      fx.execCalls.push(args)
      const cb = args.find((a) => typeof a === 'function') as ((e: null) => void) | undefined
      cb?.(null)
    },
  }
})
vi.mock('../web/agent-process.js', () => ({
  withTmuxBatch: (fn: () => unknown) => fn(),
  tmuxBatchListSessionsFailed: () => false,
  isAgentRunning: () => true,
  capturePane: () => 'pane',
  startAgentProcess: async () => ({ ok: true }),
  restartAgentProcess: async (name: string, opts: unknown) => { fx.restarts.push({ name, opts }); return { ok: true } },
}))
vi.mock('../web/reauth-detect.js', () => ({ detectReauthNeeded: () => ({ needsReauth: true, reason: 'API Error: 401' }) }))
vi.mock('../web/claude-credentials-guard.js', () => ({ quarantineFleetTokenIfDead: async () => fx.probe }))
vi.mock('../web/restart-lock.js', () => ({ isRestartInFlight: () => false }))
vi.mock('../web/session-send-lock.js', () => ({ withSessionSendLock: async (_s: string, _h: unknown, _m: string, fn: () => Promise<unknown>) => { await fn(); return { ran: true } } }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { decideReauthAction, checkSession, _setFleetTokenRuleForTest, loadFleetTokenRule, agentUsesFleetTokenNow, NO_REAUTH_STATE } from '../web/reauth-healer.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const T = { threshold: 1, cooldownMs: 0 }
const input = (over: Record<string, unknown> = {}) => ({
  isDeadToken: true, sessionAlive: true, isMain: false, canInteractiveLogin: true, isFirstRunGate: false,
  usesOwnTokenFile: false, usesFleetToken: false, prev: NO_REAUTH_STATE, nowMs: 1000, ...over,
})
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)) }

describe('decideReauthAction: the fleet-token sub-agent', () => {
  it('a fleet-token sub-agent: restart, no /login', () => {
    const d = decideReauthAction(input({ usesFleetToken: true }), T)
    expect(d.restartFleetAgent).toBe(true)
    expect(d.sendKeys).toBe(false)
    expect(d.escalate).toBe(true)
  })
  it('a sub-agent not on the fleet token: unchanged (/login, no fleet restart)', () => {
    const d = decideReauthAction(input(), T)
    expect(d.restartFleetAgent).toBe(false)
    expect(d.sendKeys).toBe(true)
  })
  it('never for the main agent, never on the first-run gate, never below the threshold', () => {
    expect(decideReauthAction(input({ usesFleetToken: true, isMain: true }), T).restartFleetAgent).toBe(false)
    expect(decideReauthAction(input({ usesFleetToken: true, isFirstRunGate: true }), T).restartFleetAgent).toBe(false)
    expect(decideReauthAction(input({ usesFleetToken: true }), { threshold: 3, cooldownMs: 0 }).restartFleetAgent).toBe(false)
  })
  it('a clean probe ends the spell with no restart', () => {
    expect(decideReauthAction(input({ usesFleetToken: true, isDeadToken: false }), T).restartFleetAgent).toBe(false)
  })
})

describe('checkSession: the restart waits for a healthy fleet token', () => {
  beforeEach(() => {
    fx.restarts.length = 0
    fx.execCalls.length = 0
    _setFleetTokenRuleForTest((name) => name === 'fleetbot')
  })

  const runThreeTicks = async (label: string, session: string) => {
    // DEAD_PROBE_THRESHOLD in production is 3 consecutive dead probes
    for (let i = 0; i < 3; i++) checkSession(label, session, false, false)
    await flush()
  }

  it('healthy fleet token: the agent is restarted with a wake, and no /login keys are sent', async () => {
    fx.probe = 'healthy'
    await runThreeTicks('fleetbot', 'agent-fleetbot-a')
    expect(fx.restarts).toEqual([{ name: 'fleetbot', opts: { wake: { reason: 'fleet-token-refresh' } } }])
    // no keys typed into the pane at all (the owner alert may still mention /login in its text; that goes through notify.sh)
    const KEYS_VERB = ['send', 'keys'].join('-')
    expect(fx.execCalls.some((c) => Array.isArray(c[1]) && (c[1] as string[]).includes(KEYS_VERB))).toBe(false)
  })

  it('a quarantined or unproven fleet token: no restart (it would come back on a dead credential)', async () => {
    for (const probe of ['quarantined', 'inconclusive', 'no-token'] as const) {
      fx.probe = probe
      fx.restarts.length = 0
      await runThreeTicks('fleetbot', `agent-fleetbot-${probe}`)
      expect(fx.restarts, probe).toEqual([])
    }
  })

  it('an agent the rule does not name is never restarted by this path', async () => {
    fx.probe = 'healthy'
    await runThreeTicks('ownbot', 'agent-ownbot')
    expect(fx.restarts).toEqual([])
    // positive control for the "no keys" assertion above: where the host can do an interactive login, a non-fleet
    // sub-agent still gets the old /login keys, so the assertion can see keys when there are any
    const KEYS_VERB = ['send', 'keys'].join('-')
    if (process.platform === 'darwin') {
      expect(fx.execCalls.some((c) => Array.isArray(c[1]) && (c[1] as string[]).includes(KEYS_VERB))).toBe(true)
    }
  })
})

describe('loadFleetTokenRule (the production wiring of the rule)', () => {
  it('a loaded rule is what agentUsesFleetTokenNow answers', async () => {
    _setFleetTokenRuleForTest(null)
    expect(agentUsesFleetTokenNow('fleetbot')).toBe(false)
    expect(await loadFleetTokenRule(async () => ({ usesFleetToken: (n: string) => n === 'fleetbot' }))).toBe(true)
    expect(agentUsesFleetTokenNow('fleetbot')).toBe(true)
    expect(agentUsesFleetTokenNow('ownbot')).toBe(false)
  })
  it('a failed load keeps the old behaviour (no fleet-token agent), and says so', async () => {
    _setFleetTokenRuleForTest(null)
    expect(await loadFleetTokenRule(async () => { throw new Error('boom') })).toBe(false)
    expect(await loadFleetTokenRule(async () => ({}) as never)).toBe(false)
    expect(agentUsesFleetTokenNow('fleetbot')).toBe(false)
  })
  it('the default importer names the module that exports usesFleetToken, and startReauthHealer calls the loader', () => {
    const healer = readFileSync(join(__dirname, '..', 'web', 'reauth-healer.ts'), 'utf-8')
    expect(healer).toContain("() => import('./claude-plan-fleet-wiring.js')")
    expect(healer).toMatch(/startReauthHealer[\s\S]*void loadFleetTokenRule\(\)/)
    const wiring = readFileSync(join(__dirname, '..', 'web', 'claude-plan-fleet-wiring.ts'), 'utf-8')
    expect(wiring).toMatch(/export function usesFleetToken\(name: string\): boolean/)
  })
})
