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
import { PR_LEDGER_SCHEMA, mapPr, prNumbersFromMessages, decideLive } from './pr-ledger-lib.mjs';

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
// so no clone is needed. A repo without a develop branch (or main) simply has
// an empty set -- every one of its merges is judged by its base branch alone.
function unreleasedSet(repo) {
  try {
    const raw = gh(['api', `repos/${OWNER}/${repo}/compare/main...develop`, '--paginate', '--jq', '.commits[].commit.message | split("\n")[0]']);
    return prNumbersFromMessages(raw.split('\n'));
  } catch {
    return new Set();
  }
}

function main() {
  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 8000');
  db.exec(PR_LEDGER_SCHEMA);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pr_ledger_date ON pr_ledger(closed_date)');

  const upsert = db.prepare(`
    INSERT INTO pr_ledger (repo, number, closed_date, base_branch, author, additions, deletions, files, state, title, is_live, live_since, measured_at)
    VALUES (@repo, @number, @closed_date, @base_branch, @author, @additions, @deletions, @files, @state, @title, @is_live, @live_since, @measured_at)
    ON CONFLICT(repo, number) DO UPDATE SET
      closed_date=excluded.closed_date, base_branch=excluded.base_branch,
      author=excluded.author, additions=excluded.additions, deletions=excluded.deletions,
      files=excluded.files, state=excluded.state, title=excluded.title,
      is_live=excluded.is_live, live_since=excluded.live_since, measured_at=excluded.measured_at
  `);

  const now = Math.floor(Date.now() / 1000);
  const repos = listRepos();
  let written = 0, reposWithPrs = 0;

  for (const repo of repos) {
    let prs;
    try {
      prs = listClosedPrs(repo);
    } catch (e) {
      process.stderr.write(`SKIP ${repo}: gh pr list failed: ${String(e).slice(0, 120)}\n`);
      continue;
    }
    if (prs.length === 0) continue;
    reposWithPrs++;
    const unreleased = unreleasedSet(repo);
    const tx = db.transaction((items) => {
      for (const pr of items) {
        const row = mapPr(repo, pr);
        if (!row) continue;
        const live = decideLive(row, unreleased);
        upsert.run({ ...row, ...live, measured_at: now });
        written++;
      }
    });
    tx(prs);
    process.stderr.write(`OK ${repo}: ${prs.length} closed PR, unreleased-set ${unreleased.size}\n`);
  }

  const total = db.prepare('SELECT COUNT(*) c FROM pr_ledger').get().c;
  console.log(JSON.stringify({ ok: true, repos_scanned: repos.length, repos_with_prs: reposWithPrs, rows_upserted: written, rows_total: total, measured_at: now }));
  db.close();
}

main();
