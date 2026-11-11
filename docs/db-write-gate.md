# db-write-gate (APPROVALDBGATE1030)

`scripts/hooks/db-write-gate.mjs` is a PreToolUse gate for every agent, the main agent included. It denies:

1. an SQL write on the dashboard database's security tables (`approvals`, `approval_events`, `auth_sessions`,
   `dashboard_users`, `device_keys`, `vault_ssh_keys`), `PRAGMA writable_schema`, and any write on `sqlite_master` /
   `sqlite_schema`;
2. a file-level write of `store/claudeclaw.db` (and its `-wal`, `-shm`, `-journal`);
3. a write of this install's gate wiring and autonomy levels: `.claude/settings.json`, `.claude/settings.local.json`,
   `scripts/hooks/`, `scripts/self-pace-gate.mjs`, `store/extra-hooks.json`, `store/autonomy-config.json`, the main
   checkout's `.git/config`, `.git/packed-refs`, `.git/refs/remotes/`, `.git/hooks/`, and the user's `~/.gitconfig` and
   `~/.config/git/config`;
   and the owner-gated agent settings the dashboard keeps in `store/` (GATEFILES1110): `store/custom-providers.json`
   (each provider's `baseUrl`) and `store/context-guard.json`. Their API routes are owner-gated; only the dashboard
   writes them;
4. in the install's main checkout, every git subcommand that changes the tree or the refs except
   `git fetch [origin]`, exactly `git pull --ff-only origin <branch>`, and `git checkout -- <paths>` /
   `git restore <paths>` with no ref; everywhere, a write of `refs/remotes/*` and of the config keys that redirect a
   remote or name hooks (`remote.*.url`, `remote.*.pushurl`, `remote.*.fetch`, `core.hooksPath`, `include.path`,
   `includeIf.*`, `url.*.insteadOf`), also through `-c`, `--config-env` and the `GIT_CONFIG_*` environment.

Development happens in a git worktree; the worktree's own copies of these files are not protected.

For a sub-agent only, it also denies a write of the files listed in `SUBAGENT_PROTECTED_INSTALL_PATHS` in the hook
(ENVRELAXGATE1104 and its follow-ups), among them every agent's Telegram inbound-evidence log
(`agents/<name>/.claude/channels/telegram/inbound-evidence.jsonl` and its rotated `.1`, plus the `telegram/` and
`channels/` directories above it as a command's target, TGINREPLAYGATE1104): the inbound replay (`TELEGRAM_INBOUND_REPLAY_ENABLED`, off by default) re-delivers its lines framed as channel messages.
The same list holds every agent's `agents/<name>/agent-config.json` (GATEFILES1110: `customProvider`, `model`,
`oauthTokenFile`), any agent's, not only the caller's own. The main agent's skills write it directly, so it stays free
for the main agent. Renaming a whole `agents/<name>` directory is not judged by this entry (stated limit).
A bare `*` in a sub-agent's own directory reaches that file, so an UNQUOTED glob there is denied (`cp x *`). A QUOTED
argument of a python/node script file is data, its glob no pattern (GATESCRIPTARG1111):
`python3 scripts/supabase-logs.py <ref> "select count(*) ..."` passes, like `sqlite3 x.db "select count(*) ..."`.
Inline code (`-c`, `-e`, `-m`, stdin), a heredoc a script reads, bun/deno and the shell family stay strict, and a
protected path handed to a script is still denied.

**The limit.** This is a text-based brake, not an OS boundary: it reads the command text, and a program that builds a
statement or a path at run time (a script file written earlier, a string assembled in an interpreter) passes. The
owner's approval becomes trustworthy only once GROMZODONTES1030 (F1-F3) moves the decision to the mxd store.

## Vész-helyreállítás

When the install's working tree is broken (a failed update, a half-applied merge, a wrong branch), the agents cannot
repair it themselves any more: `reset`, `checkout <branch>`, `merge`, `rebase` and `stash` are denied in the main
checkout. The repair goes through the owner, in one of two ways.

**1. The owner's own terminal.** Run as the owner, not through an agent:

```bash
cd /Users/marvin/ClaudeClaw          # the install's root
git status                           # what is changed; save anything that should be kept first
git fetch origin
git checkout develop                 # the branch the install runs (develop or main)
git reset --hard origin/develop      # the reviewed tree; untracked files (store/, logs) are not touched
npm ci && npm run build              # only if src/ or package*.json changed
```

Then restart the dashboard the usual way (`claudeclaw-host-update-to-develop`, its restart step).

**2. An approval request, carried out by the owner.** The agent that found the broken tree sends an approval request
(`POST /api/approvals`) whose description holds the exact commands above for this case and why they are needed. The
owner runs them in their own terminal. The gate does not read approvals: an approved request does not let the agent's
own `git reset` through, it only records the owner's decision.

What still works for an agent in the main checkout: `git status`, `git diff`, `git log` and the other reads,
`git fetch origin`, `git pull --ff-only origin <branch>` (a fast-forward from the remote itself), and
`git checkout -- <paths>` / `git restore <paths>` to put back the reviewed content of single files (the host update
skill's clean-up step, after the diff is saved).
