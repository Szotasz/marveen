import { randomBytes } from 'node:crypto'
import { createKanbanCard, listKanbanCards, moveKanbanCard, type KanbanCard } from '../db.js'
import { logger } from '../logger.js'

// Auto-managed kanban cards that mirror an agent's tmux-session lifecycle: a
// card is opened on the "agent-sessions" board when a session starts and moved
// to "done" when it stops. This gives an at-a-glance, persisted view of which
// agents are currently up without polling tmux. All errors are swallowed and
// logged -- session lifecycle must never fail because of a bookkeeping card.

const SESSION_PROJECT = 'agent-sessions'

export interface SessionStartCardFields {
  title: string
  description: string
  status: 'in_progress'
  assignee: string
  priority: 'low'
  project: string
}

function isOpenSessionCard(card: KanbanCard, name: string): boolean {
  return (
    card.project === SESSION_PROJECT &&
    (card.assignee ?? '') === name &&
    card.archived_at == null &&
    card.status !== 'done'
  )
}

export function sessionStartCardFields(
  name: string,
  displayName: string,
  host: string | null
): SessionStartCardFields {
  const where = host ? `remote: ${host}` : 'local'
  return {
    title: `${displayName} session elindult`,
    description: `Auto-kártya: a(z) "${name}" agent tmux session-je elindult (${where}).`,
    status: 'in_progress',
    assignee: name,
    priority: 'low',
    project: SESSION_PROJECT,
  }
}

export function recordSessionStartCard(name: string, host: string | null): void {
  try {
    const existing = listKanbanCards().find((c) => isOpenSessionCard(c, name))
    if (existing) return
    const displayName = name.charAt(0).toUpperCase() + name.slice(1)
    const fields = sessionStartCardFields(name, displayName, host)
    createKanbanCard({ id: randomBytes(4).toString('hex'), ...fields })
  } catch (err) {
    logger.warn({ err, name }, 'failed to record session-start kanban card')
  }
}

export function closeSessionStartCard(name: string): void {
  try {
    const open = listKanbanCards().filter((c) => isOpenSessionCard(c, name))
    for (const card of open) {
      moveKanbanCard(card.id, 'done', card.sort_order)
    }
  } catch (err) {
    logger.warn({ err, name }, 'failed to close session-start kanban card')
  }
}
