import { describe, it, expect } from 'vitest'
import { normalizeKanbanRefs, type SeqLookup } from '../web/kanban-ref-normalize.js'

// In-memory map mirrors what getKanbanSeqByIdPrefix does against SQLite: a
// known 8-char id maps to a seq, anything else returns null. Keeps the test
// hermetic so the DB doesn't get involved.
function lookupOf(rows: Record<string, number>): SeqLookup {
  return (idPrefix) => {
    const v = rows[idPrefix.toLowerCase()]
    return v == null ? null : v
  }
}

describe('normalizeKanbanRefs', () => {
  it('rewrites a single matching hex reference to #seq', () => {
    const lookup = lookupOf({ '2ea7f8d9': 75 })
    expect(normalizeKanbanRefs('See #2ea7f8d9 for context', lookup))
      .toBe('See #75 for context')
  })

  it('rewrites multiple references in the same content', () => {
    const lookup = lookupOf({ '2ea7f8d9': 75, 'cb5080e5': 31 })
    expect(normalizeKanbanRefs('Bundling #2ea7f8d9 and #cb5080e5 today', lookup))
      .toBe('Bundling #75 and #31 today')
  })

  it('preserves the explicit disambiguation pattern `#seq (hex)`', () => {
    // The "(cb5080e5)" inside parens has no `#` prefix so the regex never
    // touches it; the `#31` seq token is digits-only so it also doesn't
    // match. The whole string round-trips untouched.
    const lookup = lookupOf({ 'cb5080e5': 31 })
    const input = 'See #31 (cb5080e5) for the right one'
    expect(normalizeKanbanRefs(input, lookup)).toBe(input)
  })

  it('leaves a hex token alone when no kanban card matches', () => {
    const lookup = lookupOf({}) // empty: no card has this id
    const input = 'commit deadbeef -> #abcdef12 in the diff'
    expect(normalizeKanbanRefs(input, lookup)).toBe(input)
  })

  it('does not touch non-kanban `#` patterns (GitHub PRs, issues)', () => {
    const lookup = lookupOf({ '2ea7f8d9': 75 })
    // Mixed: PR #308 and issue #42 are too short to match the 8-hex regex;
    // the real kanban ref still rewrites.
    expect(normalizeKanbanRefs('Fix #308 lands #2ea7f8d9 (linked to #42)', lookup))
      .toBe('Fix #308 lands #75 (linked to #42)')
  })

  it('case-insensitive: an uppercase hex matches a lowercase card id', () => {
    const lookup = lookupOf({ '2ea7f8d9': 75 })
    expect(normalizeKanbanRefs('Mixed-case #2EA7F8D9 should still rewrite', lookup))
      .toBe('Mixed-case #75 should still rewrite')
  })

  it('does not match longer hex runs (9+ chars stay intact)', () => {
    // \b after the 8th hex char fails when the next char is also a word
    // char, so `#2ea7f8d99` (9 hex) does not get partially rewritten.
    const lookup = lookupOf({ '2ea7f8d9': 75 })
    const input = 'Long token #2ea7f8d99 should not change'
    expect(normalizeKanbanRefs(input, lookup)).toBe(input)
  })

  it('returns the input untouched when content has no `#` at all', () => {
    const lookup = lookupOf({ '2ea7f8d9': 75 })
    const input = 'No references in this line, just text.'
    expect(normalizeKanbanRefs(input, lookup)).toBe(input)
  })
})
