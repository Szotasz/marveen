// Contract tests for parent-card activity bubbling (card 68763e8f).
//
// A subcard write stamps its ancestors' updated_at, so a thread whose work happens on its
// subcards no longer reads as a stalled parent to the stuck-card detector
// (`status='in_progress' AND updated_at < last_audit_at`).
//
// THE SECOND DIRECTION IS THE POINT. "Parent moved" alone would also pass if we simply stamped
// every card on every write -- that is silencing, not fixing. So each positive test has a
// standalone in_progress card next to it that must NOT move: it is the control that says the
// detector can still see a real stall.
//
// Timestamps are whole seconds, so a card written twice inside one second shows no difference at
// all. Every test therefore backdates the cards it is about to observe, and asserts a move
// relative to that backdated value -- otherwise "greater than before" would be measuring the
// clock, not the code.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  initDatabase, getDb,
  createKanbanCard, updateKanbanCard, moveKanbanCard, addKanbanComment,
  archiveKanbanCard, getKanbanCard,
} from '../db.js'

const BACKDATED = 1_000_000

/** Pushes a card's updated_at into the past so a later stamp is visible in whole seconds. */
function backdate(id: string, ts = BACKDATED): void {
  getDb().prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(ts, id)
}

function updatedAt(id: string): number {
  return getKanbanCard(id)!.updated_at
}

/** Parent + child, both parked in the past. The lone card is the negative control. */
function seedThread(): void {
  createKanbanCard({ id: 'parent', title: 'Thread', status: 'in_progress' })
  createKanbanCard({ id: 'child', title: 'Subtask', parent_id: 'parent' })
  createKanbanCard({ id: 'lonely', title: 'Genuinely stalled', status: 'in_progress' })
  backdate('parent')
  backdate('child')
  backdate('lonely')
}

