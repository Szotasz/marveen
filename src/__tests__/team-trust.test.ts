import { describe, it, expect } from 'vitest'
import { isTrustedPeer, type TrustContext, type TeamConfigForTrust } from '../team-trust.js'

// Helper: build a TrustContext backed by a Map so tests can declare the
// team graph as data. MAIN is always a known agent; any agent whose id
// appears as a key in `teams` is also known; everything else is unknown.
function makeCtx(
  teams: Record<string, TeamConfigForTrust>,
  mainAgentId = 'main',
): TrustContext {
  const known = new Set<string>([mainAgentId, ...Object.keys(teams)])
  return {
    mainAgentId,
    isKnownAgent: (name: string) => !!name && known.has(name),
    readAgentTeam: (name: string) =>
      teams[name] ?? { reportsTo: null, delegatesTo: [], trustFrom: [] },
  }
}

describe('isTrustedPeer — guard rails', () => {
  const ctx = makeCtx({
    alice: { reportsTo: null, delegatesTo: [], trustFrom: [] },
  })

  it('returns false for an empty from', () => {
    expect(isTrustedPeer('', 'alice', ctx)).toBe(false)
  })

  it('returns false for an empty to', () => {
    expect(isTrustedPeer('alice', '', ctx)).toBe(false)
  })

  it('returns false for a self-loop', () => {
    expect(isTrustedPeer('alice', 'alice', ctx)).toBe(false)
  })

  it('returns false when from is unknown', () => {
    expect(isTrustedPeer('ghost', 'alice', ctx)).toBe(false)
  })

  it('returns false when to is unknown', () => {
    expect(isTrustedPeer('alice', 'ghost', ctx)).toBe(false)
  })

  it('returns false for a spoofed unknown targeting MAIN (sorrend-guard)', () => {
    // This is the key anti-spoof case: the MAIN shortcut must not fire
    // before the known-agent check, otherwise any unknown sender aimed
    // at MAIN would be treated as a trusted peer.
    expect(isTrustedPeer('ghost', 'main', ctx)).toBe(false)
    expect(isTrustedPeer('main', 'ghost', ctx)).toBe(false)
  })
})

describe('isTrustedPeer — MAIN shortcut', () => {
  const ctx = makeCtx({
    alice: { reportsTo: null, delegatesTo: [], trustFrom: [] },
    bob: { reportsTo: null, delegatesTo: [], trustFrom: [] },
  })

  it('trusts MAIN → any known agent even without an explicit edge', () => {
    expect(isTrustedPeer('main', 'alice', ctx)).toBe(true)
    expect(isTrustedPeer('main', 'bob', ctx)).toBe(true)
  })

  it('trusts any known agent → MAIN even without an explicit edge', () => {
    expect(isTrustedPeer('alice', 'main', ctx)).toBe(true)
    expect(isTrustedPeer('bob', 'main', ctx)).toBe(true)
  })
})

describe('isTrustedPeer — reportsTo edge', () => {
  const ctx = makeCtx({
    leader: { reportsTo: null, delegatesTo: [], trustFrom: [] },
    member: { reportsTo: 'leader', delegatesTo: [], trustFrom: [] },
  })

  it('trusts leader → member (to.reportsTo === from)', () => {
    expect(isTrustedPeer('leader', 'member', ctx)).toBe(true)
  })

  it('trusts member → leader (from.reportsTo === to)', () => {
    expect(isTrustedPeer('member', 'leader', ctx)).toBe(true)
  })
})

describe('isTrustedPeer — delegatesTo edge', () => {
  const ctx = makeCtx({
    a: { reportsTo: null, delegatesTo: ['b'], trustFrom: [] },
    b: { reportsTo: null, delegatesTo: [], trustFrom: [] },
    c: { reportsTo: null, delegatesTo: [], trustFrom: [] },
  })

  it('trusts a → b when a.delegatesTo includes b', () => {
    expect(isTrustedPeer('a', 'b', ctx)).toBe(true)
  })

  it('trusts b → a symmetrically (a delegates to b means b also trusts a)', () => {
    expect(isTrustedPeer('b', 'a', ctx)).toBe(true)
  })

  it('does not trust unrelated peers (a ↔ c)', () => {
    expect(isTrustedPeer('a', 'c', ctx)).toBe(false)
    expect(isTrustedPeer('c', 'a', ctx)).toBe(false)
  })
})

describe('isTrustedPeer — trustFrom explicit override', () => {
  const ctx = makeCtx({
    a: { reportsTo: null, delegatesTo: [], trustFrom: ['b'] },
    b: { reportsTo: null, delegatesTo: [], trustFrom: [] },
  })

  it('trusts b → a when a.trustFrom includes b', () => {
    expect(isTrustedPeer('b', 'a', ctx)).toBe(true)
  })

  it('trusts a → b symmetrically', () => {
    expect(isTrustedPeer('a', 'b', ctx)).toBe(true)
  })
})

