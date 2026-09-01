import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideReauthAction, NO_REAUTH_STATE, type ReauthHealerState } from '../web/reauth-healer.js'

const T = { threshold: 3, cooldownMs: 30 * 60 * 1000, recentTaskLivenessWindowMs: 20 * 60 * 1000 }
const base = (over: Partial<Parameters<typeof decideReauthAction>[0]> = {}) => ({
  isDeadToken: true,
  sessionAlive: true,
  isMain: false,
  canInteractiveLogin: true,
  msSinceLastCompletedTask: null,
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

// 2026-08-24 false-restart incident: 4 main-agent restarts in one day, all
// exactly ESCALATION_COOLDOWN_MS apart, all reason "Not logged in", while
// scheduled tasks demonstrably completed successfully minutes before each
// one -- proof the session was never actually dead. Fix: a session that just finished a
// scheduled task's LLM turn cannot simultaneously have a dead OAuth token,
// so recent completion evidence overrides a marker-based dead reading for
// the main agent, exactly like a clean probe.
describe('decideReauthAction: recent-task sanity check (main agent only)', () => {
  it('recent task completion (5min ago) overrides a dead reading -- ends the spell', () => {
    const d = decideReauthAction(base({
      isMain: true,
      msSinceLastCompletedTask: 5 * 60 * 1000,
      prev: { consecutiveDead: 5, lastActionAtMs: null },
    }), T)
    expect(d.restartMain).toBe(false)
    expect(d.escalate).toBe(false)
    expect(d.next).toEqual(NO_REAUTH_STATE)
  })

  it('stale task completion (25min ago, outside the window) does not override -- normal logic applies', () => {
    const d = decideReauthAction(base({
      isMain: true,
      msSinceLastCompletedTask: 25 * 60 * 1000,
      prev: { consecutiveDead: 2, lastActionAtMs: null },
      nowMs: 2_000_000,
    }), T)
    expect(d.restartMain).toBe(true)
    expect(d.escalate).toBe(true)
  })

  it('does NOT apply to sub-agents, even with recent completion evidence', () => {
    const d = decideReauthAction(base({
      isMain: false,
      msSinceLastCompletedTask: 5 * 60 * 1000,
      prev: { consecutiveDead: 2, lastActionAtMs: null },
    }), T)
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(true)
  })

  it('null completion evidence (never observed) does not override -- normal logic applies', () => {
    const d = decideReauthAction(base({
      isMain: true,
      msSinceLastCompletedTask: null,
      prev: { consecutiveDead: 2, lastActionAtMs: null },
      nowMs: 2_000_000,
    }), T)
    expect(d.restartMain).toBe(true)
    expect(d.escalate).toBe(true)
  })
})

// 2026-08-29: the escalation delivery mechanism itself was silently failing
// (notify.sh via execFile -- the main agent's own dead OAuth token was
// correctly detected on every probe, but every escalation attempt to notify
// the owner failed with an unexplained exit code 1, and it only surfaced
// once the owner tried to message the agent and got no reply). Fixed by
// switching to the same channel-provider abstraction schedule-runner.ts's
// own alerts already use successfully. This is a source-scan guard, not a
// runtime one, because sendNotify() is a private fire-and-forget function
// with no return value to assert on -- if this reverted back to shelling
// out through notify.sh, the test below would turn red.
describe('fix-revert guard: reauth-healer escalation no longer shells out to notify.sh', () => {
  it('sendNotify uses the channel-provider abstraction, not execFile(.../notify.sh)', () => {
    const src = readFileSync(join(__dirname, '../web/reauth-healer.ts'), 'utf-8')
    expect(src).toMatch(/sendSchedulerAlertMessage\(token, ownerChat, msg\)/)
    // NOTIFY_SCRIPT (the const that pointed sendNotify at scripts/notify.sh)
    // is gone entirely; the string "notify.sh" itself may still appear in
    // prose comments explaining the history, so it is not asserted on here.
    expect(src).not.toMatch(/NOTIFY_SCRIPT/)
  })
})
