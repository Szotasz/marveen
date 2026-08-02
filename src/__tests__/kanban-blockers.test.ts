// Card dependencies (#185): the data half of a gate that used to live in
// prose. The tests run against the production schema on an in-memory db, and
// cover the three things the prose version could not do -- say what a card is
// waiting for, notice when the wait is over, and refuse a dependency that
// could never resolve.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  initDatabase, getDb, createKanbanCard, getKanbanCard, deleteKanbanCard,
  moveKanbanCard, addKanbanComment, getKanbanComments,
  addKanbanBlocker, removeKanbanBlocker, getBlockersForCard, getCardsBlockedBy,
  getBlockersForAllCards, countOpenBlockers, resolveKanbanCardRef,
  wouldCreateBlockerCycle, parseFuggMarkers, importFuggMarkersAsBlockers,
  runOnceMigration, archiveKanbanCard,
} from '../db.js'
import { fireBlockerRelease, fireKanbanDispatch } from '../web/routes/kanban.js'
import { OWNER_NAME } from '../config.js'

// An install without Telegram: the owner nudge stops at the channel guard
// instead of trying to reach a real chat.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  TELEGRAM_BOT_TOKEN: '',
}))

const seqOf = (id: string): number => getKanbanCard(id)!.seq as number

beforeEach(() => {
  initDatabase(':memory:')
})

describe('declaring what a card waits for', () => {
  it('records the edge and reports the blocker as open', () => {
    createKanbanCard({ id: 'dependent', title: 'start.otthon' })
    createKanbanCard({ id: 'blocker', title: 'Tarhely-bovites' })
    expect(addKanbanBlocker('dependent', 'blocker', 'prisma')).toBe('added')

    const blockers = getBlockersForCard('dependent')
    expect(blockers).toHaveLength(1)
    expect(blockers[0]).toMatchObject({ id: 'blocker', title: 'Tarhely-bovites', open: true })
    expect(countOpenBlockers('dependent')).toBe(1)
  })

  it('carries several blockers on one card', () => {
    createKanbanCard({ id: 'dependent', title: 'RR-lanc vege' })
    createKanbanCard({ id: 'b1', title: 'elso' })
    createKanbanCard({ id: 'b2', title: 'masodik' })
    addKanbanBlocker('dependent', 'b1')
    addKanbanBlocker('dependent', 'b2')
    expect(countOpenBlockers('dependent')).toBe(2)
  })

  it('is idempotent -- the same edge twice is not two edges', () => {
    createKanbanCard({ id: 'dependent', title: 'a' })
    createKanbanCard({ id: 'blocker', title: 'b' })
    expect(addKanbanBlocker('dependent', 'blocker')).toBe('added')
    expect(addKanbanBlocker('dependent', 'blocker')).toBe('exists')
    expect(getBlockersForCard('dependent')).toHaveLength(1)
  })

  it('reads the edges backwards too', () => {
    createKanbanCard({ id: 'dependent', title: 'a' })
    createKanbanCard({ id: 'blocker', title: 'b' })
    addKanbanBlocker('dependent', 'blocker')
    expect(getCardsBlockedBy('blocker').map(c => c.id)).toEqual(['dependent'])
  })

  it('answers for the whole board in one query', () => {
    createKanbanCard({ id: 'c1', title: 'a' })
    createKanbanCard({ id: 'c2', title: 'b' })
    createKanbanCard({ id: 'blocker', title: 'c' })
    addKanbanBlocker('c1', 'blocker')
    addKanbanBlocker('c2', 'blocker')
    const map = getBlockersForAllCards()
    expect(map.get('c1')?.[0].id).toBe('blocker')
    expect(map.get('c2')?.[0].id).toBe('blocker')
    expect(map.has('blocker')).toBe(false)
  })

  it('drops the edges in both directions when a card is deleted', () => {
    // A surviving edge to a deleted card would block its dependent forever:
    // the blocker can never reach done.
    createKanbanCard({ id: 'dependent', title: 'a' })
    createKanbanCard({ id: 'middle', title: 'b' })
    createKanbanCard({ id: 'upstream', title: 'c' })
    addKanbanBlocker('dependent', 'middle')
    addKanbanBlocker('middle', 'upstream')
    deleteKanbanCard('middle')
    const rows = getDb().prepare('SELECT * FROM kanban_card_blockers').all()
    expect(rows).toHaveLength(0)
  })
})

