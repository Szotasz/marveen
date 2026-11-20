# db-write-gate (APPROVALDBGATE1030)

`scripts/hooks/db-write-gate.mjs` is a PreToolUse gate for every agent, the main agent included. It denies:

1. an SQL write on the dashboard database's security tables (`approvals`, `approval_events`, `approval_slack_posts`,
   `approval_teams_cards`, `agent_create_specs`, `auth_sessions`, `dashboard_users`, `device_keys`, `vault_ssh_keys`, and the support access tables
   `support_consents` and `support_password_state`), `PRAGMA writable_schema`, and any write on `sqlite_master` /
   `sqlite_schema`;
2. a file-level write of `store/claudeclaw.db` (and its `-wal`, `-shm`, `-journal`);
3. a write of this install's gate wiring and autonomy levels: `.claude/settings.json`, `.claude/settings.local.json`,
   `scripts/hooks/`, `scripts/self-pace-gate.mjs`, `store/extra-hooks.json`, `store/autonomy-config.json`, the main
   checkout's `.git/config`, `.git/packed-refs`, `.git/refs/remotes/`, `.git/hooks/`, and the user's `~/.gitconfig` and
   `~/.config/git/config`;
   and the owner-gated agent settings the dashboard keeps in `store/` (GATEFILES1110): `store/custom-providers.json`
   (each provider's `baseUrl`) and `store/context-guard.json`. Their API routes are owner-gated; only the dashboard
   writes them;
   and the support state of this machine, one folder outside the install tree: `~/.marveen/support` (SUPPORTKULCS1109,
   D5: the narrow token, the group record, the kit with the dispatcher every support line binds, the spool and the run
   folder). Only the support routine writes it (install-kit from the installer and the updater; enable, disable and
   the reconcile from the dashboard), never a tool call;
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

**A file the command writes and then runs** (INSTRWRITEEXEC1105) is judged as the commands it holds. GATEOPENFORMS1118
widened what counts as running it: a copy of it under another name (a copier, a link, a redirect or a pipe that takes
its text), a run behind a wrapper, a leading assignment or a compound command's reserved word, a shell start-up variable
naming it, a program that takes it as its code file through an option (or make's default makefile), its text used as
code through a command substitution, and a run in the directory a wrapper moves to or after a directory change this
gate cannot follow. Text that is only written, copied, read or sent on still passes. GATEPATHNORM1118: the file is the
same file under any spelling of its path (a relative name after a directory change, `./`, `../`, a doubled slash, `/./`,
or an absolute path for a file written by a relative name, and the same for a copy of it): every name a later segment
uses is resolved at the directory that segment runs in. Where that directory cannot be followed, a name with the same
last path part counts.

GATEPATHNORM1118 (a-e) turns the rule around, class by class, instead of listing more programs. A later program that
names the file (any spelling of it: an operand, an option value, an assignment, its stdin) runs it, unless it is a
known reader, a copier, a data transformer, a sender, a file handler (`touch`, `mkdir`, `rm`; `chmod` stays a runner),
the caller's own script or a shell function the command defines, a container, or another host. A copy is followed
through any program that reads the file and writes a redirect (except the caller's own scripts, a container and
another host), through a command substitution only into a printer (`echo`, `printf`), and through `tar -C`, `split`,
a brace or glob source and a symlink to its directory. A variable that holds the file's text (`X=$(cat f)`,
`export X=$(<f)`, `read`/`mapfile`) is code wherever a shell takes it as code: `eval`, a shell's `-c`, a here-string
to a shell, the command word. A spelling built from the command's own literal assignments (`S=/abs; ... $S/a.sh`)
counts as well. All of this acts only when the written text names a protected path.

The caller's own script (a path or a `.sh` name) is no own code when the same command made that program. That covers
a copy, a link, `install`, `tee`, or a redirect of another file's content such as `cat /bin/sh > m`. Its run is judged
like any program's. A script whose text the command writes itself (a heredoc, `echo`/`printf`) keeps the exception:
the run rules read its text, and the data handed to it stays data. On a case-insensitive file system (macOS, Windows)
a case variant of the written file's path is the same file. `$PWD` and `${PWD}` stand for the directory the segment
runs in.

There is one exception to "the data stays data": a wrapper written here whose text runs a positional parameter. That
means `$1`, `"$@"`, `${1}` or `$*` as the command, or after `exec`, `eval`, a shell with its options, `source` or `.`
(for example `exec sh "$@"`). Its arguments are run positions, so handing it the written file runs that file. A
wrapper that only reads or prints its argument (`wc -l "$1"`, `echo "$1"`) does not count. A braced positional with a
modifier (`${1:-x}`, `${1-x}`, `${@}`, `${1#p}`) is the same parameter; a length (`${#1}`) is not. A shell function the
command defines (`f() { ...; }`, `function g { ...; }`) is such a wrapper, its body read as its text. A wrapper that
runs `"$@"` as the command, handed `sh FILE`, is a shell run of FILE and is judged as `sh FILE` directly; handed
`sh -c FILE`, it is not. The braced form may also be two digits (`${10}`) or hold one nested expansion
(`${1:-${2}}`). A function that hands a positional argument to another function the command defines runs what that
function runs (`g() { "$@"; }; f() { g "$@"; }`). A shell option that takes an argument (`-o NAME`, `+o NAME`,
`-O NAME`, `+O NAME`) is not the script word, so `sh -o errexit FILE` runs FILE, as `sh FILE` does. A braced
positional is read however deep its modifier nests (`${1:-${2:-${3}}}`), and a function chain has no depth limit.
bash's `--rcfile RC` and `--init-file RC` take an argument, so the next word is the script; the rc file they name is a
run too (an interactive shell runs it).

**Shell code is a command of its own** (Refs #2974, #2975). The code a command hands to a shell (`sh`/`bash -c`, also
behind a wrapper such as `timeout`, `eval`, `trap`, a nested `-c`, a shell reading a heredoc or a here-string on stdin)
is judged as a command by every rule above, in the caller's own context (its cwd, main agent or sub-agent), down to
eight levels; deeper nesting is denied. So a file-level database write (`bash -c 'rm store/claudeclaw.db'`) is denied
like the same write at the top level, and a `cd` to an unknown directory counts as the install inside the code too
(`bash -c 'cd $X && echo x > scripts/hooks/f'`). A shell with a script operand reads its stdin as the script's data,
not as code (`bash x.sh <<'E' ... E`), unless `-s` is given. The inner code is judged in the cwd the command started
in, not the one an earlier `cd` of the same command moved to.

**The limit.** This is a text-based brake, not an OS boundary: it reads the command text, and a program that builds a
statement or a path at run time (a script file written earlier, a string assembled in an interpreter) passes. A file
written in an earlier Bash call (or with the Write tool) and run in a later one is not read either. What the caller's
own script, a container or another host does with the file is not read: a script that copies it for a later shell, or
a container that mounts the install, passes. The
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
