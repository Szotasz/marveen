// Which subtasks may be drawn inside their parent card, and which keep a box.
//
// The board groups cards into swimlanes by assignee. Embedding hides a subtask
// as a standalone card and draws it inside the parent instead -- so embedding a
// subtask owned by someone else silently moves it out of its owner's lane and
// into the parent owner's. On 2026-08-05 the owner dragged his own card #257
// from planned to waiting because waiting was its true status; that matched the
// parent's column (#191, owned by the atlas agent), the card was embedded, and
// it vanished from his lane. A collapsed lane hides it from the browser's find
// as well, so it read as "gone without a trace".
//
// web/app.js is a classic browser script, not a module, so it cannot be
// imported. The predicate is delimited by sentinel comments in the source and
// executed here, which tests the shipped code rather than a copy of it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')
const appSource = readFileSync(join(WEB, 'app.js'), 'utf8')

type Card = { status: string; assignee?: string | null }

function extractPredicate(): (parent: Card, child: Card) => boolean {
  const start = appSource.indexOf('// --- canEmbedSubtask start')
  const end = appSource.indexOf('// --- canEmbedSubtask end')
  // A missing sentinel means the block was renamed or moved: fail loudly
  // rather than silently testing nothing.
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const src = appSource.slice(start, end)
  return new Function(`${src}; return canEmbedSubtask`)() as (parent: Card, child: Card) => boolean
}

const canEmbed = extractPredicate()

describe('subtask embedding', () => {
  it('embeds a subtask that shares both column and owner with its parent', () => {
    expect(canEmbed({ status: 'waiting', assignee: 'atlas' }, { status: 'waiting', assignee: 'atlas' })).toBe(true)
  })

  it('keeps a subtask standalone when the columns differ', () => {
    expect(canEmbed({ status: 'waiting', assignee: 'atlas' }, { status: 'planned', assignee: 'atlas' })).toBe(false)
  })

  it('keeps a subtask standalone when the owner differs, even in the same column', () => {
    // The #257 case. Same column is not enough: embedding here would move the
    // owner's card into the agent's swimlane.
    expect(canEmbed({ status: 'waiting', assignee: 'atlas' }, { status: 'waiting', assignee: 'Viktor' })).toBe(false)
  })

  it('treats owner names case- and whitespace-insensitively', () => {
    // Assignees are free text on the card; ' Atlas ' and 'atlas' are one owner,
    // and a spelling difference must not split a card out of its parent.
    expect(canEmbed({ status: 'done', assignee: ' Atlas ' }, { status: 'done', assignee: 'atlas' })).toBe(true)
  })

  it('embeds an unassigned subtask under an unassigned parent', () => {
    // Both empty is still "same owner": nobody holds either, so they belong
    // together. null and '' must not read as two different owners.
    expect(canEmbed({ status: 'planned', assignee: null }, { status: 'planned' })).toBe(true)
  })

  it('keeps an unassigned subtask standalone under an owned parent', () => {
    expect(canEmbed({ status: 'planned', assignee: 'prisma' }, { status: 'planned', assignee: null })).toBe(false)
  })
})