describe('dependencies that could never resolve', () => {
  beforeEach(() => {
    createKanbanCard({ id: 'a', title: 'A' })
    createKanbanCard({ id: 'b', title: 'B' })
  })

  it('refuses a card blocking itself', () => {
    expect(addKanbanBlocker('a', 'a')).toBe('self')
  })

  it('refuses a cycle -- both ends would stay blocked forever', () => {
    expect(addKanbanBlocker('a', 'b')).toBe('added')
    expect(addKanbanBlocker('b', 'a')).toBe('cycle')
    expect(getBlockersForCard('b')).toHaveLength(0)
  })

  it('refuses a longer cycle too', () => {
    createKanbanCard({ id: 'c', title: 'C' })
    addKanbanBlocker('a', 'b')
    addKanbanBlocker('b', 'c')
    expect(wouldCreateBlockerCycle('c', 'a')).toBe(true)
    expect(addKanbanBlocker('c', 'a')).toBe('cycle')
  })

  it('names which side is missing', () => {
    expect(addKanbanBlocker('nosuch', 'b')).toBe('unknown-card')
    expect(addKanbanBlocker('a', 'nosuch')).toBe('unknown-blocker')
  })

  it('removes an edge that was added by mistake', () => {
    addKanbanBlocker('a', 'b')
    expect(removeKanbanBlocker('a', 'b')).toBe(true)
    expect(removeKanbanBlocker('a', 'b')).toBe(false)
  })
})

describe('a blocker stops counting when it is closed', () => {
  beforeEach(() => {
    createKanbanCard({ id: 'dependent', title: 'a' })
    createKanbanCard({ id: 'blocker', title: 'b' })
    addKanbanBlocker('dependent', 'blocker')
  })

  it('done means closed', () => {
    moveKanbanCard('blocker', 'done', 0)
    expect(countOpenBlockers('dependent')).toBe(0)
    expect(getBlockersForCard('dependent')[0].open).toBe(false)
  })

  it('archived means closed too -- it can never reach done', () => {
    archiveKanbanCard('blocker')
    expect(countOpenBlockers('dependent')).toBe(0)
  })

  it('any other column still blocks', () => {
    for (const status of ['planned', 'in_progress', 'testing', 'waiting'] as const) {
      moveKanbanCard('blocker', status, 0)
      expect(countOpenBlockers('dependent')).toBe(1)
    }
  })
})

describe('naming a card the way the fleet writes it', () => {
  it('resolves #seq, bare seq and the hex id', () => {
    createKanbanCard({ id: 'abc12345', title: 'a' })
    const seq = seqOf('abc12345')
    expect(resolveKanbanCardRef(`#${seq}`)).toBe('abc12345')
    expect(resolveKanbanCardRef(String(seq))).toBe('abc12345')
    expect(resolveKanbanCardRef('abc12345')).toBe('abc12345')
    expect(resolveKanbanCardRef('ABC12345')).toBe('abc12345')
  })

  it('returns null for a reference that matches nothing', () => {
    // A typo has to fail at the API boundary; an edge to nowhere would block
    // its card with no card to close.
    expect(resolveKanbanCardRef('#9999')).toBeNull()
    expect(resolveKanbanCardRef('deadbeef')).toBeNull()
    expect(resolveKanbanCardRef('   ')).toBeNull()
  })
})

