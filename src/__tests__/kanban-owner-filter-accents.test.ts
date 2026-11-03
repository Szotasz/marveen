// The owner quick-filter compares two differently written names: the owner
// entry carries a display name ("Balázs") while the cards carry the id the
// agents write ("balazs"). Lowercasing alone leaves the accent, so the button
// matched nothing. These tests guard the fix from both sides: the behaviour of
// the normaliser, and the wiring that every comparison site actually uses it.
//
// The behavioural half evaluates the function OUT OF web/app.js rather than
// restating it here. A copy in the test would keep passing after the shipped
// code changed, which is the one thing a guard must not do.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')

function loadAssigneeKey(): (name: unknown) => string {
  const m = APP.match(/function assigneeKey\(name\) \{[\s\S]*?\n\}/)
  // An empty match must fail the test, not quietly produce a stub: a missing
  // function is exactly the regression this file exists to catch.
  if (!m) throw new Error('assigneeKey() not found in web/app.js')
  return new Function(`${m[0]}; return assigneeKey`)() as (name: unknown) => string
}

describe('assignee name normalisation', () => {
  const key = loadAssigneeKey()

  it('makes the accented owner name and the card id compare equal', () => {
    expect(key('Balázs')).toBe(key('balazs'))
  })

  it('still folds case, which is what the old comparison did', () => {
    expect(key('Webby')).toBe(key('webby'))
  })

  it('trims, because an assignee may carry stray whitespace', () => {
    expect(key('  cody  ')).toBe('cody')
  })

  it('survives null and undefined rather than throwing on a card with no assignee', () => {
    expect(key(null)).toBe('')
    expect(key(undefined)).toBe('')
  })

  it('keeps different names different', () => {
    expect(key('Balázs')).not.toBe(key('webby'))
  })

  it('handles every Hungarian accent, not just the one that broke', () => {
    expect(key('ÁÉÍÓÖŐÚÜŰ')).toBe('aeiooouuu')
  })
})

describe('owner filter wiring', () => {
  it('the card filter compares through the normaliser on both sides', () => {
    expect(APP).toContain('const assigneeFilter = assigneeKey(kanbanAssigneeFilter)')
    expect(APP).toContain('assigneeKey(card.assignee) !== assigneeFilter')
  })

  it('the button state and the click handler use it too', () => {
    const uses = APP.match(/assigneeKey\(kanbanAssigneeFilter\) === assigneeKey\(owner\)/g) || []
    expect(uses.length).toBe(2)
  })

  it('no comparison site is left on a bare toLowerCase', () => {
    expect(APP).not.toContain('kanbanAssigneeFilter.toLowerCase() === owner.toLowerCase()')
    expect(APP).not.toContain("String(card.assignee || '').trim().toLowerCase() !== assigneeFilter")
  })
})
