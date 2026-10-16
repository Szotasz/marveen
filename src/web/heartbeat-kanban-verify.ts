// HBFABRIC1003: the Kanban lines of a heartbeat digest are checked against the
// live board at the moment the digest is sent.
//
// WHY. On 2026-10-03 17:00 the heartbeat agent (an LLM) sent a digest whose
// Kanban section it had typed into a heredoc BEFORE reading its metrics block:
// a card id that never existed (EGRESSFP1003) at the head of the waiting list,
// and counts off by one (waiting 414 / planned 696 against a live 415 / 695).
// Nothing on the board had moved in that hour (EGRESSPHANTOM1003, Boni's
// measurement). The agent noticed 19 seconds later and sent no correction.
// The HBTEMPLATELEAK1002 gate catches a leaked template header, not a made-up
// number; "copy, never compose" (HBMETRICSWIRE910) is an instruction, and this
// is the mechanism behind it.
//
// WHAT IS CHECKED, and only when the message IS a digest (its first line is the
// "## Heartbeat " header, the same definition stampHeartbeatHeader uses):
//   - the numeric `- urgent|in_progress|waiting|planned: N` lines of the
//     "### Kanban" section against the live counts. A line whose value is not a
//     number ("mérési hiba", an instrument error) states nothing, so it is not
//     checked -- an honest "could not measure" must still get through;
//   - every card id listed in parentheses on those lines: it must exist, not be
//     archived, and be in the state its line claims (open urgent / waiting),
//     unless that card moved inside the tolerance window.
//
// THE TOLERANCE IS NOT A FIXED NUMBER. The fabricated counts were off by ONE,
// so a fixed +-2 would have let them through. The board can only drift between
// the agent's metrics read and the send by as many cards as actually moved, so
// the tolerance is the number of cards whose updated_at falls inside the
// window (status, title and archive writes bump it). On 2026-10-03 16:00-17:16
// that number was 0. Known limit: a hard DELETE leaves no updated_at behind;
// deletes are owner-level and rare, and a false refusal is visible and retried.

export const HEARTBEAT_KANBAN_WINDOW_SEC = 15 * 60

export type KanbanCountKey = 'urgent' | 'in_progress' | 'waiting' | 'planned'

export interface ClaimedKanbanLine {
  key: KanbanCountKey
  count: number | null
  ids: string[]
}

const LINE_RE = /^\s*-\s*(urgent|in_progress|waiting|planned)\s*:\s*(.*)$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,}$/

function kanbanSection(content: string): string[] | null {
  const lines = content.split('\n')
  const start = lines.findIndex((l) => /^###\s+Kanban\b/.test(l.trim()))
  if (start < 0) return null
  const out: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(l.trim())) break
    out.push(l)
  }
  return out
}

/** The claims a digest makes about the board. Empty when it has no Kanban section. */
export function parseKanbanClaims(content: string): ClaimedKanbanLine[] {
  const section = kanbanSection(content)
  if (!section) return []
  const claims: ClaimedKanbanLine[] = []
  for (const line of section) {
    const m = LINE_RE.exec(line)
    if (!m) continue
    const key = m[1] as KanbanCountKey
    const rest = m[2]
    const num = /^(\d+)\b/.exec(rest.trim())
    const paren = /\(([^)]*)\)/.exec(rest)
    let ids: string[] = []
    if (paren) {
      // "8 legfrissebb: A, B" -> the ids come after the label's colon.
      const inner = paren[1].includes(':') ? paren[1].slice(paren[1].lastIndexOf(':') + 1) : paren[1]
      ids = inner.split(',').map((s) => s.trim()).filter((s) => ID_RE.test(s))
    }
    claims.push({ key, count: num ? Number(num[1]) : null, ids })
  }
  return claims
}

export interface LiveKanban {
  counts: Record<KanbanCountKey, number>
  /** Cards whose updated_at is inside the window: the allowed drift. */
  movedInWindow: number
  /** null when the card does not exist. */
  card: (id: string) => { status: string; priority: string; archived: boolean; movedInWindow: boolean } | null
}

export type KanbanVerdict = { ok: true } | { ok: false; problems: string[] }

/**
 * `getLive` is called ONLY for a digest that makes a claim: every other message
 * (the vast majority of POST /api/messages) costs no board query at all.
 */
export function verifyHeartbeatKanban(content: string, getLive: () => LiveKanban): KanbanVerdict {
  if (!content.startsWith('## Heartbeat ')) return { ok: true }
  const claims = parseKanbanClaims(content)
  if (!claims.some((c) => c.count !== null || c.ids.length > 0)) return { ok: true }
  const live = getLive()
  const problems: string[] = []
  for (const claim of claims) {
    if (claim.count !== null) {
      const real = live.counts[claim.key]
      if (Math.abs(claim.count - real) > live.movedInWindow) {
        problems.push(`${claim.key}: sent ${claim.count}, live ${real} (tolerance ${live.movedInWindow})`)
      }
    }
    for (const id of claim.ids) {
      const card = live.card(id)
      if (!card) { problems.push(`${claim.key}: card ${id} does not exist`); continue }
      if (card.movedInWindow) continue
      if (card.archived) { problems.push(`${claim.key}: card ${id} is archived`); continue }
      if (claim.key === 'waiting' && card.status !== 'waiting') {
        problems.push(`waiting: card ${id} is ${card.status}, not waiting`)
      } else if (claim.key === 'urgent' && (card.priority !== 'urgent' || card.status === 'done')) {
        problems.push(`urgent: card ${id} is not an open urgent card (${card.priority}/${card.status})`)
      } else if (claim.key === 'in_progress' && card.status !== 'in_progress') {
        problems.push(`in_progress: card ${id} is ${card.status}, not in_progress`)
      } else if (claim.key === 'planned' && card.status !== 'planned') {
        problems.push(`planned: card ${id} is ${card.status}, not planned`)
      }
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true }
}
