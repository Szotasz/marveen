import { describe, it, expect } from 'vitest'
import { decideRelease, releaseMessage } from '../kanban-release.js'
import type { ReleasableCard } from '../kanban-release.js'

// The gate used to live in prose ("after the move"), so closing the blocker
// woke nobody: #148 and #151 both sat until the owner asked. These are the
// rules that decide what a closing blocker does to the cards behind it.

const card = (over: Partial<ReleasableCard> = {}): ReleasableCard => ({
  id: 'aa11bb22', seq: 151, title: 'start.otthon', status: 'waiting', assignee: 'prisma', ...over,
})
const blocker = { id: 'cc33dd44', seq: 125, title: 'Tarhely-bovites' }
const OPTS = { ownerName: 'Viktor' }

describe('what a closing blocker does to the cards waiting on it', () => {
  it('releases a card whose last blocker just closed', () => {
    const decision = decideRelease(card(), blocker, 0, OPTS)
    expect(decision).not.toBeNull()
    expect(decision!.comment).toContain('#125')
    expect(decision!.comment).toContain('felszabadult')
  })

  it('stays silent while another blocker is still open', () => {
    // A "you are free" comment that is not true is worse than silence: the
    // assignee starts work whose precondition is still missing.
    expect(decideRelease(card(), blocker, 1, OPTS)).toBeNull()
  })

  it('leaves a card that already finished alone', () => {
    expect(decideRelease(card({ status: 'done' }), blocker, 0, OPTS)).toBeNull()
  })
})

describe('what happens to the released card status', () => {
  it('moves a parked (waiting) card back into the queue', () => {
    const decision = decideRelease(card({ status: 'waiting' }), blocker, 0, OPTS)
    expect(decision!.moveToPlanned).toBe(true)
    expect(decision!.comment).toContain('waiting -> planned')
  })

  it('leaves every other column where it is', () => {
    for (const status of ['planned', 'in_progress', 'testing'] as const) {
      const decision = decideRelease(card({ status }), blocker, 0, OPTS)
      expect(decision!.moveToPlanned).toBe(false)
    }
  })

  it('never moves the owner own card, even when it was parked', () => {
    // `waiting` on the owner's card often means something the board cannot
    // see (a decision they are sitting on), so a closed blocker is not proof
    // the wait is over. It is announced, not moved.
    const decision = decideRelease(card({ status: 'waiting', assignee: 'Viktor' }), blocker, 0, OPTS)
    expect(decision!.moveToPlanned).toBe(false)
    expect(decision!.ownerHeld).toBe(true)
    expect(decision!.comment).toContain('szándékosan')
  })

  it('matches the owner case-insensitively', () => {
    // The board holds both spellings; a guard that misses on casing is no guard.
    expect(decideRelease(card({ assignee: 'viktor' }), blocker, 0, OPTS)!.ownerHeld).toBe(true)
    expect(decideRelease(card({ assignee: 'prisma' }), blocker, 0, OPTS)!.ownerHeld).toBe(false)
  })

  it('never announces an auto-start', () => {
    // Moving a released card to in_progress would fire the kanban -> agent
    // dispatch and put an agent to work with no human in the loop.
    const decision = decideRelease(card(), blocker, 0, OPTS)
    expect(decision!.comment).toContain('NEM indult el')
    expect(JSON.stringify(decision)).not.toContain('in_progress"')
  })
})

describe('the wake-up an assignee receives', () => {
  it('names both cards and hands over the start command', () => {
    const msg = releaseMessage(card(), blocker, 'curl -X POST .../move')
    expect(msg).toContain('#151')
    expect(msg).toContain('#125')
    expect(msg).toContain('curl -X POST .../move')
  })

  it('falls back to the hex id when a card has no seq', () => {
    const msg = releaseMessage(card({ seq: undefined }), { ...blocker, seq: undefined }, 'curl')
    expect(msg).toContain('#aa11bb22')
    expect(msg).toContain('#cc33dd44')
  })
})