describe('releasing the cards behind a closed blocker', () => {
  const setup = (dependentStatus: 'waiting' | 'planned' = 'waiting') => {
    createKanbanCard({ id: 'dependent', title: 'start.otthon', status: dependentStatus })
    createKanbanCard({ id: 'blocker', title: 'Tarhely-bovites' })
    addKanbanBlocker('dependent', 'blocker')
  }

  it('comments on the card and moves a parked one back to planned', () => {
    setup('waiting')
    moveKanbanCard('blocker', 'done', 0)
    expect(fireBlockerRelease('blocker')).toEqual(['dependent'])

    const comments = getKanbanComments('dependent')
    expect(comments).toHaveLength(1)
    expect(comments[0].content).toContain('felszabadult')
    expect(getKanbanCard('dependent')!.status).toBe('planned')
  })

  it('leaves a card that was not parked in its column', () => {
    setup('planned')
    moveKanbanCard('blocker', 'done', 0)
    fireBlockerRelease('blocker')
    expect(getKanbanCard('dependent')!.status).toBe('planned')
  })

  it('says nothing while another blocker is still open', () => {
    setup('waiting')
    createKanbanCard({ id: 'other', title: 'masik blokkolo' })
    addKanbanBlocker('dependent', 'other')
    moveKanbanCard('blocker', 'done', 0)

    expect(fireBlockerRelease('blocker')).toEqual([])
    expect(getKanbanComments('dependent')).toHaveLength(0)
    expect(getKanbanCard('dependent')!.status).toBe('waiting')
  })

  it('releases the chain one link at a time', () => {
    // The RR-chain shape: #1 blocks #2 blocks #3. Closing #1 frees #2 only.
    createKanbanCard({ id: 'c1', title: 'elso' })
    createKanbanCard({ id: 'c2', title: 'masodik', status: 'waiting' })
    createKanbanCard({ id: 'c3', title: 'harmadik', status: 'waiting' })
    addKanbanBlocker('c2', 'c1')
    addKanbanBlocker('c3', 'c2')

    moveKanbanCard('c1', 'done', 0)
    expect(fireBlockerRelease('c1')).toEqual(['c2'])
    expect(getKanbanCard('c3')!.status).toBe('waiting')

    moveKanbanCard('c2', 'done', 0)
    expect(fireBlockerRelease('c2')).toEqual(['c3'])
    expect(getKanbanCard('c3')!.status).toBe('planned')
  })

  it('announces the owner own card but leaves its status alone', () => {
    createKanbanCard({ id: 'dependent', title: 'Viktor kartyaja', status: 'waiting', assignee: OWNER_NAME })
    createKanbanCard({ id: 'blocker', title: 'b' })
    addKanbanBlocker('dependent', 'blocker')
    moveKanbanCard('blocker', 'done', 0)

    expect(fireBlockerRelease('blocker')).toEqual(['dependent'])
    expect(getKanbanComments('dependent')).toHaveLength(1)
    expect(getKanbanCard('dependent')!.status).toBe('waiting')
  })

  it('does nothing for a blocker id that does not exist', () => {
    expect(fireBlockerRelease('nosuch')).toEqual([])
  })

  it('never wakes an agent by starting the card itself', () => {
    setup('waiting')
    moveKanbanCard('blocker', 'done', 0)
    fireBlockerRelease('blocker')
    // in_progress would fire the kanban -> agent dispatch; the release only
    // announces, it does not dispatch.
    expect(getKanbanCard('dependent')!.status).not.toBe('in_progress')
    expect(getKanbanCard('dependent')!.dispatched_at).toBeNull()
  })
})

describe('starting a card that is still blocked', () => {
  it('does not wake the assignee, and says why on the card', () => {
    createKanbanCard({ id: 'dependent', title: 'a', assignee: 'prisma' })
    createKanbanCard({ id: 'blocker', title: 'b' })
    addKanbanBlocker('dependent', 'blocker')

    moveKanbanCard('dependent', 'in_progress', 0)
    fireKanbanDispatch('dependent')

    const comments = getKanbanComments('dependent')
    expect(comments).toHaveLength(1)
    expect(comments[0].content).toContain('blokkolt')
    // No dispatch stamp: the agent was not woken, so the wake-up is still
    // owed when the blocker closes.
    expect(getKanbanCard('dependent')!.dispatched_at).toBeNull()
  })

  it('stays out of the way once nothing blocks the card', () => {
    createKanbanCard({ id: 'free', title: 'a', assignee: 'prisma' })
    createKanbanCard({ id: 'blocker', title: 'b' })
    addKanbanBlocker('free', 'blocker')
    moveKanbanCard('blocker', 'done', 0)

    fireKanbanDispatch('free')
    expect(getKanbanComments('free')).toHaveLength(0)
  })
})

