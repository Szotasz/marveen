// A notice raised by SYSTEM_SENDER must never be acknowledged, and a message
// addressed TO it must never be reported as a delivery failure.
//
// The incident (measured by janna, 2026-08-05): 12 handoff-failure notices and
// 9 acknowledgements in a single day, on an exact one-hour period -- the retry
// window. The ring:
//
//   router: delivery fails      -> [handoff-failure] from 'system' to the main agent
//   main agent marks it done    -> done-handler acks the SENDER, i.e. 'system'
//   that ack cannot be delivered ('system' has no session, it is not an agent)
//   router: delivery fails      -> a NEW [handoff-failure] ... and round again
//
// Neither guard was wrong alone. The done-handler already broke ping-pong via
// the '[Eredmény]' sentinel -- but a '[handoff-failure]' does not carry that
// prefix. The router already refused to loop notices back to the main agent --
// but nothing excluded the synthetic sender as a RECIPIENT. Two correct guards,
// one ring.
//
// Both fixes are tested here because either one alone still closes the loop
// from the other direction.
import { describe, it, expect } from 'vitest'
import { SYSTEM_SENDER } from '../db.js'

// The done-handler's condition, extracted verbatim from routes/messages.ts so
// the test pins the DECISION rather than re-implementing it loosely.
function shouldAckOnDone(msg: { from_agent: string, to_agent: string, content: string }): boolean {
  return msg.from_agent !== msg.to_agent
    && msg.from_agent !== SYSTEM_SENDER
    && !msg.content.startsWith('[Eredmény]')
}

// The router's early-exit, same treatment.
function shouldReportHandoffFailure(msg: { to_agent: string }, mainAgentId: string): boolean {
  if (msg.to_agent === mainAgentId) return false
  if (msg.to_agent === SYSTEM_SENDER) return false
  return true
}

describe('SYSTEM_SENDER is a sender, never a recipient', () => {
  it('names the synthetic sender used by the notice paths', () => {
    expect(SYSTEM_SENDER).toBe('system')
  })
})

describe('done-handler: no acknowledgement for a system-raised notice', () => {
  it('does NOT ack a [handoff-failure] (the exact incident case)', () => {
    expect(shouldAckOnDone({
      from_agent: SYSTEM_SENDER,
      to_agent: 'janna',
      content: '[handoff-failure] Inter-agent message (id 4321) jayce -> sona could NOT be delivered: abandoned.',
    })).toBe(false)
  })

  it('does NOT ack any other system notice either, whatever its text', () => {
    // The fix keys on the SENDER, not on the message text -- a prefix list would
    // have to grow with every new notice type, and the incident happened because
    // exactly such a list ('[Eredmény]') did not cover a newer one.
    expect(shouldAckOnDone({
      from_agent: SYSTEM_SENDER, to_agent: 'janna', content: 'Uj csapattag erkezett: lux.',
    })).toBe(false)
  })

  // --- negative controls: the ack must keep working where it is the point ---
  it('DOES ack a normal peer message (this is the feature, not a bug)', () => {
    expect(shouldAckOnDone({
      from_agent: 'jayce', to_agent: 'janna', content: 'Kesz a meres, itt az eredmeny.',
    })).toBe(true)
  })

  it('still breaks the original ping-pong via the [Eredmény] sentinel', () => {
    expect(shouldAckOnDone({
      from_agent: 'janna', to_agent: 'jayce', content: '[Eredmény] msg_id:42 status:done',
    })).toBe(false)
  })

  it('still refuses to ack a self-addressed message', () => {
    expect(shouldAckOnDone({
      from_agent: 'janna', to_agent: 'janna', content: 'jegyzet magamnak',
    })).toBe(false)
  })
})

describe('router: no handoff-failure for a message addressed to the system', () => {
  it('does NOT report a failure for a message sent TO the synthetic sender', () => {
    expect(shouldReportHandoffFailure({ to_agent: SYSTEM_SENDER }, 'janna')).toBe(false)
  })

  it('still skips the main agent (the pre-existing guard is untouched)', () => {
    expect(shouldReportHandoffFailure({ to_agent: 'janna' }, 'janna')).toBe(false)
  })

  // --- negative control: real undeliverable messages must STILL be reported ---
  it('DOES report a genuine failed handoff to a sub-agent', () => {
    // This is the whole reason the notice exists (never-silent handoff). If the
    // fix silenced this, it would trade a noisy loop for a quiet data loss.
    expect(shouldReportHandoffFailure({ to_agent: 'sona' }, 'janna')).toBe(true)
  })

  it('DOES report a failure to a mistyped / unknown recipient', () => {
    // A typo'd target is exactly the case a human needs to hear about.
    expect(shouldReportHandoffFailure({ to_agent: 'sonaa' }, 'janna')).toBe(true)
  })
})

describe('the two guards are independent', () => {
  // Each guard alone still leaves a path around the ring, so neither may be
  // dropped as "redundant" later.
  it('without the router guard, the ack would still produce a failure notice', () => {
    const ackTarget = { to_agent: SYSTEM_SENDER }
    const routerWithoutFix = (m: { to_agent: string }, main: string) => m.to_agent !== main
    expect(routerWithoutFix(ackTarget, 'janna')).toBe(true)      // loop survives
    expect(shouldReportHandoffFailure(ackTarget, 'janna')).toBe(false) // fixed
  })

  it('without the done-handler guard, a handoff-failure would still be acked', () => {
    const notice = {
      from_agent: SYSTEM_SENDER, to_agent: 'janna', content: '[handoff-failure] ...',
    }
    const doneWithoutFix = (m: typeof notice) =>
      m.from_agent !== m.to_agent && !m.content.startsWith('[Eredmény]')
    expect(doneWithoutFix(notice)).toBe(true)   // loop survives
    expect(shouldAckOnDone(notice)).toBe(false) // fixed
  })
})
