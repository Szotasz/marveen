import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  noteSaturationBannerUntrusted,
  clearSaturationBannerOverride,
  saturationBannerTrusted,
  saturationRefusesDispatch,
} from '../web/agent-process.js'

// Banner-vs-measurement mismatch (measured 2026-09-15, isapp06).
//
// The pane footer's "100% context used" is a CLAIM the CLI computes with its
// OWN denominator; the guard's pct is a MEASUREMENT from the transcript with
// contextLimitForModel's denominator. A model id that reaches the CLI without
// the `[1m]` marker makes the CLI size the status line to 200k and print the
// banner at ~179k, while the session keeps working to ~1M (998 856 tokens
// observed). Believing the claim there executes a WORKING agent mid-turn:
// 318 numeric "pane saturated" hard restarts over nine days on four agents,
// measured context 18-43%, never once above 90%; 0 request-handoff on three of
// them (the proactive path at 0.9 * 1M was unreachable); and 10 462 "dispatch:
// refusing prompt" events on the same four sessions.
//
// The fix has THREE consumers of one verdict -- the guard's saturation net, the
// dispatch gate in agent-process.ts and the forceSend deferral in
// schedule-runner.ts -- and they MUST ship together.
//
// The mechanism, stated precisely because it is easy to get wrong: the guard's
// own prompts do NOT pass through the gate. It sends via sendSystemDirective ->
// sendPromptToSession, and neither calls isSessionReadyForPrompt (system-
// directive.ts does not even import it). The gate only stops the EXTERNAL
// injectors -- schedule-runner, message-router, telegram-inbox-wake,
// inbox-nudge-watcher and agent-worker. So standing the net down without
// opening the gate does not mute the guard; it mutes the agent's scheduled
// tasks and its inter-agent mail, indefinitely, while nothing restarts the pane
// any more. That is worse than the wrong restart it replaces. There is no
// runtime test that can observe "these three moved together", so the wiring is
// pinned at source level, the idiom this repo already uses for exactly this
// class of invariant (ghost-suggestion-strip.test.ts).

const RUNNER_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../web/context-guard-runner.ts'),
  'utf-8',
)

/** The checkAgent body only -- measurePct/measureIdleMs also appear in the
 *  helpers above it and in getContextGuardStatus below it. */
function checkAgentBody(): string {
  const start = RUNNER_SRC.indexOf('async function checkAgent(')
  const end = RUNNER_SRC.indexOf('export function getContextGuardStatus(')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return RUNNER_SRC.slice(start, end)
}

