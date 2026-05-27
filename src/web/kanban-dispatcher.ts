import { logger } from '../logger.js'
import {
  getUndispatchedHighPriorityCards,
  markKanbanCardDispatched,
  createAgentMessage,
} from '../db.js'

// Scans for planned high/urgent kanban cards with an assignee and sends each
// one as an inter-agent message. The message-router picks up the DB entry and
// injects it into the target session within 5 seconds.
//
// Cards are marked dispatched_at immediately to prevent re-dispatch on the
// next tick even if the agent hasn't updated the status yet.
export function runKanbanDispatch(): void {
  let candidates
  try {
    candidates = getUndispatchedHighPriorityCards()
  } catch (err) {
    logger.warn({ err }, 'Kanban dispatcher: DB query failed')
    return
  }

  for (const card of candidates) {
    const content = `[Kanban feladat #${card.id}]: ${card.title} -- ${card.description ?? '(nincs leírás)'}`
    try {
      createAgentMessage('marveen', card.assignee, content)
      markKanbanCardDispatched(card.id)
      logger.info({ id: card.id, assignee: card.assignee, priority: card.priority }, 'Kanban card dispatched')
    } catch (err) {
      logger.warn({ err, id: card.id }, 'Kanban dispatcher: failed to dispatch card')
    }
  }
}
