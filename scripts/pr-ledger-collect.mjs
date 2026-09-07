#!/usr/bin/env node
// PRLEDGER907 -- fleet PR-throughput ledger collector. Idempotent: every run
// upserts closed PRs per (repo, number) and RE-DERIVES is_live on existing
// rows (a release retroactively makes earlier develop merges live). Never
// deletes.
//
// Scope is MEASURED each run (gh repo list), never a hardcoded repo list --
// a new repo must not silently fall out of the ledger.
//
// Pitfalls this encodes (measured 2026-09-07, see the PRLEDGER907 brief):
// - `gh pr list` orders by creation, not merge time: an old-numbered PR
//   merged today drops off a short page. Wide --limit + own date filter,
//   never `--search "merged:>="`.
// - the not-yet-released set comes from the main...develop RANGE (compare
//   API), not from searching main's log.
// - the store DB has concurrent writers: busy_timeout is mandatory.
//
// Usage: node scripts/pr-ledger-collect.mjs [--db <path>] [--owner <login>]

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PR_LEDGER_SCHEMA, UPSERT_FULL_SQL, UPSERT_PRESERVE_LIVE_SQL, isGhNotFound, mapPr, prNumbersFromMessages, decideLive } from './pr-ledger-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'package.json'));
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const DB_PATH = argOf('--db', path.join(here, '..', 'store', 'claudeclaw.db'));
const OWNER = argOf('--owner', 'Szotasz');
// 1000, not 400: the ordering is by CREATION, so in a big repo an old-numbered
// PR merged recently sits deep in the page (the measured #767 case needed
// >400 in marveen already). The window filter happens on our side, by date.
const PR_PAGE_LIMIT = 1000;

function gh(ghArgs) {
  return execFileSync('gh', ghArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// SCOPE RULE (Marveen 21996, the measured mistake behind the snapshot's
// missing repos): the question is NEVER "does the repo have OPEN PRs" --
// hideghivas-oktatas-web had none and was still the period's most active
// repo (116 closed rows). The right question is "did any PR CLOSE there",
// and this collector asks it by construction: it scans EVERY repo of the
// owner and lets the closed-PR listing decide. Do not "optimise" this into
// an open-PR or recently-pushed prefilter; that is the trap.
function listRepos() {
  const raw = gh(['repo', 'list', OWNER, '--limit', '200', '--json', 'name']);
  return JSON.parse(raw).map((r) => r.name);
}

function listClosedPrs(repo) {
  const raw = gh([
    'pr', 'list', '--repo', `${OWNER}/${repo}`, '--state', 'closed',
    '--limit', String(PR_PAGE_LIMIT),
    '--json', 'number,title,author,baseRefName,mergedAt,closedAt,additions,deletions,changedFiles',
  ]);
  return JSON.parse(raw);
}

// The not-yet-released PR set: commit subjects in main...develop. Compare API,
// so no clone is needed (--paginate is load-bearing: the commits[] array is
// capped at 250 per page, and v1.25.1...develop measured 389).
//
// FAILURE SEMANTICS (Marveen review blocker on #1234): an empty set means
// "nothing waits for a release" and flips every develop merge live -- so a
// FAILED measurement must NEVER masquerade as an empty one. The develop
// branch's EXISTENCE is measured separately (branches/develop): a clean 404
// there is the legit no-develop case (empty set, ok). Anything else that
// fails -> { ok: false }, and the caller leaves the stored is_live of that
// repo's develop rows alone.
function unreleasedInfo(repo) {
  try {
    gh(['api', `repos/${OWNER}/${repo}/branches/develop`, '--jq', '.name']);
  } catch (e) {
    if (isGhNotFound(e?.stderr ?? e)) return { ok: true, set: new Set(), noDevelop: true };
    return { ok: false };
  }
  try {
    const raw = gh(['api', `repos/${OWNER}/${repo}/compare/main...develop`, '--paginate', '--jq', '.commits[].commit.message | split("\n")[0]']);
    return { ok: true, set: prNumbersFromMessages(raw.split('\n')) };
  } catch {
    return { ok: false };
  }
}

function main() {
  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 8000');
  db.exec(PR_LEDGER_SCHEMA);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pr_ledger_date ON pr_ledger(closed_date)');

  const upsertFull = db.prepare(UPSERT_FULL_SQL);
  const upsertPreserveLive = db.prepare(UPSERT_PRESERVE_LIVE_SQL);

  const now = Math.floor(Date.now() / 1000);
  const repos = listRepos();
  let written = 0, reposWithPrs = 0;
  const degradedRepos = [];

  for (const repo of repos) {
    let prs;
    try {
      prs = listClosedPrs(repo);
    } catch (e) {
      degradedRepos.push(`${repo}:pr-list`);
      process.stderr.write(`SKIP ${repo}: gh pr list failed: ${String(e).slice(0, 120)}\n`);
      continue;
    }
    if (prs.length === 0) continue;
    reposWithPrs++;
    const unreleased = unreleasedInfo(repo);
    if (!unreleased.ok) degradedRepos.push(`${repo}:unreleased-set`);
    const tx = db.transaction((items) => {
      for (const pr of items) {
        const row = mapPr(repo, pr);
        if (!row) continue;
        if (!unreleased.ok && row.base_branch === 'develop') {
          // Degraded: the release state of develop rows is UNKNOWN this run --
          // update the facts, leave the stored is_live/live_since alone.
          upsertPreserveLive.run({ ...row, measured_at: now });
        } else {
          const live = decideLive(row, unreleased.ok ? unreleased.set : new Set());
          upsertFull.run({ ...row, ...live, measured_at: now });
        }
        written++;
      }
    });
    tx(prs);
    process.stderr.write(`OK ${repo}: ${prs.length} closed PR, unreleased-set ${unreleased.ok ? unreleased.set.size : 'DEGRADED'}\n`);
  }

  const total = db.prepare('SELECT COUNT(*) c FROM pr_ledger').get().c;
  // degraded_repos on STDOUT, not stderr: the daily task's stderr goes unread,
  // and a degraded measurement must be visible where the result is.
  console.log(JSON.stringify({ ok: true, repos_scanned: repos.length, repos_with_prs: reposWithPrs, rows_upserted: written, rows_total: total, degraded_repos: degradedRepos, measured_at: now }));
  db.close();
}

main();