describe('context-guard runner: the banner is reconciled with the measurement', () => {
  it('asks saturationBannerCredible for the verdict', () => {
    expect(checkAgentBody()).toContain('saturationBannerCredible(')
  })

  it('tells the dispatch gate when the banner is not credible', () => {
    // Without this the net stands down and the gate keeps refusing: the agent
    // survives, but its scheduled tasks and inter-agent mail are dropped by the
    // gate for as long as the banner is up -- and nothing restarts it any more.
    expect(checkAgentBody()).toContain('noteSaturationBannerUntrusted(')
  })

  it('revokes the override only on a sweep that actually LOOKED at the pane', () => {
    // The else-arm is the other half of the same invariant: the override must
    // never outlive the condition that created it. But it must not be revoked
    // on a sweep where we never captured (the await-ready and cooldown phases
    // leave pane === null, which also makes paneSaturatedRaw false) -- "we did
    // not look" is not evidence that the banner is gone. The TTL still expires
    // the entry fail-closed.
    const body = checkAgentBody()
    expect(body).toContain('clearSaturationBannerOverride(')
    expect(body).toMatch(/} else if \(pane !== null\) \{[\s\S]{0,400}clearSaturationBannerOverride\(session\)/)
  })

  it('never overrides an ERROR-shaped banner', () => {
    // A percentage claim depends on the CLI's denominator and can be wrong; an
    // error banner is painted only after a turn actually failed at the real
    // limit. Overruling one of those would stand the net down on a genuinely
    // wedged pane AND open the gate to it: silent message loss.
    expect(checkAgentBody()).toContain('paneShowsContextSaturationHardError(pane)')
  })

  it('pays for the transcript probe only where a decision uses it', () => {
    // measurePct is not side-effect free: it persists a per-agent high-water
    // mark to store/context-guard-highwater.json. Before this change it ran
    // only for cfg.enabled agents; it must not start writing for agents whose
    // decision never reads it, so the credibility probe is gated on an actually
    // present, actually overridable banner.
    const body = checkAgentBody()
    expect(body).toMatch(/const needCredibilityProbe = paneSaturatedRaw && !bannerIsHardError/)
    expect(body).toMatch(/running && needPct && \(cfg\.enabled \|\| needCredibilityProbe\)/)
  })

  it('warns on the state CHANGE, not on every sweep', () => {
    // The mismatch condition holds on every sweep while a mis-tagged agent
    // keeps running (~1150 lines a day). Same idiom as remoteSkipLogged.
    expect(checkAgentBody()).toMatch(/if \(!bannerMismatchLogged\.has\(name\)\)/)
  })

  it('feeds decideGuard the CORRECTED flag, not the raw pane scan', () => {
    // decideGuard's contract stays "paneSaturated means the pane really is
    // saturated"; the reconciliation happens before it, so the decision
    // function itself needs no change.
    const body = checkAgentBody()
    expect(body).toMatch(/paneSaturated: paneSaturatedTrusted,/)
    expect(body).not.toMatch(/paneSaturated: pane !== null \? paneShowsContextSaturation\(pane\)/)
  })

  it('reads the transcript once per sweep (no duplicated probe)', () => {
    // The credibility check needs the same numbers the tiers need. Measuring
    // twice would double the per-sweep transcript read for every agent.
    const body = checkAgentBody()
    expect(body.match(/measurePct\(/g) ?? []).toHaveLength(1)
    expect(body.match(/measureIdleMs\(/g) ?? []).toHaveLength(1)
  })
})

describe('dispatch-gate override: in-process, TTL-bounded, fail-closed', () => {
  afterEach(() => {
    vi.useRealTimers()
    clearSaturationBannerOverride('agent-x')
  })

  it('defaults to trusting the banner for an unknown session', () => {
    // Fresh dashboard, worker sessions, guard disabled: the map is empty and
    // the gate behaves exactly as it does today.
    expect(saturationBannerTrusted('never-seen-session')).toBe(true)
  })

  it('distrusts the banner while the entry is live', () => {
    noteSaturationBannerUntrusted('agent-x', Date.now() + 60_000)
    expect(saturationBannerTrusted('agent-x')).toBe(false)
  })

  it('expires back to REFUSING when the runner stops refreshing it', () => {
    // The fail-closed property: if the guard dies (webOnly mode, crash,
    // disabled) the override must lapse on its own rather than leave the gate
    // permanently open to a session that really did fill up.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_000_000_000_000))
    noteSaturationBannerUntrusted('agent-x', Date.now() + 60_000)
    expect(saturationBannerTrusted('agent-x')).toBe(false)

    vi.setSystemTime(new Date(1_000_000_061_000))
    expect(saturationBannerTrusted('agent-x')).toBe(true)

    // The lapsed entry is REMOVED, not merely compared: rewinding the clock
    // must not resurrect it (and the map must not grow one entry per session
    // forever).
    vi.setSystemTime(new Date(1_000_000_000_000))
    expect(saturationBannerTrusted('agent-x')).toBe(true)
  })

  it('is revoked immediately by clearSaturationBannerOverride', () => {
    noteSaturationBannerUntrusted('agent-x', Date.now() + 3_600_000)
    expect(saturationBannerTrusted('agent-x')).toBe(false)
    clearSaturationBannerOverride('agent-x')
    expect(saturationBannerTrusted('agent-x')).toBe(true)
  })

  it('is per-session: one agent\'s override does not silence another', () => {
    noteSaturationBannerUntrusted('agent-x', Date.now() + 60_000)
    expect(saturationBannerTrusted('agent-y')).toBe(true)
  })
})

// The override is keyed by SESSION, so on its own it cannot know WHICH banner is
// on screen -- and the two classes must not be treated alike. These cases pin
// the ordering inside saturationRefusesDispatch: the hard-error arm is answered
// on the CAPTURE, ahead of the session-keyed override, so an entry written
// while a percentage banner was up can never be inherited by a later, genuine
// wedge of the same session.
describe('saturationRefusesDispatch: the hard-error arm outranks the override', () => {
  const footer = (banner: string) => [
    '  some prior assistant output',
    '',
    banner,
    '─'.repeat(40),
    '\u276f ',
    '─'.repeat(40),
    '  \u23f5\u23f5 bypass permissions on (shift+tab to cycle)',
  ].join('\n')

  const PCT_BANNER = footer('                              100% context used')
  const HARD_BANNER = footer('Context limit reached \u00b7 use /compact or /clear to continue')
  const CLEAN = footer('  all good here')

  afterEach(() => {
    clearSaturationBannerOverride('agent-z')
  })

  it('lets an unsaturated pane through, override or not', () => {
    expect(saturationRefusesDispatch(CLEAN, 'agent-z')).toBe(false)
    noteSaturationBannerUntrusted('agent-z', Date.now() + 60_000)
    expect(saturationRefusesDispatch(CLEAN, 'agent-z')).toBe(false)
  })

  it('refuses on either banner when no override is live (today\u2019s behaviour)', () => {
    expect(saturationRefusesDispatch(PCT_BANNER, 'agent-z')).toBe(true)
    expect(saturationRefusesDispatch(HARD_BANNER, 'agent-z')).toBe(true)
  })

  it('a live override opens the gate for a PERCENTAGE claim -- the point of the fix', () => {
    noteSaturationBannerUntrusted('agent-z', Date.now() + 60_000)
    expect(saturationRefusesDispatch(PCT_BANNER, 'agent-z')).toBe(false)
  })

  it('the SAME live override does NOT open the gate for a hard-error banner', () => {
    // The reachable sequence: the mis-tagged agent's percentage banner is found
    // not credible (entry written), and the agent LATER wedges for real. The
    // runner's next sweep revokes the entry, but between the two we would
    // otherwise inject into a pane that cannot act -- one sweep at best, the
    // whole TTL if a sweep is missed. The capture answers this, not the map.
    noteSaturationBannerUntrusted('agent-z', Date.now() + 60_000)
    expect(saturationBannerTrusted('agent-z')).toBe(false)
    expect(saturationRefusesDispatch(HARD_BANNER, 'agent-z')).toBe(true)
  })

  it('no regression for the mis-tagged case: a percentage pane keeps its override after a hard-error probe', () => {
    // The hard-error arm must not consume or clear the entry -- it is answered
    // from the capture alone, so the percentage verdict is unchanged.
    noteSaturationBannerUntrusted('agent-z', Date.now() + 60_000)
    expect(saturationRefusesDispatch(HARD_BANNER, 'agent-z')).toBe(true)
    expect(saturationRefusesDispatch(PCT_BANNER, 'agent-z')).toBe(false)
  })

  it('falls back to refusing the percentage claim once the entry lapses', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_000_000_000_000))
    noteSaturationBannerUntrusted('agent-z', Date.now() + 60_000)
    expect(saturationRefusesDispatch(PCT_BANNER, 'agent-z')).toBe(false)
    vi.setSystemTime(new Date(1_000_000_061_000))
    expect(saturationRefusesDispatch(PCT_BANNER, 'agent-z')).toBe(true)
    vi.useRealTimers()
  })
})
