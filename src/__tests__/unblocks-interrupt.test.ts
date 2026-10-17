import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  UNBLOCKS,
  UNBLOCK_NOTICE_MAX_CHARS,
  validateAffectsCurrentWork,
  shouldInterruptForUnblock,
  buildUnblockInterruptContent,
} from '../web/unblocks-interrupt.js'
import { initDatabase, createAgentMessage, getAgentMessage } from '../db.js'

beforeAll(() => { initDatabase(':memory:') })

const MAIN = 'webby'

// Card #673. The measured problem: on the webby->cody edge the delivery delay
// is median 95 s / p95 1765 s (n=1805), while every other edge sits at a p95
// between 62 s and 229 s. A message that RELEASES a blocker spends that whole
// window waiting for a pane that is busy doing something else -- and the
// recipient, by definition of "blocked", is not doing the work that the delay
// is protecting.
describe('affects_current_work: who may set it, and to what', () => {
  it('accepts the one built value from the main agent', () => {
    expect(validateAffectsCurrentWork('unblocks', MAIN, MAIN)).toEqual({ ok: true, value: UNBLOCKS })
  })

  it('accepts absence as absence -- every existing caller keeps working', () => {
    for (const raw of [undefined, null, '', '   ']) {
      expect(validateAffectsCurrentWork(raw, 'cody', MAIN)).toEqual({ ok: true, value: null })
    }
  })

  // The two cases that were deliberately NOT built. Rejecting them by name is
  // what keeps the scope honest: `danger` had no real example in either
  // measured sample, and a case without an example is a guess.
  it('rejects the unbuilt values instead of storing them as decoration', () => {
    for (const raw of ['revoked', 'danger']) {
      const r = validateAffectsCurrentWork(raw, MAIN, MAIN)
      expect(r.ok).toBe(false)
      expect((r as { error: string }).error).toContain(raw)
    }
  })

  it('rejects a sub-agent that tries to flag its own message', () => {
    const r = validateAffectsCurrentWork('unblocks', 'cody', MAIN)
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('main agent')
  })

  // A silently dropped flag is the worst outcome: the sender believes it sent
  // an interrupt, and the message queues for half an hour anyway.
  it('rejects loudly rather than falling back to null', () => {
    expect(validateAffectsCurrentWork('unblocks', 'cody', MAIN).ok).toBe(false)
    expect(validateAffectsCurrentWork(42, MAIN, MAIN).ok).toBe(false)
  })
})

describe('the delivery side re-checks what it was handed', () => {
  const flagged = { from_agent: MAIN, affects_current_work: UNBLOCKS }

  it('interrupts only when the pane is NOT ready', () => {
    expect(shouldInterruptForUnblock(flagged, false, MAIN)).toBe(true)
    // A ready pane needs no interrupt: the normal path already delivers now.
    expect(shouldInterruptForUnblock(flagged, true, MAIN)).toBe(false)
  })

  // POSITIVE CONTROL for the whole card: an unflagged message must keep
  // queueing. Without this, "it works" would be just as green if the flag did
  // nothing and every message started interrupting.
  it('leaves an unflagged message queued behind the busy turn', () => {
    expect(shouldInterruptForUnblock({ from_agent: MAIN, affects_current_work: null }, false, MAIN)).toBe(false)
    expect(shouldInterruptForUnblock({ from_agent: MAIN }, false, MAIN)).toBe(false)
  })

  // A row can be written straight into the DB (the channel-coordinator does
  // exactly that), so the router must not trust a stored value it did not
  // validate itself.
  it('does not trust a stored flag from a sender that may not set one', () => {
    expect(shouldInterruptForUnblock({ from_agent: 'cody', affects_current_work: UNBLOCKS }, false, MAIN)).toBe(false)
  })

  it('ignores a value that is not the one built case', () => {
    expect(shouldInterruptForUnblock({ from_agent: MAIN, affects_current_work: 'danger' }, false, MAIN)).toBe(false)
  })
})

// The busy pane is the one delivery mode that can arrive spliced (2026-09-10:
// Cody got a PHP snippet with fragments of a later sentence in its middle,
// while the stored row was byte-perfect). So an interrupt types a SHORT line
// and points at the queue row for the rest.
describe('what actually gets typed into a busy pane', () => {
  it('sends a short message whole -- nothing gained by truncating what fits', () => {
    const body = 'A Logzi szinkron lefutott, mehet a kirakas.'
    const out = buildUnblockInterruptContent(body, 4242)
    expect(out).toContain(body)
    expect(out).not.toContain('/api/messages/')
  })

  it('truncates a long one and names where the byte-perfect text lives', () => {
    const body = 'x'.repeat(UNBLOCK_NOTICE_MAX_CHARS + 500)
    const out = buildUnblockInterruptContent(body, 4242)
    expect(out.length).toBeLessThan(body.length)
    expect(out).toContain('GET /api/messages/4242')
  })

  it('labels the message as a release, not as new work', () => {
    expect(buildUnblockInterruptContent('kesz', 1)).toContain('NEM uj feladat')
  })
})

describe('the column round-trips', () => {
  it('stores the flag and defaults to null without one', () => {
    const flagged = createAgentMessage(MAIN, 'cody-test', 'feloldva', null, null, { affectsCurrentWork: UNBLOCKS })
    expect(getAgentMessage(flagged.id)?.affects_current_work).toBe(UNBLOCKS)

    const plain = createAgentMessage(MAIN, 'cody-test', 'sima uzenet')
    expect(getAgentMessage(plain.id)?.affects_current_work ?? null).toBeNull()
  })
})

// The helpers above are only half the feature: nothing happens unless the router
// and the route call them. Pinned as source text, like worksource-wiring.test.ts.
describe('the router and the route are wired to the helpers', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

  it('the router passes a flagged message through the urgent/STOP path, alone and with a short notice', () => {
    const src = read('web/message-router.ts')
    expect(src).toMatch(/const unblockPass = !isStop && shouldInterruptForUnblock\(msg, !paneNotReady, MAIN_AGENT_ID\)/)
    expect(src).toMatch(/unblockPass \? 'UNBLOCK'/)
    expect(src).toMatch(/unblockPass \? buildUnblockInterruptContent\(msg\.content, msg\.id\)/)
    expect(src).toMatch(/const mates = unblockPass\s*\?/)
    expect(src).toMatch(/if \(isStop \|\| unblockPass\)/)
  })

  it('the route validates the flag before the row is created', () => {
    const src = read('web/routes/messages.ts')
    expect(src).toMatch(/validateAffectsCurrentWork\(affects_current_work, from\.trim\(\), MAIN_AGENT_ID\)/)
    expect(src).toMatch(/if \(!affects\.ok\) \{\s*json\(res, \{ error: affects\.error \}, 400\)\s*return true/)
    expect(src).toMatch(/affectsCurrentWork: affects\.value/)
  })
})
