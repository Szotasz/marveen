// Pure decision logic for the blocker release (#185).
//
// A card can declare what it waits for (kanban_card_blockers). When one of
// those blockers reaches done, this module decides -- per waiting card --
// whether it is free now, what the card comment should say, and whether the
// card's own status should change. The side effects (comment, status move,
// waking the assignee) are wired in the route layer, the same split
// kanban-dispatch.ts already uses, so the decision tree is unit-tested
// without a db or a tmux session.
//
// Two rules the caller must not soften:
//   - a card with ANOTHER open blocker is NOT released; it stays put and stays
//     quiet, because a "you are free" comment that isn't true is worse than
//     silence.
//   - nothing is ever auto-started. A released card is announced, never moved
//     to in_progress: that would fire the kanban -> agent dispatch and put an
//     agent to work with no human in the loop.

export interface ReleasableCard {
  id: string
  seq?: number
  title: string
  status: 'planned' | 'in_progress' | 'waiting' | 'testing' | 'done'
  assignee: string | null
}

export interface ClosedBlocker {
  id: string
  seq?: number
  title: string
}

export interface ReleaseDecision {
  card: ReleasableCard
  /** The comment to post on the released card. */
  comment: string
  /**
   * A card parked in `waiting` was parked for the blocker; with the gate gone
   * it belongs back in the queue. Any other column is left alone -- a card
   * already in progress needs no move, and moving one would be a status
   * change nobody asked for.
   */
  moveToPlanned: boolean
  /** The card is held by the human owner -- see the guard in decideRelease. */
  ownerHeld: boolean
}

const ref = (c: { seq?: number; id: string }): string => (c.seq ? `#${c.seq}` : `#${c.id}`)

/**
 * Decide what happens to one card whose blocker just closed.
 *
 * `remainingOpenBlockers` counts the card's blockers that are still open AFTER
 * this one closed -- above zero means the card is still gated and gets nothing.
 * A card already done is skipped too: it finished without waiting.
 *
 * An OWNER-held card is announced but never moved (orchestrator's call,
 * 2026-08-02): `waiting` on the owner's own card frequently means something
 * the board cannot see -- a decision they are sitting on, an external
 * dependency -- so the blocker closing is not proof that the wait is over.
 * The agent-held case is different: there the blocker WAS the wait.
 */
export function decideRelease(
  card: ReleasableCard,
  blocker: ClosedBlocker,
  remainingOpenBlockers: number,
  opts: { ownerName: string },
): ReleaseDecision | null {
  if (remainingOpenBlockers > 0) return null
  if (card.status === 'done') return null

  const owner = opts.ownerName.trim().toLowerCase()
  const ownerHeld = Boolean(owner) && (card.assignee ?? '').trim().toLowerCase() === owner
  const moveToPlanned = card.status === 'waiting' && !ownerHeld
  const comment = [
    `A blokkoló ${ref(blocker)} ("${blocker.title}") lezárult -- ez a kártya felszabadult.`,
    moveToPlanned ? 'Státusz: waiting -> planned.' : null,
    ownerHeld && card.status === 'waiting'
      ? 'A státuszt szándékosan hagytam waiting-en: a kártya a tulajdonosnál van, a várakozás mást is jelenthet.'
      : null,
    'Automatikusan NEM indult el. MIELŐTT indítanád, nézd meg a blokkoló KIMENETELÉT: a lezárása azt is jelentheti, hogy ez a kártya okafogyottá vált, és a helyes lépés a lezárás. Ha tényleg indítandó és te viszed, told in_progress-re.',
  ].filter(Boolean).join(' ')

  return { card, comment, moveToPlanned, ownerHeld }
}

/**
 * The wake-up an assigned agent receives. Short on purpose: the card is not
 * started, so this is a notification, not a task dispatch -- the full
 * instruction set arrives from kanbanMoveInstructions if and when the card is
 * actually moved to in_progress.
 */
export function releaseMessage(
  card: ReleasableCard,
  blocker: ClosedBlocker,
  moveCommand: string,
): string {
  return [
    `[Kanban felszabadult ${ref(card)}]: ${card.title}`,
    '',
    `A blokkolója ${ref(blocker)} ("${blocker.title}") lezárult, más nyitott blokkolója nincs.`,
    'A kártya nem indult el magától. ELŐSZÖR a blokkoló kimenetelét olvasd el: az is lehet, hogy ez a kártya ezzel lezárható, nem indítandó. Ha tényleg mehet és a tiéd, told in_progress-re:',
    moveCommand,
  ].join('\n')
}
