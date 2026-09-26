import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, openCase, getCase, listCases, appendCaseNote, closeCase, claimOwnerFlag, listOwnerFlagClaims, releaseOwnerFlag, listOwnerFlagReleases } from '../db.js'

// Case files (one place per multi-agent finding) and the send-once ledger for
// owner-facing flags. In-memory DB, no network.
describe('cases', () => {
  beforeAll(() => { initDatabase(':memory:') })

  it('opening is idempotent on the id: the first opener wins, a second open returns the same case', () => {
    const a = openCase('case-x', 'first title', 'agent-a')
    const b = openCase('case-x', 'second title', 'agent-b')
    expect(a.id).toBe('case-x')
    expect(b.title).toBe('first title')
    expect(b.opened_by).toBe('agent-a')
  })

  it('notes are append-only and come back in order', () => {
    appendCaseNote('case-x', 'agent-a', 'finding', 'one')
    appendCaseNote('case-x', 'agent-b', 'correction', 'two')
    const c = getCase('case-x')
    expect(c).not.toBeNull()
    expect(c!.notes.map((n) => n.content)).toEqual(['one', 'two'])
    expect(c!.notes.map((n) => n.kind)).toEqual(['finding', 'correction'])
  })

  it('closing records who and moves it out of the open list', () => {
    const r = closeCase('case-x', 'agent-b')
    expect(r.closed).toBe(true)
    expect(r.case?.status).toBe('closed')
    expect(r.case?.closed_by).toBe('agent-b')
    expect(listCases('open').some((c) => c.id === 'case-x')).toBe(false)
    expect(listCases('closed').some((c) => c.id === 'case-x')).toBe(true)
  })

  it('a second close keeps the original closer and time', () => {
    const before = getCase('case-x')!.case
    const r = closeCase('case-x', 'agent-c')
    expect(r.closed).toBe(false)
    expect(r.case?.closed_by).toBe(before.closed_by)
    expect(r.case?.closed_at).toBe(before.closed_at)
  })

  it('an unknown case is null', () => {
    expect(getCase('nope')).toBeNull()
  })
})

describe('owner-flag send-once ledger', () => {
  beforeAll(() => { initDatabase(':memory:') })

  it('the first claim for (agent, source_ref) wins, a second one does not', () => {
    const first = claimOwnerFlag('agent-a', 'mail:1')
    const second = claimOwnerFlag('agent-a', 'mail:1')
    expect(first.claimed).toBe(true)
    expect(second.claimed).toBe(false)
  })

  it('the same source_ref is independent per agent', () => {
    expect(claimOwnerFlag('agent-b', 'mail:1').claimed).toBe(true)
  })

  it('release frees the claim so a genuine re-send is possible', () => {
    expect(releaseOwnerFlag('agent-a', 'mail:1')).toBe(true)
    expect(claimOwnerFlag('agent-a', 'mail:1').claimed).toBe(true)
    expect(listOwnerFlagClaims('agent-a').length).toBe(1)
  })

  it('a release leaves a trail of who released it and when', () => {
    expect(releaseOwnerFlag('agent-a', 'mail:1', 'agent-z')).toBe(true)
    const trail = listOwnerFlagReleases('agent-a', 'mail:1')
    expect(trail.at(-1)?.released_by).toBe('agent-z')
    expect(trail.at(-1)?.released_at).toBeGreaterThan(0)
    expect(releaseOwnerFlag('agent-a', 'mail:1', 'agent-z')).toBe(false)
    expect(listOwnerFlagReleases('agent-a', 'mail:1').length).toBe(trail.length)
  })
})
