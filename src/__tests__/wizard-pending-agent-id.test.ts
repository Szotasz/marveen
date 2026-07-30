import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// PAIRAPPROVE1. On a renamed install the onboarding wizard showed "no pending
// pairing" while the agent's Channel view listed the very same request.
//
// Cause, traced through the code: the wizard asks mainAgentId(), which falls
// back to the literal 'marveen' until /api/marveen has populated
// window._marveen. On a renamed install that literal is NOT the main agent, so
// the backend takes its sub-agent branch (agents.ts: name !== MAIN_AGENT_ID &&
// !existsSync(agentDir(name))) and answers 404 -- which the wizard then parsed
// as a body and turned into an empty list. The Channel view uses the selected
// agent, so it was unaffected.
//
// The same boot race is already documented and guarded for the Messages page
// (ensureMarveenLoaded). This change applies that existing guard at the second
// call site; it deliberately does NOT remove the mainAgentId() fallback, which
// other call sites rely on.
//
// The wizard step is not unit-mountable, so these are structural assertions
// over the source -- the convention this repo already uses for installer and
// template invariants. What they lock is ORDER and PRESENCE, which is exactly
// what a later refactor would silently drop.

const APP = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')

/** The wizard's step-4 pending loader. */
function loadPendingBlock(): string {
  const start = APP.indexOf('const loadPending = async () => {')
  expect(start, 'loadPending not found').toBeGreaterThan(0)
  return APP.slice(start, start + 2000)
}

describe('PAIRAPPROVE1: the wizard resolves the real agent id before asking', () => {
  it('the boot-race guard still exists and is what we reuse', () => {
    expect(APP).toContain('async function ensureMarveenLoaded()')
    // it must remain a no-op once the id is known, or every poll refetches
    expect(APP).toMatch(/async function ensureMarveenLoaded\(\)\s*\{\s*\n\s*if \(window\._marveen\?\.agentId\) return/)
  })

  it('awaits the guard BEFORE fetching pending (order is the whole fix)', () => {
    const blk = loadPendingBlock()
    const guard = blk.indexOf('await ensureMarveenLoaded()')
    const fetchAt = blk.indexOf('await fetch(')
    expect(guard, 'guard not called in loadPending').toBeGreaterThan(-1)
    expect(fetchAt).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(fetchAt)
  })

  it('checks res.ok and shows the error instead of an empty list', () => {
    const blk = loadPendingBlock()
    expect(blk).toContain('if (!res.ok)')
    // the failure branch must render something, not fall through to the
    // "no pending" hint -- that was the silent-empty defect
    const bad = blk.indexOf('if (!res.ok)')
    const noPending = blk.indexOf('onboarding.step3.no_pending')
    expect(bad).toBeLessThan(noPending)
    expect(blk.slice(bad, noPending)).toMatch(/onbPending/)
  })

  it('does NOT parse the response before knowing it succeeded', () => {
    const blk = loadPendingBlock()
    // The original bug shape: `await (await fetch(...)).json()` in one go, which
    // parses a 404 body as if it were the payload.
    // NOTE: a `[^)]*` inner pattern does NOT work here -- the URL itself
    // contains `encodeURIComponent(...)`, so the class stops at the first
    // paren and the assertion silently passes on the buggy form. Match
    // non-greedily across parens instead. (Caught by a negative control that
    // failed only one test where it should have failed two.)
    expect(blk).not.toMatch(/await \(await fetch\([\s\S]*?\)\.json\(\)/)
  })

  it('leaves the mainAgentId fallback alone (other call sites depend on it)', () => {
    expect(APP).toMatch(/return window\._marveen\?\.agentId \|\| 'marveen'/)
  })

  it('keeps the expiry filter, which is correct (the plugin writes ms)', () => {
    // measured in the telegram plugin source: expiresAt = now + 60*60*1000
    const blk = loadPendingBlock()
    expect(blk).toMatch(/x\.expiresAt > now/)
  })
})