describe('isTrustedPeer — trustFrom absent field', () => {
  // Older configs may omit trustFrom entirely; the helper must not crash
  // and must just treat the list as empty.
  const ctx = makeCtx({
    a: { reportsTo: null, delegatesTo: [] },
    b: { reportsTo: null, delegatesTo: [] },
  })

  it('handles a missing trustFrom field as an empty list', () => {
    expect(isTrustedPeer('a', 'b', ctx)).toBe(false)
  })
})

describe('isTrustedPeer — no false trust for strangers', () => {
  const ctx = makeCtx({
    a: { reportsTo: 'leader', delegatesTo: [], trustFrom: [] },
    b: { reportsTo: 'leader', delegatesTo: [], trustFrom: [] },
    leader: { reportsTo: null, delegatesTo: [], trustFrom: [] },
  })

  it('does not trust two members of the same leader without an explicit edge', () => {
    // a and b both report to `leader`, but neither has the other in
    // delegatesTo / trustFrom, so horizontal peer trust is not implied.
    expect(isTrustedPeer('a', 'b', ctx)).toBe(false)
    expect(isTrustedPeer('b', 'a', ctx)).toBe(false)
  })
})

describe('isTrustedPeer — typical dev-team scenario', () => {
  // A leader with four members reporting to it, plus an isolated helper
  // agent with no edges. Exercises every trust path end-to-end on a
  // realistic small team graph.
  const ctx = makeCtx({
    team_lead: { reportsTo: null, delegatesTo: ['dev2'], trustFrom: [] },
    dev2: { reportsTo: 'team_lead', delegatesTo: [], trustFrom: [] },
    dev3: { reportsTo: 'team_lead', delegatesTo: [], trustFrom: [] },
    dev4: { reportsTo: 'team_lead', delegatesTo: [], trustFrom: [] },
    reviewer: { reportsTo: 'team_lead', delegatesTo: [], trustFrom: [] },
    isolated: { reportsTo: null, delegatesTo: [], trustFrom: [] },
  }, 'main')

  it('leader ↔ each member is trusted', () => {
    for (const member of ['dev2', 'dev3', 'dev4', 'reviewer']) {
      expect(isTrustedPeer('team_lead', member, ctx)).toBe(true)
      expect(isTrustedPeer(member, 'team_lead', ctx)).toBe(true)
    }
  })

  it('main ↔ every known agent is trusted', () => {
    for (const a of ['team_lead', 'dev2', 'dev3', 'reviewer', 'isolated']) {
      expect(isTrustedPeer('main', a, ctx)).toBe(true)
      expect(isTrustedPeer(a, 'main', ctx)).toBe(true)
    }
  })

  it('peer-to-peer is NOT trusted unless an explicit edge exists', () => {
    // Classic peer-handoff concern: dev2 and dev3 have no edge, so a
    // direct message between them falls back to untrusted. Operator
    // must add dev2.delegatesTo = ['dev3'] (or trustFrom) via the UI.
    expect(isTrustedPeer('dev2', 'dev3', ctx)).toBe(false)
    expect(isTrustedPeer('dev3', 'dev2', ctx)).toBe(false)
  })

  it('isolated agent is only trusted with main', () => {
    // An agent without reportsTo / delegatesTo / trustFrom is in the
    // graph but has no edges except the implicit main shortcut.
    expect(isTrustedPeer('isolated', 'main', ctx)).toBe(true)
    expect(isTrustedPeer('isolated', 'team_lead', ctx)).toBe(false)
    expect(isTrustedPeer('team_lead', 'isolated', ctx)).toBe(false)
  })
})

describe('isTrustedPeer — custom mainAgentId', () => {
  // The helper must respect the caller's MAIN id, not hard-code "main".
  const ctx = makeCtx({
    orchestrator: { reportsTo: null, delegatesTo: [], trustFrom: [] },
    sub: { reportsTo: null, delegatesTo: [], trustFrom: [] },
  }, 'orchestrator')

  it('uses ctx.mainAgentId for the implicit shortcut', () => {
    expect(isTrustedPeer('orchestrator', 'sub', ctx)).toBe(true)
    expect(isTrustedPeer('sub', 'orchestrator', ctx)).toBe(true)
  })

  it('does NOT trust the literal string "main" when the configured id is different', () => {
    // "main" is not in the teams map and not the configured main id; it's
    // an unknown agent, so the known-agent guard returns false.
    expect(isTrustedPeer('main', 'sub', ctx)).toBe(false)
  })
})
