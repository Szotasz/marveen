/**
 * The two runtime signals the model-suggest route feeds into the classifier,
 * as pure values instead of inline route code.
 *
 * WHY THIS MODULE EXISTS: both signals were fixed in #1385 (the token sum was
 * cache-blind, the kanban count included done cards), and both fixes were
 * covered only by tests that read routes/agents.ts and matched a regex on it.
 * MEASURED 2026-09-17 on that PR's head: reverting either change turned a test
 * red, but a mutation that KEPT the identifiers and broke the VALUE -- the same
 * sum divided by totalCalls * 1000 -- left all 35 tests green. That is exactly
 * the defect the PR fixed: a real number computed from the wrong place. A pin
 * on the source text cannot see it, because the source text still looks right.
 *
 * So the computation moves here, where a test can assert what it RETURNS, and
 * the kanban filter travels as SQL a test can run against a real table.
 */

/** The fields of getTokenSummary() this signal needs. */
export interface TokenSummaryLike {
  agent: string
  totalCalls: number
  totalInput: number
  totalCacheRead: number
  totalCacheCreation: number
}

/**
 * Average CONTEXT carried per call: input + cache-read + cache-creation.
 *
 * totalInput alone is the UNCACHED remainder. On a long-lived session nearly
 * the whole context arrives as cache reads, so that remainder is a rounding
 * error and the classifier reads a large agent as a tiny one. The error is
 * systematic, not random: the better caching works, the cheaper the agent
 * looks, so the recommendation is smallest for the agents carrying the most.
 *
 * Agents with no calls map to 0 rather than being dropped: the route
 * distinguishes "no entry" (undefined signal) from "measured zero", and a
 * summary row with totalCalls = 0 is the second one.
 */
export function contextAvgPerCallMap(rows: readonly TokenSummaryLike[]): Map<string, number> {
  return new Map(
    rows.map(s => [
      s.agent,
      s.totalCalls > 0
        ? (s.totalInput + s.totalCacheRead + s.totalCacheCreation) / s.totalCalls
        : 0,
    ]),
  )
}

/**
 * Open cards per assignee, by priority.
 *
 * `status <> 'done'` is the point: archived_at IS NULL alone counts finished
 * cards as open, because a done card is archived only by the 7-day sweep (and a
 * level-1 autonomy setting can stop even that). kanbanUrgentCount >= 2 is an
 * Opus signal, so an inflated count feeds the suggestion directly.
 *
 * The SQL is exported so a test can run it against a real table instead of
 * matching it as text: what matters is which ROWS it returns, not how it reads.
 */
export const KANBAN_LOAD_SQL = `SELECT assignee, priority, COUNT(*) as cnt
       FROM kanban_cards
       WHERE archived_at IS NULL AND assignee IS NOT NULL AND status <> 'done'
       GROUP BY assignee, priority`

export interface KanbanLoadRow {
  assignee: string | null
  priority: string
  cnt: number
}

export function kanbanLoadMap(
  rows: readonly KanbanLoadRow[],
): Map<string, { open: number; urgent: number }> {
  const out = new Map<string, { open: number; urgent: number }>()
  for (const row of rows) {
    if (!row.assignee) continue
    const cur = out.get(row.assignee) ?? { open: 0, urgent: 0 }
    cur.open += row.cnt
    if (row.priority === 'urgent' || row.priority === 'high') cur.urgent += row.cnt
    out.set(row.assignee, cur)
  }
  return out
}
