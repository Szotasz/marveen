import { logger } from '../logger.js'
import { sweepArchivedKanbanCards } from '../db.js'

// Card 681ab82c. This sweep used to run inside listKanbanCards(), i.e. on every READ of
// the board -- so the act of measuring the kanban changed the kanban. An audit that asked
// "what is on the board" archived cards as a side effect of asking, and the set it then
// reported was not the set that existed a moment earlier.
//
// Moving it here keeps the behaviour and drops the side effect: listKanbanCards() is now a
// pure read, and the archiving happens on a clock instead of on whoever happens to look.
//
// The danger in this change is the opposite one, and it is why the wiring is asserted by a
// test: if the sweep leaves the read path and is not started anywhere, KANBAN_ARCHIVE_DONE_DAYS
// becomes a silent no-op -- nothing fails, cards simply never archive again. That is the same
// failure class the card is about, only inverted.
//
// Hourly, not per-minute: the cutoff is measured in DAYS (default 30), so a finer poll would
// only add wakeups. The first pass is delayed like the neighbouring runners so boot is not a
// burst of work.

const INITIAL_DELAY_MS = 70_000
const INTERVAL_MS = 60 * 60_000

function sweep(): void {
  try {
    const archived = sweepArchivedKanbanCards()
    if (archived > 0) logger.info({ archived }, 'Kanban archive sweep')
  } catch (err) {
    // Never let a maintenance sweep take the process down: it is best-effort and
    // the next tick retries. Silence here would be worse than the sweep failing.
    logger.error({ err }, 'Kanban archive sweep failed')
  }
}

export function startKanbanArchiveRunner(): NodeJS.Timeout {
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
