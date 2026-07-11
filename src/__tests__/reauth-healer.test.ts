import { describe, it, expect } from 'vitest'
import { decideReauthAction, NO_REAUTH_STATE, type ReauthHealerState } from '../web/reauth-healer.js'

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
