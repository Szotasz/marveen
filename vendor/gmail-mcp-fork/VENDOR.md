# Vendored: ArtyMcLabin/Gmail-MCP-Server (source tree)

- **Upstream**: https://github.com/ArtyMcLabin/Gmail-MCP-Server (MIT)
- **Pinned commit**: `83e8dafebc87dd3e6a26c04acb5ec6e199c1636e` (2026-08-12)
- **Why source, not a bundle**: owner decision 2026-09-07 -- a source tree is
  auditable, a prebuilt dist is not. The dist/ here is built BY US from this
  exact source (`npm ci && npm run build`); anyone can rebuild and diff.
- **Why this fork**: fork of GongRzhe/Gmail-MCP-Server (the package we run
  today), 98 commits ahead, actively maintained. Multi-account model:
  INSTANCE-PER-ACCOUNT via `GMAIL_MCP_TOOL_PREFIX` + per-instance
  `GMAIL_OAUTH_PATH`/`GMAIL_CREDENTIALS_PATH` -- the account lives in the
  tool NAME, so there is no silent default-account fallback to mis-route a
  send (the risk the owner flagged on #1162).
- **Version bumps are never silent**: to lift the pin, repeat the whole path
  -- fetch the new commit, diff the source, rebuild, run the parallel
  verification round (old tools AND new tools working side by side), then
  swap. Same as the original migration (card PR1162VENDOR907 thread).
- **src/evals removed**: upstream's eval harness, not needed at runtime and
  it drags extra dev-deps into audit scope.

Rebuild: `cd vendor/gmail-mcp-fork && npm ci && npm run build`
Run: `run.sh` (installs prod deps on first run, then execs `dist/index.js`).
