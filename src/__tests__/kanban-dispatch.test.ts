import { describe, it, expect } from 'vitest'
import { resolveKanbanDispatchTarget } from '../kanban-dispatch.js'

const base = {
  ownerName: 'Gábor',
  botName: 'GorcsevIvan',
  mainAgentId: 'gorcsevivan',
  agentNames: ['tuskohopkins', 'sentinel'],
  isRunning: (n: string) => n === 'tuskohopkins', // only tuskohopkins is "running"
}

describe('resolveKanbanDispatchTarget', () => {
  it('returns null for empty / null / undefined / whitespace assignee', () => {
    expect(resolveKanbanDispatchTarget(null, base)).toBeNull()
    expect(resolveKanbanDispatchTarget(undefined, base)).toBeNull()
    expect(resolveKanbanDispatchTarget('', base)).toBeNull()
    expect(resolveKanbanDispatchTarget('   ', base)).toBeNull()
  })

  it('never dispatches to the human owner', () => {
    expect(resolveKanbanDispatchTarget('Gábor', base)).toBeNull()
  })

  it('maps the bot display name to the main agent id', () => {
    expect(resolveKanbanDispatchTarget('GorcsevIvan', base)).toBe('gorcsevivan')
  })

  it('maps the canonical main agent id to itself', () => {
    expect(resolveKanbanDispatchTarget('gorcsevivan', base)).toBe('gorcsevivan')
  })

  it('matches the bot/main case-insensitively', () => {
    expect(resolveKanbanDispatchTarget('gorcsevIVAN', base)).toBe('gorcsevivan')
    expect(resolveKanbanDispatchTarget('GORCSEVIVAN', base)).toBe('gorcsevivan')
  })

  it('dispatches to a sub-agent only when its session is running', () => {
    expect(resolveKanbanDispatchTarget('tuskohopkins', base)).toBe('tuskohopkins')
    expect(resolveKanbanDispatchTarget('sentinel', base)).toBeNull() // not running -> silent no-op
  })

  it('matches sub-agent names case-insensitively', () => {
    expect(resolveKanbanDispatchTarget('TuskoHopkins', base)).toBe('tuskohopkins')
  })

  it('returns null for an unknown assignee name', () => {
    expect(resolveKanbanDispatchTarget('SomebodyElse', base)).toBeNull()
  })

  // The echo bug: an agent that moves its own card to in_progress got the task
  // dispatched back at it as a fresh assignment, indistinguishable from real work.
  describe('self-move', () => {
    it('does not dispatch when the mover is the assignee', () => {
      expect(resolveKanbanDispatchTarget('tuskohopkins', { ...base, actor: 'tuskohopkins' })).toBeNull()
      expect(resolveKanbanDispatchTarget('GorcsevIvan', { ...base, actor: 'gorcsevivan' })).toBeNull()
    })

    it('matches the mover against the assignee across name forms and casing', () => {
      // display name vs canonical id, and either side upper/lower cased
      expect(resolveKanbanDispatchTarget('gorcsevivan', { ...base, actor: 'GorcsevIvan' })).toBeNull()
      expect(resolveKanbanDispatchTarget('TuskoHopkins', { ...base, actor: 'tuskohopkins' })).toBeNull()
    })

    it('still dispatches when somebody else moved the card', () => {
      expect(resolveKanbanDispatchTarget('tuskohopkins', { ...base, actor: 'Gábor' })).toBe('tuskohopkins')
      expect(resolveKanbanDispatchTarget('tuskohopkins', { ...base, actor: 'gorcsevivan' })).toBe('tuskohopkins')
    })

    it('dispatches as before when the mover is unknown or not reported', () => {
      // Legacy callers send no actor at all -- the rule must be inert, not blocking.
      expect(resolveKanbanDispatchTarget('tuskohopkins', base)).toBe('tuskohopkins')
      expect(resolveKanbanDispatchTarget('tuskohopkins', { ...base, actor: null })).toBe('tuskohopkins')
      expect(resolveKanbanDispatchTarget('tuskohopkins', { ...base, actor: '  ' })).toBe('tuskohopkins')
      expect(resolveKanbanDispatchTarget('tuskohopkins', { ...base, actor: 'SomebodyElse' })).toBe('tuskohopkins')
    })

    // A stopped sub-agent moving its own card is still a self-move: the
    // no-dispatch decision must not hinge on whether the session happens to be up.
    it('recognises a self-move even when the agent session is not running', () => {
      expect(resolveKanbanDispatchTarget('sentinel', { ...base, actor: 'sentinel' })).toBeNull()
    })
  })
})
