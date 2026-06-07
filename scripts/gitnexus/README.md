# GitNexus auto-rebuild hook

Opt-in, per-repo git **post-commit** hook that keeps the GitNexus knowledge graph
fresh automatically — closing the one gap vs Graphify (commit-triggered
self-updating graph) without giving up GitNexus's deeper query/impact layer or
the fleet's existing MCP + skills + hooks integration.

## What it does
After each commit it runs an **incremental** `gitnexus analyze --skip-agents-md`
(NOT `--force`) so:
- the re-index is fast (skip-if-up-to-date; only changed symbols are reprocessed),
- it runs in the **background** → the commit returns instantly,
- a **single-flight lock** (`.gitnexus/.autorebuild.lock`) prevents rapid commits
  from piling up (if a rebuild is running, the commit is skipped and the next
  incremental pass catches up); a **stale-lock guard** reclaims the lock if it is
  older than 15 min, so a `kill -9` mid-rebuild can't permanently disable rebuilds,
- `--skip-agents-md` keeps the working tree clean (only the gitignored
  `.gitnexus/` graph changes; `AGENTS.md` / `CLAUDE.md` are not touched).

Determinism/cost unchanged: GitNexus's default build is embedding-free
(`--embeddings` is opt-in), so the rebuild has zero API cost.

## Install (per repo)
```bash
# from inside the target repo (must already be `gitnexus analyze`-d once):
/Users/marvin/ClaudeClaw/scripts/gitnexus/install-autorebuild.sh
# or for another repo:
/Users/marvin/ClaudeClaw/scripts/gitnexus/install-autorebuild.sh /path/to/repo
```
Idempotent: re-running updates the managed block in place and preserves any
pre-existing `post-commit` hook content.

## New-repo onboarding flow
```bash
cd /path/to/new/repo
gitnexus analyze                       # initial index + AGENTS.md/CLAUDE.md + skills
/Users/marvin/ClaudeClaw/scripts/gitnexus/install-autorebuild.sh
# from now on every commit refreshes the graph in the background
```

## Uninstall
Remove the block between `# >>> gitnexus-autorebuild >>>` and
`# <<< gitnexus-autorebuild <<<` from `.git/hooks/post-commit` (delete the file
if that block was its only content).

## Log
`.gitnexus/autorebuild.log` in the target repo.
