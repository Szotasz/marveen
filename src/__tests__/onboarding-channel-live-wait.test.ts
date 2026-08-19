import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// WIZFLOW809. After saving the bot token the wizard used to advance on a fixed
// setTimeout (4s), while the restart response is only a dispatch receipt and
// the cold start takes ~minutes -- the pairing step opened against a booting
// session and looked done-and-empty (three identical field reports on 0.3.15).
//
// The acceptance criterion (coordinator, msg 10154): the test must FORCE the
// slow path -- a delayed ready signal -- and assert the wizard WAITS. A
// "works on my machine" run proves nothing for a timing bug, because on a fast
// machine 4 seconds can be enough by luck.
//
// The wizard step itself is not unit-mountable (repo convention: structural
// assertions over web/app.js). The wait logic is therefore a NAMED, anchored,
// dependency-injected function, extracted here BY ITS ANCHORS and run for
// real: the slow path is exercised at runtime, not just pinned textually.

const APP = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')

const BEGIN = '// WIZFLOW809 BEGIN waitForChannelLive'
const END = '// WIZFLOW809 END waitForChannelLive'

function extractWaitForChannelLive(): (
  fetchStatus: () => Promise<unknown>,
  delayMs: number,
  maxTries: number,
) => Promise<'live' | 'timeout'> {
  const b = APP.indexOf(BEGIN)
  const e = APP.indexOf(END)
  // Loud failure on a missing anchor: a silent miss would turn every runtime
  // assertion below into a test of nothing (this repo's own instrument lesson).
  expect(b, `anchor missing: ${BEGIN}`).toBeGreaterThan(-1)
  expect(e, `anchor missing: ${END}`).toBeGreaterThan(b)
  const src = APP.slice(b + BEGIN.length, e)
  expect(src).toContain('async function waitForChannelLive')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${src}; return waitForChannelLive;`)() as ReturnType<typeof extractWaitForChannelLive>
}

describe('waitForChannelLive -- runtime semantics with a forced-slow ready signal', () => {
  it('WAITS through a delayed signal: false x5 then true -> live, polled 6 times', async () => {
    const waitForChannelLive = extractWaitForChannelLive()
    let calls = 0
    const fetchStatus = async () => ({ channelLive: ++calls > 5 })
    const outcome = await waitForChannelLive(fetchStatus, 1, 40)
    expect(outcome).toBe('live')
    expect(calls).toBe(6) // kept polling exactly until the signal, no early advance
  })

  it('timeout is NOT success: signal never comes -> "timeout" after exactly maxTries polls', async () => {
    const waitForChannelLive = extractWaitForChannelLive()
    let calls = 0
    const fetchStatus = async () => { calls++; return { channelLive: false } }
    const outcome = await waitForChannelLive(fetchStatus, 1, 4)
    expect(outcome).toBe('timeout')
    expect(calls).toBe(4)
  })

  it('already-live channel advances on the FIRST poll (checks before sleeping)', async () => {
    const waitForChannelLive = extractWaitForChannelLive()
    let calls = 0
    const started = Date.now()
    const fetchStatus = async () => { calls++; return { channelLive: true } }
    const outcome = await waitForChannelLive(fetchStatus, 5000, 40)
    expect(outcome).toBe('live')
    expect(calls).toBe(1)
    expect(Date.now() - started).toBeLessThan(1000) // no 5s sleep was paid
  })

  it('a null status (fetch error) keeps waiting instead of crashing or advancing', async () => {
    const waitForChannelLive = extractWaitForChannelLive()
    let calls = 0
    const fetchStatus = async () => (++calls < 3 ? null : { channelLive: true })
    const outcome = await waitForChannelLive(fetchStatus, 1, 40)
    expect(outcome).toBe('live')
    expect(calls).toBe(3)
  })
})

describe('structural pins -- the fixed-wait shape must not return', () => {
  it('the banned shape setTimeout(refreshOnboarding is gone from the STEP-3 handler', () => {
    // This exact shape WAS the bug at this call site: advance to the pairing
    // step on a timer instead of the measured signal. Scoped to step 3 on
    // purpose: the identity/auth/approve steps also refresh on timers, but
    // there the refresh only re-reads status (the next screen does not
    // require a live channel), a different and lower harm profile -- fixing
    // those is a separate scope decision, named in the PR, not smuggled in.
    const s3 = APP.indexOf("} else if (step === 3)")
    const s4 = APP.indexOf("} else if (step === 4)")
    expect(s3, 'step-3 block anchor missing').toBeGreaterThan(-1)
    expect(s4, 'step-4 block anchor missing').toBeGreaterThan(s3)
    expect(APP.slice(s3, s4)).not.toContain('setTimeout(refreshOnboarding')
  })

  it('step-3 handler waits on the measured signal and its timeout branch does not advance', () => {
    const sliceStart = APP.indexOf("t('onboarding.step2.waiting_channel')")
    const sliceEnd = APP.indexOf("} else if (step === 4)")
    expect(sliceStart, 'step-3 waiting_channel anchor missing').toBeGreaterThan(-1)
    expect(sliceEnd, 'step-4 boundary anchor missing').toBeGreaterThan(sliceStart)
    const step3Tail = APP.slice(sliceStart, sliceEnd)
    expect(step3Tail).toContain('waitForChannelLive(fetchOnboardingStatus')
    // The live branch is the ONLY advance; the timeout branch re-enables the
    // button and says the channel is still starting.
    expect(step3Tail).toMatch(/if \(outcome === 'live'\) \{ await refreshOnboarding\(\) \}/)
    expect(step3Tail).toMatch(/else \{ botBtn\.disabled = false; onbMsg\(t\('onboarding\.step2\.channel_slow'\), true\) \}/)
    const advances = step3Tail.match(/refreshOnboarding/g) ?? []
    expect(advances.length).toBe(1)
  })

  it('the backend status route computes channelLive from the shared liveness probe', () => {
    const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'onboarding.ts'), 'utf-8')
    expect(route).toContain("import { getClaudePidForSession, hasChannelPluginAlive } from '../../channel-coordinator/liveness.js'")
    expect(route).toMatch(/channelLive = claudePid != null && hasChannelPluginAlive\(claudePid, CHANNEL_PROVIDER\)/)
    expect(route).toMatch(/^\s*channelLive,$/m) // and it is actually in the response
  })

  it('both languages carry the waiting and slow keys', () => {
    for (const lang of ['hu', 'en']) {
      const src = readFileSync(join(__dirname, '..', '..', 'web', 'lang', `${lang}.js`), 'utf-8')
      expect(src).toContain("'onboarding.step2.waiting_channel'")
      expect(src).toContain("'onboarding.step2.channel_slow'")
    }
  })
})
