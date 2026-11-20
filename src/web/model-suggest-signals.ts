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

/**
 * Scheduled rounds that ACTUALLY REACHED THE MODEL, per day.
 *
 * WHY THIS REPLACES THE CRON SUM: the route used to derive this signal by
 * summing cronFreqPerDay() over every enabled scheduled task. That counts
 * INTENT, not delivery, and the two differ by more than rounding. MEASURED on
 * a live install 2026-10-05: the cron sum said ~752 rounds/day for the main
 * agent, while task_runs for the same 24 hours held 751 rows of which 720 were
 * `skipped-precheck` from a 2-minute watcher that never invokes the model. The
 * delivered figure was 29. The classifier reads >= 10 as "dense heartbeat, a
 * smaller model is enough", so the inflated number argued for a downgrade on
 * the strength of rounds that cost nothing.
 *
 * The error is systematic and one-directional: a precheck-style task is cheap
 * BECAUSE it skips, and every skip inflates the number that claims the agent's
 * work is lightweight.
 *
 * Averaged over a window rather than taken from the last 24h so one quiet or
 * one busy day does not move the recommendation. Agents with no rows in the
 * window are absent from the map: the route distinguishes "no entry"
 * (undefined signal) from a measured zero, and an agent the scheduler has
 * never fired for is the first one.
 */
export const DELIVERED_RUNS_SQL = `SELECT agent, COUNT(*) as cnt
       FROM task_runs
       WHERE status = 'fired' AND ts >= ?
       GROUP BY agent`

/** Window the route passes to DELIVERED_RUNS_SQL, and divides the counts by. */
export const DELIVERED_RUNS_WINDOW_DAYS = 7

export interface DeliveredRunsRow {
  agent: string | null
  cnt: number
}

export function deliveredRunsPerDayMap(
  rows: readonly DeliveredRunsRow[],
  windowDays: number = DELIVERED_RUNS_WINDOW_DAYS,
): Map<string, number> {
  const out = new Map<string, number>()
  const days = windowDays > 0 ? windowDays : 1
  for (const row of rows) {
    if (!row.agent) continue
    out.set(row.agent, (out.get(row.agent) ?? 0) + row.cnt / days)
  }
  return out
}