describe('taking over the hand-written FUGG markers', () => {
  it('reads the card numbers off a marker', () => {
    expect(parseFuggMarkers('FUGG: #12').refs).toEqual([12])
    expect(parseFuggMarkers('sor\nFUGG: #12, #14\nmasik sor').refs).toEqual([12, 14])
    expect(parseFuggMarkers('  fugg: #7 #7 #9').refs).toEqual([7, 9])
    expect(parseFuggMarkers(null).refs).toEqual([])
  })

  it('reads a marker written mid-sentence', () => {
    // Live board reality: half the markers sit at the end of a paragraph.
    expect(parseFuggMarkers('Nem MVP-tetel, kesobb. FUGG: #27 (App Store bekuldes)').refs).toEqual([27])
  })

  it('ignores a card number that is only mentioned in prose', () => {
    // "#125" in a sentence is a reference, not a gate -- importing it would
    // invent a dependency nobody declared.
    expect(parseFuggMarkers('A #125 utan indul majd.').refs).toEqual([])
  })

  it('does not take a trailing reference as a second dependency', () => {
    expect(parseFuggMarkers('FUGG: #27 (a #31 lezarasa utan indul)').refs).toEqual([27])
  })

  it('hands back a reversed marker instead of importing it backwards', () => {
    // "FUGG: ettol a #202 2. fazisa" says #202 waits for THIS card -- the
    // opposite of "FUGG: #202". Importing it forward would gate the wrong
    // card and auto-move it, so it goes to a human instead.
    const parsed = parseFuggMarkers('FUGG: ettol a #202 2. fazisa (kompozicio-integracio).')
    expect(parsed.refs).toEqual([])
    expect(parsed.ambiguous).toHaveLength(1)
    expect(parsed.ambiguous[0]).toContain('#202')
  })

  it('turns the markers into edges and keeps the human sentence', () => {
    createKanbanCard({ id: 'blocker', title: 'Tarhely-bovites' })
    const blockerSeq = seqOf('blocker')
    const description = `A koltozes utan indulhat.\nFUGG: #${blockerSeq}`
    createKanbanCard({ id: 'dependent', title: 'start.otthon', description })

    const result = importFuggMarkersAsBlockers()
    expect(result).toMatchObject({ edges: 1, cards: 1, unresolved: [], ambiguous: [] })
    expect(getBlockersForCard('dependent').map(b => b.id)).toEqual(['blocker'])
    // The marker was written for a human reader; only the machine-readable
    // half is being added, so the description is left untouched.
    expect(getKanbanCard('dependent')!.description).toBe(description)
  })

  it('reports a marker that points at nothing instead of dropping it', () => {
    createKanbanCard({ id: 'dependent', title: 'a', description: 'FUGG: #9999' })
    const result = importFuggMarkersAsBlockers()
    expect(result.edges).toBe(0)
    expect(result.unresolved).toEqual(['#1 -> #9999'])
  })

  it('reports a reversed marker on the import instead of creating an edge', () => {
    createKanbanCard({ id: 'other', title: 'masik' })
    createKanbanCard({ id: 'dependent', title: 'a', description: `FUGG: ettol a #${seqOf('other')} 2. fazisa.` })
    const result = importFuggMarkersAsBlockers()
    expect(result.edges).toBe(0)
    expect(result.ambiguous).toHaveLength(1)
    expect(getBlockersForCard('dependent')).toHaveLength(0)
  })

  it('runs once per database', () => {
    let runs = 0
    expect(runOnceMigration('test-once', () => { runs++ })).toBe(true)
    expect(runOnceMigration('test-once', () => { runs++ })).toBe(false)
    expect(runs).toBe(1)
  })

  it('retries a migration that threw', () => {
    // A migration that failed did not happen; recording it would lose the
    // backfill for good.
    expect(runOnceMigration('test-throws', () => { throw new Error('boom') })).toBe(false)
    let ran = false
    expect(runOnceMigration('test-throws', () => { ran = true })).toBe(true)
    expect(ran).toBe(true)
  })
})
