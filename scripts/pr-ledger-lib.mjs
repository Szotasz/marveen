// PRLEDGER907 -- pure logic for the PR ledger collector, split out so vitest
// can exercise the decisions without gh/network. The collector script
// (pr-ledger-collect.mjs) is the I/O shell around these.
//
// SCHEMA NOTE: the CREATE TABLE here must stay in sync with the pr_ledger
// migration in src/db.ts (same dual-writer pattern as conversation_log /
// ledger_lib.py, and the same reason: the collector may run standalone before
// the dashboard process ever migrated, and vice versa). A schema-parity test
// guards the drift.

export const PR_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS pr_ledger (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  closed_date TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  author TEXT,
  additions INTEGER,
  deletions INTEGER,
  files INTEGER,
  state TEXT NOT NULL,
  title TEXT,
  is_live INTEGER NOT NULL DEFAULT 0,
  live_since TEXT,
  measured_at INTEGER NOT NULL,
  UNIQUE(repo, number)
)
`;

/** YYYY-MM-DD (UTC) from a gh ISO timestamp; null when absent. */
export function isoDay(ts) {
  if (!ts || typeof ts !== 'string') return null;
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})T/);
  return m ? m[1] : null;
}

/**
 * Map one `gh pr list --state closed --json ...` item to a ledger row (without
 * is_live, which needs the release measurement). Returns null for PRs that are
 * still open or carry no usable close date.
 */
export function mapPr(repo, pr) {
  const merged = Boolean(pr.mergedAt);
  const closedDate = isoDay(pr.mergedAt) ?? isoDay(pr.closedAt);
  if (!closedDate) return null;
  return {
    repo,
    number: pr.number,
    closed_date: closedDate,
    base_branch: pr.baseRefName ?? '',
    author: pr.author?.login ?? null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    files: pr.changedFiles ?? null,
    state: merged ? 'merged' : 'closed',
    title: pr.title ?? null,
  };
}

/**
 * Extract the "(#N)" PR references from commit message subjects -- the shape a
 * squash/merge commit carries. Used on the main...develop compare range: what
 * appears there has NOT shipped yet.
 */
export function prNumbersFromMessages(messages) {
  const out = new Set();
  for (const msg of messages) {
    for (const m of String(msg ?? '').matchAll(/\(#(\d+)\)/g)) out.add(Number(m[1]));
  }
  return out;
}

/**
 * The is_live decision (the number the whole exercise is about).
 *
 * - merge-mode repos (everything except tag-released ones): a merge to the
 *   release branch (main/master) IS the release -> live. Feature-branch
 *   merges are not.
 * - tag-mode repos (marveen): work merges to develop, RELEASES carry it out.
 *   A develop merge is live UNLESS its number still sits in the
 *   main...develop range (`unreleasedSet`) -- that set is measured, not
 *   assumed. This rule is generic: for repos with no develop branch the
 *   caller passes an empty set and no develop-based PRs exist anyway.
 * - rejected (state 'closed') PRs are never live.
 *
 * live_since is only claimed where it is actually measurable: a main-merge
 * went live the day it merged. A develop merge that shipped via a later
 * release would need the release date -- v1 leaves it NULL rather than guess.
 */
export function decideLive(row, unreleasedSet) {
  if (row.state !== 'merged') return { is_live: 0, live_since: null };
  const base = row.base_branch;
  if (base === 'main' || base === 'master') return { is_live: 1, live_since: row.closed_date };
  if (base === 'develop') {
    return unreleasedSet.has(row.number)
      ? { is_live: 0, live_since: null }
      : { is_live: 1, live_since: null };
  }
  return { is_live: 0, live_since: null };
}

/** Inclusive date-range + optional repo filter, plus the four-number summary. */
export function summarize(rows) {
  let merged = 0, rejected = 0, live = 0;
  for (const r of rows) {
    if (r.state === 'merged') merged++; else rejected++;
    if (r.is_live) live++;
  }
  return { closed: rows.length, merged, rejected, live };
}
