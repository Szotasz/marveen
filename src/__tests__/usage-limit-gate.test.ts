import { describe, expect, it } from 'vitest'
import { decideUsageLimitGate, USAGE_LIMIT_PROBE_INTERVAL_MS, type UsageLimitEpisode } from '../usage-limit-gate.js'
import { usageLimitBannerLine } from '../model-fallback.js'

// The pure half of the scheduler's pre-injection usage-limit
// gate. The wiring into attemptFireTask is covered in
// schedule-runner-usage-limit-gate.test.ts.

// Verbatim, as measured on the live install (2609 of the 2798 replies).
const BANNER = "You're out of extra usage · resets 6am (Europe/Budapest)"

function pane(bannerLine: string | null): string {
  return [
    '> SCHEDULED TASK NOTICE -- the next <scheduled-task source="scheduled-task:morning-digest">',
    ...(bannerLine ? [`  ⎿  ${bannerLine}`] : ['● Done, digest sent.']),
    '',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')
}

const T0 = Date.parse('2026-09-20T02:19:04Z')

describe('usageLimitBannerLine', () => {
  it('returns the banner text without the pane glyphs', () => {
    expect(usageLimitBannerLine(pane(BANNER))).toBe(BANNER)
  })

  it('returns null for a clean pane', () => {
    expect(usageLimitBannerLine(pane(null))).toBeNull()
  })

  it('prefers the newest (lowest) banner in the live region', () => {
    const p = [`  ⎿  ${BANNER}`, "  ⎿  You're out of extra usage · resets Sep 21, 6am (Europe/Budapest)", '❯ '].join('\n')
    expect(usageLimitBannerLine(p)).toBe("You're out of extra usage · resets Sep 21, 6am (Europe/Budapest)")
  })
})

describe('decideUsageLimitGate', () => {
  it('injects into a clean pane and forgets any episode', () => {
    const old: UsageLimitEpisode = { banner: BANNER, firstSeenAtMs: T0, skipUntilMs: T0 + 1, notified: true }
    const d = decideUsageLimitGate({ pane: pane(null), nowMs: T0, episode: old })
    expect(d.action).toBe('inject')
    expect(d.reason).toBe('no-banner')
    expect(d.episode).toBeNull()
  })

  it('fails open when the capture failed, keeping the episode as it was', () => {
    const old: UsageLimitEpisode = { banner: BANNER, firstSeenAtMs: T0, skipUntilMs: T0 + 60_000, notified: true }
    const d = decideUsageLimitGate({ pane: null, nowMs: T0, episode: old })
    expect(d.action).toBe('inject')
    expect(d.reason).toBe('no-pane')
    expect(d.episode).toBe(old)
  })

  it('skips on the real banner, and notifies on the first sighting only', () => {
    const first = decideUsageLimitGate({ pane: pane(BANNER), nowMs: T0, episode: null })
    expect(first.action).toBe('skip')
    if (first.action !== 'skip') throw new Error('unreachable')
    expect(first.reason).toBe('usage-limit-screen')
    expect(first.banner).toBe(BANNER)
    expect(first.notify).toBe(true)

    const second = decideUsageLimitGate({ pane: pane(BANNER), nowMs: T0 + 60_000, episode: first.episode })
    expect(second.action).toBe('skip')
    if (second.action !== 'skip') throw new Error('unreachable')
    expect(second.notify).toBe(false)
  })

  it('lets exactly one probe through per window, so a stale banner cannot starve the session', () => {
    const first = decideUsageLimitGate({ pane: pane(BANNER), nowMs: T0, episode: null })
    const due = T0 + USAGE_LIMIT_PROBE_INTERVAL_MS
    const probe = decideUsageLimitGate({ pane: pane(BANNER), nowMs: due, episode: first.episode })
    expect(probe.action).toBe('inject')
    expect(probe.reason).toBe('probe')
    // A second task in the same tick, same pane: held back again.
    const sameTick = decideUsageLimitGate({ pane: pane(BANNER), nowMs: due, episode: probe.episode })
    expect(sameTick.action).toBe('skip')
    if (sameTick.action !== 'skip') throw new Error('unreachable')
    expect(sameTick.notify).toBe(false)
  })

  it('opens a new episode (and a new notice) when the wording changes', () => {
    const first = decideUsageLimitGate({ pane: pane(BANNER), nowMs: T0, episode: null })
    const next = decideUsageLimitGate({
      pane: pane("You're out of extra usage · resets Sep 21, 6am (Europe/Budapest)"),
      nowMs: T0 + 60_000,
      episode: first.episode,
    })
    expect(next.action).toBe('skip')
    if (next.action !== 'skip') throw new Error('unreachable')
    expect(next.notify).toBe(true)
  })

  it('does not hold work back on an "approaching" warning -- budget is still left', () => {
    const d = decideUsageLimitGate({ pane: pane('Approaching Opus weekly limit ∙ 5% left'), nowMs: T0, episode: null })
    expect(d.action).toBe('inject')
    expect(d.reason).toBe('warning-only')
  })

  it('does not trip on a reply that merely discusses the banner', () => {
    const d = decideUsageLimitGate({
      pane: pane(null).replace('● Done, digest sent.', '● The heartbeat got "You\'re out of extra usage" 2800 times.'),
      nowMs: T0,
      episode: null,
    })
    expect(d.action).toBe('inject')
  })
})