describe('parent updated_at follows subcard activity', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  // --- the four write paths that stamp updated_at ---

  it('bubbles up from addKanbanComment', () => {
    seedThread()
    addKanbanComment('child', 'sanyiba', 'work note')
    expect(updatedAt('parent')).toBeGreaterThan(BACKDATED)
    expect(updatedAt('lonely')).toBe(BACKDATED)
  })

  it('bubbles up from updateKanbanCard', () => {
    seedThread()
    updateKanbanCard('child', { title: 'Subtask, renamed' })
    expect(updatedAt('parent')).toBeGreaterThan(BACKDATED)
    expect(updatedAt('lonely')).toBe(BACKDATED)
  })

  it('bubbles up from moveKanbanCard -- the most common subcard event, a subcard moved to done', () => {
    seedThread()
    moveKanbanCard('child', 'done', 0, 'sanyiba')
    expect(updatedAt('parent')).toBeGreaterThan(BACKDATED)
    expect(updatedAt('lonely')).toBe(BACKDATED)
  })

  it('bubbles up from createKanbanCard -- filing a new subcard is work on the thread', () => {
    seedThread()
    createKanbanCard({ id: 'child-2', title: 'Another subtask', parent_id: 'parent' })
    expect(updatedAt('parent')).toBeGreaterThan(BACKDATED)
    expect(updatedAt('lonely')).toBe(BACKDATED)
  })

  // --- the control, on its own, because it carries the whole claim ---

  it('leaves a childless in_progress card alone while another thread is written', () => {
    seedThread()
    addKanbanComment('child', 'sanyiba', 'work note')
    moveKanbanCard('child', 'done', 0, 'sanyiba')
    updateKanbanCard('parent', { assignee: 'sanyiba' })

    // The stalled card is still exactly as stale as it was: the detector can see it.
    expect(updatedAt('lonely')).toBe(BACKDATED)
  })

  // --- depth ---

  it('walks the whole chain, not just one level', () => {
    createKanbanCard({ id: 'grandparent', title: 'Epic', status: 'in_progress' })
    createKanbanCard({ id: 'parent', title: 'Thread', parent_id: 'grandparent' })
    createKanbanCard({ id: 'leaf', title: 'Subtask', parent_id: 'parent' })
    backdate('grandparent'); backdate('parent'); backdate('leaf')

    addKanbanComment('leaf', 'sanyiba', 'work note')

    expect(updatedAt('parent')).toBeGreaterThan(BACKDATED)
    expect(updatedAt('grandparent')).toBeGreaterThan(BACKDATED)
  })

  // --- re-parenting touches both threads ---

  it('stamps the old parent too when a card is moved to another thread', () => {
    createKanbanCard({ id: 'old-parent', title: 'Old thread', status: 'in_progress' })
    createKanbanCard({ id: 'new-parent', title: 'New thread', status: 'in_progress' })
    createKanbanCard({ id: 'child', title: 'Subtask', parent_id: 'old-parent' })
    backdate('old-parent'); backdate('new-parent'); backdate('child')

    updateKanbanCard('child', { parent_id: 'new-parent' })

    expect(updatedAt('new-parent')).toBeGreaterThan(BACKDATED)
    expect(updatedAt('old-parent')).toBeGreaterThan(BACKDATED)
  })

  it('stamps the old parent when a card is pulled out of a thread entirely', () => {
    // The un-parenting shape: the new parent is null, so only the old-thread branch can fire.
    createKanbanCard({ id: 'parent', title: 'Thread', status: 'in_progress' })
    createKanbanCard({ id: 'child', title: 'Subtask', parent_id: 'parent' })
    backdate('parent'); backdate('child')

    updateKanbanCard('child', { parent_id: null })

    expect(updatedAt('parent')).toBeGreaterThan(BACKDATED)
  })

  // --- the deliberate exclusion, asserted so a future change to it is a measured decision ---

  // Scope: this covers archiveKanbanCard, the dedicated function. It says nothing about an
  // `archived_at` arriving through PUT /api/kanban/:id, which has no field whitelist and therefore
  // reaches updateKanbanCard -- the bubbling path. That gap belongs to the endpoint (card 531c6500).
  it('does NOT bubble up from archiveKanbanCard -- tidying a thread is not advancing it', () => {
    seedThread()
    archiveKanbanCard('child')
    expect(updatedAt('parent')).toBe(BACKDATED)
  })

  // --- the walk must survive broken parent_id data ---
  //
  // Two guards stand here, and "the call returned" cannot tell them apart: with the visited set
  // removed, the depth cap stops the cycle anyway. Measured the first time round, that mutation
  // survived a green run. What separates them is the DIAGNOSIS -- a cycle reported as a
  // sixteen-deep chain sends the next reader looking for a hierarchy that does not exist -- so
  // these tests assert which guard fired, not merely that something did.

  it('terminates on a parent_id cycle, and says it was a cycle', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      createKanbanCard({ id: 'a', title: 'A' })
      createKanbanCard({ id: 'b', title: 'B', parent_id: 'a' })
      // Nothing validates parent_id, so the public API can close the loop: a -> b -> a.
      updateKanbanCard('a', { parent_id: 'b' })
      backdate('a'); backdate('b')
      warn.mockClear()

      addKanbanComment('b', 'sanyiba', 'work note')

      // Both cards in the cycle get stamped, and the call returns.
      expect(updatedAt('a')).toBeGreaterThan(BACKDATED)
      expect(updatedAt('b')).toBeGreaterThan(BACKDATED)

      const messages = warn.mock.calls.map((c) => String(c[0]))
      expect(messages.some((m) => m.includes('cycle'))).toBe(true)
      expect(messages.some((m) => m.includes('deeper than'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('stops at the depth limit on a chain longer than any real hierarchy, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 20 links, cap is 16: the walk has to stop on its own rather than run the chain out.
      const ids = Array.from({ length: 20 }, (_, i) => `c${i}`)
      ids.forEach((id, i) => createKanbanCard({ id, title: id, parent_id: i === 0 ? undefined : ids[i - 1] }))
      ids.forEach((id) => backdate(id))
      warn.mockClear()

      addKanbanComment(ids[ids.length - 1], 'sanyiba', 'work note')

      // The 16 nearest ancestors are stamped; the far end of the chain is not reached.
      expect(updatedAt(ids[ids.length - 2])).toBeGreaterThan(BACKDATED)
      expect(updatedAt(ids[0])).toBe(BACKDATED)

      const messages = warn.mock.calls.map((c) => String(c[0]))
      expect(messages.some((m) => m.includes('deeper than'))).toBe(true)
      expect(messages.some((m) => m.includes('cycle'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})
