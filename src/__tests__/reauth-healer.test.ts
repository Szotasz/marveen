import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideReauthAction, evaluateSession, checkSession, agentUsesOwnTokenFile, agentTokenFileState, tokenFileSignals, escalationTokenFileHint, logsTokenFileSkip, NO_REAUTH_STATE, type ReauthHealerState } from '../web/reauth-healer.js'

// ---- FILE-LEVEL MOCKS (vi.mock is hoisted to the top of this file whatever its position; they apply to EVERY test below) ----
// agent-config lookup: <root>/<agent>/agent-config.json, the root is a temp dir per test.
const fixture = vi.hoisted(() => ({ root: '', execCalls: [] as unknown[][], pane: 'pane', reauth: { needsReauth: true, reason: 'API Error: 401' } as { needsReauth: boolean; reason?: string } }))
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentConfigRoot: (name: string) => {
      // like the real agentDir()/safeJoin: a path-traversal name throws; "rootthrows" simulates any OTHER failure
      if (name.includes('..')) throw new Error('unsafe agent name')
      if (name === 'rootthrows') throw new Error('path helper broke')
      // an ENOENT thrown by the path helper itself is NOT "the agent has no config file"
      if (name === 'rootenoent') throw Object.assign(new Error('realpath failed'), { code: 'ENOENT' })
      return `${fixture.root}/${name}`
    },
  }
})
// A resolver error must not look like "no token file": the lookup is mocked to throw for a marker config.
vi.mock('../web/agent-oauth-token-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-oauth-token-file.js')>()
  return {
    ...actual,
    resolveOauthTokenFileSetting: (raw: string) => {
      if (raw.includes('RESOLVER-THROWS')) throw new Error('resolver failed')
      return actual.resolveOauthTokenFileSetting(raw)
    },
  }
})
// checkSession's collaborators: the pane, the detector, tmux/notify (execFile), the send lock, the credential guard, the logger.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      fixture.execCalls.push(args)
      const cb = args.find((a) => typeof a === 'function') as ((e: null) => void) | undefined
      cb?.(null)
    },
  }
})
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: () => true,
  capturePane: () => fixture.pane,
  startAgentProcess: async () => ({ ok: true }),
}))
vi.mock('../web/reauth-detect.js', () => ({ detectReauthNeeded: () => fixture.reauth }))
vi.mock('../web/claude-credentials-guard.js', () => ({ quarantineFleetTokenIfDead: async () => 'no-token' }))
vi.mock('../web/session-send-lock.js', () => ({ withSessionSendLock: async (_s: string, _h: unknown, _m: string, fn: () => Promise<unknown>) => { await fn(); return { ran: true } } }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const T = { threshold: 3, cooldownMs: 30 * 60 * 1000 }
const base = (over: Partial<Parameters<typeof decideReauthAction>[0]> = {}) => ({
  isDeadToken: true,
  sessionAlive: true,
  isMain: false,
  canInteractiveLogin: true,
  prev: NO_REAUTH_STATE,
  nowMs: 1_000_000,
  ...over,
})

// Autonomous re-auth healer decision (Adam stability-fix #1). Conservative:
// false-positive avoidance is the priority since the action injects /login.
describe('decideReauthAction', () => {
  it('clean token resets the spell, no action', () => {
    const d = decideReauthAction(base({ isDeadToken: false, prev: { consecutiveDead: 2, lastActionAtMs: 5 } }), T)
    expect(d.sendKeys).toBe(false)
    expect(d.escalate).toBe(false)
    expect(d.next).toEqual(NO_REAUTH_STATE)
  })

  it('dead session-gone resets the spell (capture-null treated as not-applicable)', () => {
    const d = decideReauthAction(base({ sessionAlive: false, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.escalate).toBe(false)
    expect(d.next.consecutiveDead).toBe(0)
  })

  it('debounces: 1st and 2nd dead probes do not act', () => {
    const p1 = decideReauthAction(base({ prev: NO_REAUTH_STATE }), T)
    expect(p1.escalate).toBe(false)
    expect(p1.next.consecutiveDead).toBe(1)
    const p2 = decideReauthAction(base({ prev: p1.next }), T)
    expect(p2.escalate).toBe(false)
    expect(p2.next.consecutiveDead).toBe(2)
  })

  it('3rd consecutive dead probe escalates + send-keys (sub-agent)', () => {
    const d = decideReauthAction(base({ prev: { consecutiveDead: 2, lastActionAtMs: null }, nowMs: 2_000_000 }), T)
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(true)
    expect(d.next.lastActionAtMs).toBe(2_000_000)
    expect(d.next.consecutiveDead).toBe(3)
  })

  it('main agent at threshold escalates but does NOT send-keys', () => {
    const d = decideReauthAction(base({ isMain: true, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(false)
  })

  it('headless host at threshold escalates but does NOT send-keys (cascade guard)', () => {
    // A headless Linux fleet host: /login would fail AND rotate the shared OAuth
    // token into a fleet-wide 401 cascade, so escalate-only even for a sub-agent.
    const d = decideReauthAction(base({ canInteractiveLogin: false, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(false)
  })

  it('cooldown: still-dead within 30min does not re-fire', () => {
    const lastActionAtMs = 1_000_000
    const d = decideReauthAction(base({
      prev: { consecutiveDead: 5, lastActionAtMs },
      nowMs: lastActionAtMs + 10 * 60 * 1000, // 10 min later
    }), T)
    expect(d.escalate).toBe(false)
    expect(d.sendKeys).toBe(false)
    expect(d.next.lastActionAtMs).toBe(lastActionAtMs) // unchanged
    expect(d.next.consecutiveDead).toBe(6) // keeps counting
  })

  it('cooldown: re-fires after 30min if still dead (does not forget)', () => {
    const lastActionAtMs = 1_000_000
    const d = decideReauthAction(base({
      prev: { consecutiveDead: 12, lastActionAtMs },
      nowMs: lastActionAtMs + 31 * 60 * 1000,
    }), T)
    expect(d.escalate).toBe(true)
    expect(d.next.lastActionAtMs).toBe(lastActionAtMs + 31 * 60 * 1000)
  })

  it('a heal between dead spells lets the next spell alert immediately', () => {
    // dead x3 -> alert
    const a = decideReauthAction(base({ prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(a.escalate).toBe(true)
    // healed -> reset
    const b = decideReauthAction(base({ isDeadToken: false, prev: a.next }), T)
    expect(b.next).toEqual(NO_REAUTH_STATE)
    // dead again x3 from fresh -> alerts again (lastActionAtMs was reset)
    let s: ReauthHealerState = b.next
    let last = { escalate: false } as { escalate: boolean }
    for (let i = 0; i < 3; i++) { const r = decideReauthAction(base({ prev: s, nowMs: 9_000_000 }), T); s = r.next; last = r }
    expect(last.escalate).toBe(true)
  })
})

// 2026-07-16 first-run gate (bootcamp): the "Select login method" picker /
// browser sign-in screen is NOT a dead token. A /login send-keys there is
// actively harmful (Enter accepts a login method -> browser OAuth on a VALID
// credential); the heal is a sub-agent restart, which re-seeds the flag.
describe('decideReauthAction: first-run gate', () => {
  const gated = { consecutiveDead: 2, lastActionAtMs: null } as ReauthHealerState

  it('suppresses /login send-keys and restarts instead (sub-agent, at threshold)', () => {
    const d = decideReauthAction(base({ isFirstRunGate: true, prev: gated }), T)
    expect(d.sendKeys).toBe(false)
    expect(d.restartAgent).toBe(true)
    expect(d.escalate).toBe(true)
  })

  it('restart works headless too (canInteractiveLogin false)', () => {
    const d = decideReauthAction(base({ isFirstRunGate: true, canInteractiveLogin: false, prev: gated }), T)
    expect(d.sendKeys).toBe(false)
    expect(d.restartAgent).toBe(true)
  })

  it('main agent: never restarted, never send-keys -- escalate-only', () => {
    const d = decideReauthAction(base({ isFirstRunGate: true, isMain: true, prev: gated }), T)
    expect(d.sendKeys).toBe(false)
    expect(d.restartAgent).toBe(false)
    expect(d.restartMain).toBe(false)
    expect(d.escalate).toBe(true)
  })

  it('a genuine 401 (not first-run gate) keeps the legacy behavior: send-keys, no restart', () => {
    const d = decideReauthAction(base({ prev: gated }), T)
    expect(d.sendKeys).toBe(true)
    expect(d.restartAgent).toBe(false)
  })

  it('below threshold: no restart', () => {
    const d = decideReauthAction(base({ isFirstRunGate: true, prev: NO_REAUTH_STATE }), T)
    expect(d.restartAgent).toBe(false)
    expect(d.escalate).toBe(false)
  })
})

// GAP 2a (PLAN.md, 2026-07-23 marveen-channels silent outage): once GAP 1 lands,
// a dead main-agent token is a legitimate restart target (fresh process either
// picks the still-good fleet token back up, or the token is quarantined by the
// escalate branch first) -- decideReauthAction gains restartMain, gated at the
// exact same fireNow threshold as escalate, for the main agent only, and never
// on the first-run gate (see the "escalate-only" test above, extended with
// restartMain === false).
describe('decideReauthAction: restartMain (main agent dead-token restart)', () => {
  it('3rd consecutive dead probe fires restartMain for the main agent (not first-run gate)', () => {
    const d = decideReauthAction(base({ isMain: true, prev: { consecutiveDead: 2, lastActionAtMs: null }, nowMs: 2_000_000 }), T)
    expect(d.escalate).toBe(true)
    expect(d.restartMain).toBe(true)
    expect(d.sendKeys).toBe(false)
    expect(d.restartAgent).toBe(false)
  })

  it('debounces: below threshold, restartMain stays false', () => {
    const p1 = decideReauthAction(base({ isMain: true, prev: NO_REAUTH_STATE }), T)
    expect(p1.restartMain).toBe(false)
    const p2 = decideReauthAction(base({ isMain: true, prev: p1.next }), T)
    expect(p2.restartMain).toBe(false)
  })

  it('sub-agent never gets restartMain, even at threshold', () => {
    const d = decideReauthAction(base({ isMain: false, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.restartMain).toBe(false)
  })

  it('cooldown: still-dead within 30min does not re-fire restartMain', () => {
    const lastActionAtMs = 1_000_000
    const d = decideReauthAction(base({
      isMain: true,
      prev: { consecutiveDead: 5, lastActionAtMs },
      nowMs: lastActionAtMs + 10 * 60 * 1000, // 10 min later
    }), T)
    expect(d.restartMain).toBe(false)
    expect(d.escalate).toBe(false)
  })

  it('cooldown: restartMain re-fires after 30min if still dead (mirrors escalate)', () => {
    const lastActionAtMs = 1_000_000
    const d = decideReauthAction(base({
      isMain: true,
      prev: { consecutiveDead: 12, lastActionAtMs },
      nowMs: lastActionAtMs + 31 * 60 * 1000,
    }), T)
    expect(d.restartMain).toBe(true)
    expect(d.escalate).toBe(true)
  })
})

// Per-agent setup-token file (agent-config.json "oauthTokenFile"): such an
// agent authenticates from its own file, so an interactive /login would
// REPLACE the session's credential instead of refreshing it -- the /login
// send-keys branch must never fire, and the heal is "token refresh needed".
describe('decideReauthAction: own oauthTokenFile (no /login)', () => {
  it('sub-agent with a token file at threshold: fire, escalate, but NO /login send-keys', () => {
    const d = decideReauthAction(base({
      usesOwnTokenFile: true,
      prev: { consecutiveDead: 2, lastActionAtMs: null },
    }), T)
    expect(d.fireNow).toBe(true)
    expect(d.sendKeys).toBe(false)
    expect(d.escalate).toBe(true)
    expect(d.restartAgent).toBe(false)
    expect(d.restartMain).toBe(false)
  })

  it('below threshold with a token file: nothing fires (fireNow false)', () => {
    const d = decideReauthAction(base({ usesOwnTokenFile: true, prev: NO_REAUTH_STATE }), T)
    expect(d.fireNow).toBe(false)
    expect(d.sendKeys).toBe(false)
    expect(d.escalate).toBe(false)
  })

  it('clean probe with a token file resets the spell (fireNow false)', () => {
    const d = decideReauthAction(base({ isDeadToken: false, usesOwnTokenFile: true, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.fireNow).toBe(false)
    expect(d.next).toEqual(NO_REAUTH_STATE)
  })

  it('absent token file is unchanged: /login send-keys still fires at threshold', () => {
    const d = decideReauthAction(base({ usesOwnTokenFile: false, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.fireNow).toBe(true)
    expect(d.sendKeys).toBe(true)
    expect(d.escalate).toBe(true)
  })
})

// The helper checkSession calls to decide usesOwnTokenFile. It is exercised through
// the real reader, so a broken lookup is visible here and not only in the pure decision.
describe('agentUsesOwnTokenFile', () => {
  beforeEach(() => { fixture.root = mkdtempSync(join(tmpdir(), 'reauth-healer-test-')) })
  afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }) })
  const writeConfig = (agent: string, raw: string) => {
    mkdirSync(join(fixture.root, agent), { recursive: true })
    writeFileSync(join(fixture.root, agent, 'agent-config.json'), raw)
  }

  it('the field is present with a usable path: true', () => {
    writeConfig('alpha', JSON.stringify({ oauthTokenFile: '/opt/tokens/alpha.token' }))
    expect(agentUsesOwnTokenFile('alpha')).toBe(true)
  })

  it('the field is absent: false (the agent keeps the /login path)', () => {
    writeConfig('beta', JSON.stringify({ model: 'x' }))
    expect(agentUsesOwnTokenFile('beta')).toBe(false)
  })

  it('no agent-config.json at all: false', () => {
    expect(agentUsesOwnTokenFile('ghost')).toBe(false)
  })

  // FAIL-CLOSED: a present-but-unusable setting is a human's call, so the agent still counts as a token-file agent
  // (no /login) and the config state says 'invalid'.
  it('unparseable JSON that mentions the field: true (fail-closed), state invalid', () => {
    writeConfig('gamma', '{ "oauthTokenFile": "/opt/tokens/gamma.token" ')
    expect(agentUsesOwnTokenFile('gamma')).toBe(true)
    expect(agentTokenFileState('gamma')).toBe('invalid')
  })

  it('unparseable JSON that does not mention the field: false (nothing declares a token file)', () => {
    writeConfig('gamma2', '{ "model": "x" ')
    expect(agentUsesOwnTokenFile('gamma2')).toBe(false)
    expect(agentTokenFileState('gamma2')).toBe('unset')
  })

  it('a rejected value (relative path): true (fail-closed), state invalid', () => {
    writeConfig('delta', JSON.stringify({ oauthTokenFile: 'relative/path' }))
    expect(agentUsesOwnTokenFile('delta')).toBe(true)
    expect(agentTokenFileState('delta')).toBe('invalid')
  })

  // FAIL-CLOSED on an I/O or resolver failure: the healer cannot tell the agent does NOT use a token file.
  // chmod 000 does not stop root, and Windows has no such mode
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable agent-config.json (permission denied): invalid, not unset', () => {
    writeConfig('locked', JSON.stringify({ oauthTokenFile: '/opt/tokens/locked.token' }))
    const f = join(fixture.root, 'locked', 'agent-config.json')
    chmodSync(f, 0o000)
    try {
      expect(agentTokenFileState('locked')).toBe('invalid')
      expect(agentUsesOwnTokenFile('locked')).toBe(true)
    } finally {
      chmodSync(f, 0o600)
    }
  })

  it('a directory in place of agent-config.json (EISDIR): invalid', () => {
    mkdirSync(join(fixture.root, 'weird', 'agent-config.json'), { recursive: true })
    expect(agentTokenFileState('weird')).toBe('invalid')
  })

  it('a resolver error: invalid, not unset', () => {
    writeConfig('boom', '{ "note": "RESOLVER-THROWS" }')
    expect(agentTokenFileState('boom')).toBe('invalid')
  })

  it('a missing agent-config.json (ENOENT) and an unsafe agent NAME stay unset', () => {
    expect(agentTokenFileState('ghost')).toBe('unset')
    for (const bad of ['../../etc', '..', '.', '', 'a/b', 'a\\b']) expect(agentTokenFileState(bad), JSON.stringify(bad)).toBe('unset')
  })

  it('any OTHER failure of the path helper (not the name check) is invalid, fail-closed', () => {
    expect(agentTokenFileState('rootthrows')).toBe('invalid')
    expect(agentUsesOwnTokenFile('rootthrows')).toBe(true)
  })

  it('an ENOENT thrown by the path helper is invalid; only the missing agent-config.json FILE is unset', () => {
    expect(agentTokenFileState('rootenoent')).toBe('invalid')
    mkdirSync(join(fixture.root, 'nofile'), { recursive: true }) // the agent directory exists, the config file does not
    expect(agentTokenFileState('nofile')).toBe('unset')
  })

  it('the three states: set, unset, invalid', () => {
    writeConfig('s1', JSON.stringify({ oauthTokenFile: '/opt/tokens/s1.token' }))
    writeConfig('s2', JSON.stringify({}))
    writeConfig('s3', JSON.stringify({ oauthTokenFile: 42 }))
    expect([agentTokenFileState('s1'), agentTokenFileState('s2'), agentTokenFileState('s3')]).toEqual(['set', 'unset', 'invalid'])
  })

  it('an unsafe agent name does not throw: false', () => {
    expect(agentUsesOwnTokenFile('../../etc')).toBe(false)
  })
})

describe('decideReauthAction: own oauthTokenFile on the first-run gate', () => {
  it('token-file agent on the first-run gate: restartAgent fires, /login send-keys does not', () => {
    const d = decideReauthAction(base({
      usesOwnTokenFile: true,
      isFirstRunGate: true,
      prev: { consecutiveDead: 2, lastActionAtMs: null },
    }), T)
    expect(d.restartAgent).toBe(true)
    expect(d.sendKeys).toBe(false)
  })
})

describe('logsTokenFileSkip: the "token refresh needed" line', () => {
  const fired = { fireNow: true }
  it('fires for a sub-agent with its own token file when the decision fired', () => {
    expect(logsTokenFileSkip(fired, false, true, false)).toBe(true)
  })
  it('not on the first-run gate (the heal there is a restart, the cause is not the token)', () => {
    expect(logsTokenFileSkip(fired, false, true, true)).toBe(false)
  })
  it('not when the decision did not fire, for the main agent, or without a token file', () => {
    expect(logsTokenFileSkip({ fireNow: false }, false, true, false)).toBe(false)
    expect(logsTokenFileSkip(fired, true, true, false)).toBe(false)
    expect(logsTokenFileSkip(fired, false, false, false)).toBe(false)
  })
})

describe('tokenFileSignals: the flags checkSession derives from the config state', () => {
  it('unset: neither flag; set: uses the file; invalid: uses the file AND is invalid (fail-closed)', () => {
    expect(tokenFileSignals('unset')).toEqual({ usesOwnTokenFile: false, tokenFileInvalid: false })
    expect(tokenFileSignals('set')).toEqual({ usesOwnTokenFile: true, tokenFileInvalid: false })
    expect(tokenFileSignals('invalid')).toEqual({ usesOwnTokenFile: true, tokenFileInvalid: true })
  })
  it('an invalid-config agent gets no /login from the decision either', () => {
    const d = decideReauthAction(base({ ...tokenFileSignals('invalid'), prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.sendKeys).toBe(false)
    expect(d.escalate).toBe(true)
  })
})

describe('escalationTokenFileHint: on the first-run gate the alert says "restart"', () => {
  it('outside the first-run gate the signals pass through, firstRunGate false', () => {
    expect(escalationTokenFileHint({ usesOwnTokenFile: true, tokenFileInvalid: false }, false)).toEqual({ usesOwnTokenFile: true, tokenFileInvalid: false, firstRunGate: false })
    expect(escalationTokenFileHint({ usesOwnTokenFile: true, tokenFileInvalid: true }, false)).toEqual({ usesOwnTokenFile: true, tokenFileInvalid: true, firstRunGate: false })
  })
  it('on the first-run gate a token-file agent gets firstRunGate (the heal is a restart)', () => {
    expect(escalationTokenFileHint({ usesOwnTokenFile: true, tokenFileInvalid: false }, true)).toEqual({ usesOwnTokenFile: true, tokenFileInvalid: false, firstRunGate: true })
    expect(escalationTokenFileHint({ usesOwnTokenFile: true, tokenFileInvalid: true }, true)).toEqual({ usesOwnTokenFile: true, tokenFileInvalid: true, firstRunGate: true })
  })
  it('an agent without a token file never gets the token-file hints, first-run gate or not', () => {
    expect(escalationTokenFileHint({ usesOwnTokenFile: false, tokenFileInvalid: false }, true)).toEqual({ usesOwnTokenFile: false, tokenFileInvalid: false, firstRunGate: false })
  })
})

// evaluateSession: the whole per-session chain (label -> config state -> flags -> decision -> alert hint) in one function.
describe('evaluateSession: the chain for the three config states', () => {
  beforeEach(() => { fixture.root = mkdtempSync(join(tmpdir(), 'reauth-eval-test-')) })
  afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }) })
  const writeConfig = (agent: string, raw: string) => {
    mkdirSync(join(fixture.root, agent), { recursive: true })
    writeFileSync(join(fixture.root, agent, 'agent-config.json'), raw)
  }
  const input = (label: string, over: Partial<Parameters<typeof evaluateSession>[0]> = {}) => ({
    label, isMain: false, isDeadToken: true, sessionAlive: true, canInteractiveLogin: true, isFirstRunGate: false,
    prev: { consecutiveDead: 2, lastActionAtMs: null } as ReauthHealerState, nowMs: 1_000_000, ...over,
  })

  it('set: no /login, token-file hint; unset: /login; invalid: no /login, invalid hint', () => {
    writeConfig('s1', JSON.stringify({ oauthTokenFile: '/opt/tokens/s1.token' }))
    writeConfig('s2', JSON.stringify({}))
    writeConfig('s3', JSON.stringify({ oauthTokenFile: 'relative' }))
    const set = evaluateSession(input('s1'), T)
    expect(set.tokenFileState).toBe('set')
    expect(set.decision.sendKeys).toBe(false)
    expect(set.escalationHint).toEqual({ usesOwnTokenFile: true, tokenFileInvalid: false, firstRunGate: false })
    const unset = evaluateSession(input('s2'), T)
    expect(unset.tokenFileState).toBe('unset')
    expect(unset.decision.sendKeys).toBe(true)
    expect(unset.escalationHint).toEqual({ usesOwnTokenFile: false, tokenFileInvalid: false, firstRunGate: false })
    const invalid = evaluateSession(input('s3'), T)
    expect(invalid.tokenFileState).toBe('invalid')
    expect(invalid.decision.sendKeys).toBe(false)
    expect(invalid.escalationHint).toEqual({ usesOwnTokenFile: true, tokenFileInvalid: true, firstRunGate: false })
  })

  it('a dead probe on a healthy session or a gone session decides nothing, but the config state is still reported', () => {
    writeConfig('s1', JSON.stringify({ oauthTokenFile: '/opt/tokens/s1.token' }))
    const clean = evaluateSession(input('s1', { isDeadToken: false }), T)
    expect(clean.decision.escalate).toBe(false)
    expect(clean.decision.sendKeys).toBe(false)
    expect(clean.tokenFileState).toBe('set')
    const gone = evaluateSession(input('s1', { sessionAlive: false }), T)
    expect(gone.decision.escalate).toBe(false)
    expect(gone.tokenFileState).toBe('set')
  })

  it('the main agent never reads the config (isMain): unset', () => {
    writeConfig('primary', JSON.stringify({ oauthTokenFile: '/opt/tokens/m.token' }))
    expect(evaluateSession(input('primary', { isMain: true }), T).tokenFileState).toBe('unset')
  })

  it('the first-run gate on a token-file agent: restartAgent, no /login, hint carries firstRunGate', () => {
    writeConfig('s1', JSON.stringify({ oauthTokenFile: '/opt/tokens/s1.token' }))
    const e = evaluateSession(input('s1', { isFirstRunGate: true }), T)
    expect(e.decision.restartAgent).toBe(true)
    expect(e.decision.sendKeys).toBe(false)
    expect(e.escalationHint.firstRunGate).toBe(true)
  })
})

// checkSession itself, with its collaborators mocked at the top of the file: a wrong label or a dropped call is RED here.
describe('checkSession: the call site', () => {
  beforeEach(() => {
    fixture.root = mkdtempSync(join(tmpdir(), 'reauth-check-test-'))
    fixture.execCalls.length = 0
    fixture.pane = 'pane'
    fixture.reauth = { needsReauth: true, reason: 'API Error: 401' }
    vi.stubEnv('DISPLAY', ':99') // hostCanInteractiveLogin() on a non-macOS CI host
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(fixture.root, { recursive: true, force: true }) })
  const writeConfig = (agent: string, raw: string) => {
    mkdirSync(join(fixture.root, agent), { recursive: true })
    writeFileSync(join(fixture.root, agent, 'agent-config.json'), raw)
  }
  // 3 dead probes = the threshold; the session name differs from the label, so a lookup by session would miss the config
  const sweep = async (label: string) => {
    for (let i = 0; i < 3; i++) checkSession(label, `agent-${label}-session`, false, false)
    await vi.advanceTimersByTimeAsync(5000)
  }
  const sentKeys = () => fixture.execCalls.filter((c) => c[0] !== '/bin/bash' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'send-keys')
  const notifications = () => fixture.execCalls.filter((c) => c[0] === '/bin/bash').map((c) => (c[1] as string[])[1]!)

  it('a token-file agent: no /login keys, the alert asks for the token-file refresh', async () => {
    writeConfig('alpha', JSON.stringify({ oauthTokenFile: '/opt/tokens/alpha.token' }))
    await sweep('alpha')
    expect(sentKeys()).toHaveLength(0)
    expect(notifications()).toHaveLength(1)
    expect(notifications()[0]).toContain('Frissítsd a token-fájlt')
  })

  it('an agent without the setting: the unchanged /login keys and the manual-login alert', async () => {
    writeConfig('beta', JSON.stringify({ model: 'x' }))
    await sweep('beta')
    expect(sentKeys().length).toBeGreaterThan(0)
    expect(notifications()[0]).toContain('Manuális browser /login')
  })

  it('an invalid oauthTokenFile setting: no /login keys, the alert says the setting is broken', async () => {
    writeConfig('gamma', JSON.stringify({ oauthTokenFile: 'relative/path' }))
    await sweep('gamma')
    expect(sentKeys()).toHaveLength(0)
    expect(notifications()[0]).toContain('hibás vagy nem olvasható')
  })

  it('the first-run gate on a token-file agent: the alert recommends a restart, never a manual /login', async () => {
    fixture.reauth = { needsReauth: true, reason: 'onboarding picker' }
    writeConfig('delta', JSON.stringify({ oauthTokenFile: '/opt/tokens/delta.token' }))
    await sweep('delta')
    expect(sentKeys()).toHaveLength(0)
    expect(notifications()[0]).toContain('újraindítom az ügynököt; ha ezután is itt akad el, indítsd újra kézzel')
    expect(notifications()[0]).not.toContain('Manuális browser /login')
    expect(notifications()[0]).not.toContain('Frissítsd a token-fájlt')
  })

  it('the first-run gate on an invalid-config agent: restart AND fix the setting, still no manual /login', async () => {
    fixture.reauth = { needsReauth: true, reason: 'sign-in screen' }
    writeConfig('epsilon', JSON.stringify({ oauthTokenFile: 42 }))
    await sweep('epsilon')
    expect(sentKeys()).toHaveLength(0)
    expect(notifications()[0]).toContain('újraindítom az ügynököt; ha ezután is itt akad el, indítsd újra kézzel')
    expect(notifications()[0]).toContain('oauthTokenFile beállítása')
    expect(notifications()[0]).not.toContain('Manuális browser /login')
  })

  it('the first-run gate on an agent WITHOUT the setting keeps the old text', async () => {
    fixture.reauth = { needsReauth: true, reason: 'onboarding picker' }
    writeConfig('zeta', JSON.stringify({}))
    await sweep('zeta')
    expect(notifications()[0]).toContain('Manuális browser /login')
  })
})
