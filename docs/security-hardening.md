# Git force-push guard

Marveen agents run autonomously, often with shell access and the ability to push
to git, so a prompt-injected or simply mistaken agent can rewrite shared history.
This guard reduces that blast radius without changing how the fleet works.

## What it does

`scripts/install-git-guard-hook.sh` installs a `pre-push` hook that **refuses a
non-fast-forward (force / rebase / amend) push to `main` or `master`**. Normal
fast-forwards and merge commits pass untouched, and every other ref (`develop`,
feature branches, fork branches, including `--force-with-lease` to those) is
unaffected: only history rewrites of a protected branch are blocked.

It is named `install-*-hook.sh`, so `scripts/sync-hooks.sh` (and the dashboard
update flow) run it automatically. It composes with an existing `pre-push` hook
(e.g. a secret scanner) by moving it under `.git/hooks/pre-push.d/` and adding a
small dispatcher that feeds the ref list to every sub-hook.

```bash
scripts/install-git-guard-hook.sh   # runs automatically on update; manual run also works
```

Override an intentional rewrite of a protected branch:

```bash
ALLOW_FORCE_PUSH=1 git push ...
```

# Outgoing code needs a reviewer-green trace (pre-push)

The owner's rule: code that goes outward (a push, a force-push, an update of a PR branch) goes
only after the reviewer agent's approval; a green test is not enough. The rule used to live in
instruction files and nothing enforced it.

`scripts/install-review-gate-hook.sh` (run by `scripts/sync-hooks.sh`, like the other
installers) copies `scripts/git-hooks/pre-push-review-gate.py` into
`.git/hooks/pre-push.d/30-review-gate`.

**It is opt-in.** The hook is installed on every install, but it does nothing (every push
passes, one stderr line says so) until a reviewer agent is configured. Without that, an install
that has no such agent would have every agent push stopped for good. Set, in the environment of
the push or as a line in `<install>/.env`:

```
REVIEW_GATE_REVIEWER=<agent id of the reviewer>      # unset = gate inactive
REVIEW_GATE_TRACE_WORD=<word that starts the trace>  # optional, default REVIEW-GREEN
```

The `.env` lines are read the way the product's own reader does (trimmed, `#` comments, one pair
of quotes stripped, the last occurrence wins), and a leading `export ` is accepted too: a gate
that reads `export NAME=value` as "not set" would be silently off. A reviewer id or trace word
with characters outside letters, digits, `-` and `_` blocks the push (a gate that is
misconfigured fails closed). For example:
`REVIEW_GATE_REVIEWER=<your reviewer agent>` and `REVIEW_GATE_TRACE_WORD=<your trace word>`.

**It gates agent sessions only** (the owner's decision, 2026-10-11): a push that does not come
from a Claude Code session goes through without a trace, with one line on stderr, so the
owner's own hand push is free.

**Who counts as an agent.** At least one of `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_EXECPATH` is set and non-empty in the environment of the
push. Claude Code sets them for every process its Bash tool starts and git passes the
environment on to the hook (measured from an agent's own shell, 2026-10-11).
`CLAUDE_CONFIG_DIR` is deliberately not a marker: it can be exported in a plain terminal to run
`claude`. This is a "who typed it" guess from the environment, **not an identity**, and it fails
in both directions:

- An agent that unsets the markers (`env -u CLAUDECODE ...`) or pushes from a process that is
  not a Claude Code child walks through, silently. Same class as `--no-verify`; pinned in the
  tests as a documented limit.
- A push the owner types *inside* a Claude Code session (the `!` prefix) carries the markers, so
  it is gated like an agent's. The way through is the logged skip below.

**What counts as the trace.** A message in the fleet mailbox that is from the reviewer agent
(status not `failed`) and contains a line of its own, exactly:

```
<TRACE WORD> <8 to 40 hex digits of the head commit>
```

The hash binds the green to the commit being pushed, so an amend, a rebase or a further commit
on the PR branch needs a new line. Text after the hash, a wrapped or inline mention, a prefix
shorter than 8 digits and a row from another sender do not count. The gate reads
`/api/messages?agent=<reviewer>` (up to 2000 of the reviewer's messages back) with the dashboard
token.

**What needs no trace:** a deletion, and a push that sends no commit the destination lacks
(already on the target remote's tracking refs; for a destination other than `origin`, also
already on `origin`). Anything that cannot be verified (dashboard down, token unreadable, an
answer of an unexpected shape, a ref that does not resolve, git failing) blocks.

**What it is not.** It guards against *forgetting* the rule, not against a deliberate bypass:
the trace is self-declared (one shared bearer token writes any `from_agent`), and
`--no-verify` on the push skips every pre-push hook without leaving a line. Do not read a pass
as proof that the reviewer reviewed the change.

**`core.hooksPath`.** If the repository's `core.hooksPath` points anywhere other than
`.git/hooks`, git never runs this hook. The installer then refuses (non-zero exit, message on
stderr, nothing installed) instead of printing a success line. `sync-hooks.sh` reports the
non-zero exit and carries on.

**Undo.** There is no uninstaller: remove `.git/hooks/pre-push.d/30-review-gate`. Running the
installer again puts it back.

**Earlier development version.** The installer also removes `pre-push.d/30-sam-green-gate`, the file
an earlier development version of this gate was installed as, when it recognises it as this gate's own.

**The way through, only on the owner's explicit instruction for that push:** set
`REVIEW_GATE_SKIP=1` and `REVIEW_GATE_SKIP_REASON="<owner message id>: <why>"` in the
environment of the push command. The reason is mandatory and the call is appended to
`store/push-review-gate-skips.log` (who, when, remote, refs, reason); if the line cannot be
written the push is refused.

# Personal data and repository visibility on the way out

The secret gate asks whether a file holds a credential. This gate asks a different
question of a different object: does the push add **data about a person**, and is the
place it goes **public**? It reuses the same dispatcher (`pre-push.d/`) and the same
runner (`scripts/secret-gate.ts`), so there is one entry point for "may this leave the
host", not a second gate to forget to install.

## What it does

`scripts/install-secret-gate-hook.sh` (run by `scripts/sync-hooks.sh` on update) now also
installs `pre-push.d/15-personal-data-gate`. For every ref a push updates it works out the
commits the remote does not have yet, and scans **the lines each commit adds and its
message** for:

| Detector | What it flags |
|----------|---------------|
| `email` | an address that is not a reserved domain, a no-reply/bot form, a role mailbox (`support@`, `info@`, ...), a synthetic domain (`b.hu`, `pelda.hu`, `ceg.hu`, one/two-letter labels), a system address (service accounts, calendar ids) or a URL's userinfo |
| `local-path` | `/home/<name>`, `/Users/<name>`, `/mnt/c/Users/<name>` (WSL), `C:\Users\<name>` in any case and slash style, and the JSON-escaped form, with an account that is not a placeholder (`u`, `user`, `foo`, `runner`, `$USER`, ...) |
| `phone` | `+36` / `06` Hungarian numbers written with any mix of spaces, brackets, slashes, dots and dashes, and generic `+cc` numbers, minus obviously invented ones, date ranges and counting sequences |
| `iban` | an IBAN whose ISO 13616 mod-97 checksum passes |
| `hu-account`, `hu-taxid` | Hungarian bank-account (8-8, 8-8-8) and tax-number (8-1-2) shapes |
| `denylist` | any term in your **local** denylist (below) |
| `binary` | a binary file in the pushed commits (public or unknown target: blocks unless a reviewed exception names the blob) |

Design points, each one a failure of the mod this replaces:

- **It runs in git, not on the command text.** The hook sees what git is about to
  transmit, so `git push`, `git -C x push`, `HEAD:refs/heads/y`, an alias, a script, or a
  tool that shells out are all the same push. (A check written against the literal
  `git push` string sees only the spellings its author thought of.)
- **Added lines only, per commit.** Deleted and context lines are never scanned, so
  removing personal data is never punished. A line added in one commit and removed in the
  next is still published, so every commit is scanned, not the net diff.
- **Patches are read by hunk length, never by what a line looks like.** An added line that
  begins with `++` is not mistaken for a file header and silently dropped.
- **Record boundaries are a per-run random token** at a line start, not a fixed control
  byte. The matched text is never printed, only file, line and detector.
- **Fail-closed everywhere.** An outgoing set that cannot be computed, a patch git will not
  produce, a denylist rule that does not compile, a malformed exception table: each blocks.
  Binary changes cannot be read by a text detector and are reported as NOT scanned.
- **Visibility only ever raises strictness.** The target is probed *anonymously*
  (`GET api.github.com/repos/<o>/<r>`, no token): `200` + `private:false` is public, `404`
  is "not readable by a stranger" (private), and everything else (rate limit, 5xx,
  timeout, a non-GitHub remote) is *unknown* and treated as **public**. Findings block when
  the target is public or unknown; they only downgrade to a loud warning on a positive
  "private". The probe cannot be switched off with an environment variable.

## Deliberate literals, names, and the audit before a repo goes public

- A reviewed, deliberate literal goes in `PII_EXCEPTIONS` (`src/security/pii-gate.ts`) as a
  **sha256 of the matched text + a written reason**, exactly like the secret gate's fixture
  exceptions: the key is a hash (no line number to go stale, and the literal cannot live in
  the scanner), a changed literal stops matching, and every applied exception is printed.
  There is **no environment override**.
- A **name** is not a shape, so the gate cannot recognise one. Put known names in a
  *local, untracked* file, `<repo>/.git/hooks/pii-denylist.txt` (one per line; `#` comments;
  `re:<pattern>` for a regex). It lives outside the tree on purpose: the names are the data
  being protected. Without the file the gate says so in its output.
- Before a private repository is made public, audit its **whole history**:
  `npx tsx scripts/secret-gate.ts --pii-range <rev-list args>` (for example `--all`).

## Turning the hook off, and what stops that

Every way of making git skip a hook is a way of making this gate off, so the
`destructive-gate` PreToolUse hook denies them for agent sessions:

- `git push --no-verify`, including git's *unambiguous* abbreviations (`--no-veri`; `--no-ver`
  is ambiguous between `--no-verify` and `--no-verbose`, so git itself refuses it), and the
  same resolution for `--force-w`, `--del`, `--mir`, `--prune`. Bundled short flags that contain
  `f` or `d` (`-fu`, `-df`) count as force / delete.
- `core.hooksPath` in **any** git command: `git config core.hooksPath X` (a separate, lasting
  command), `git config --local ...`, `git -c core.hooksPath=X <anything>`, and the
  `GIT_CONFIG_KEY_n` / `GIT_CONFIG_PARAMETERS` environment forms. Reading it (`git config
  core.hooksPath`, `--get`, `get`, `--list`) and *unsetting* it (the repair) stay allowed.
- The **effective value**, not only the spelling. Matching command text is always one writing
  method behind (an alternative config file, `include.path`, a `cd` followed by a relative path
  each got past the first two versions), so before a `git push` the gate asks git itself what
  it would see: `git config --show-origin --get-all core.hooksPath`, with the same `-C` and
  inline environment the push would run with. A value from any source (repo, user, system, an
  included file) is then judged by its **effect**, not by its presence: the gate asks git where
  it would actually look for hooks (`git rev-parse --path-format=absolute --git-path hooks
  --git-common-dir`) and blocks only when the dispatcher is installed in `<common>/hooks` and
  that is not the directory git would use. A repository that never had the gates (a husky
  `.husky/_` hooks path, say) and a checkout whose `core.hooksPath` points at its own
  `.git/hooks` both pass; a dispatcher *copied* to another directory does not, because the
  directory has to match, not the marker line. An answer the gate cannot read (an old git
  without `--path-format`, no repository, an unreadable `pre-push`) blocks, as before.
  `git config include.path` / `includeIf.*` writes are denied
  for the same reason, and so are the variables that move git's config around:
  `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_*`, `XDG_CONFIG_HOME` and a `HOME=`
  placed in front of `git`. (The effective-value query cannot see a file that the *same*
  command creates a moment earlier; the variable rules are what close that.) A relative path
  after a `cd` is resolved against the working directory the gate tracks, so
  `cd .git && printf ... >> config` is judged as the file it is.
- The dispatcher knows which members **must** exist and what they must contain: the installers
  list them with the sha256 of the bytes they wrote in `.git/hooks/pre-push.required`, and a
  listed member that is missing, or whose bytes no longer match, blocks the push, like one that
  cannot run. Deleting a gate file, or replacing it with `exit 0`, no longer makes the dispatcher
  quietly run fewer checks; reinstalling re-records the hash.
- Changing the gate's own files, and every file `core.hooksPath` can be written into: `chmod`,
  `mv`, `rm`, `cp`, `ln`, `sed`, `tee`, `dd`, `truncate`, `find ... -delete/-exec`, a pipe into
  the xargs/parallel family ... on anything under `.git/hooks`, on `.git/config`,
  `config.worktree`, `~/.gitconfig` and `~/.config/git/config`, and shell redirection into any
  of them (`printf ... >> .git/config` is as lasting as `git config core.hooksPath X`).
  Reading stays allowed.
- The dispatcher itself no longer skips a `pre-push.d` member that is present but not
  executable: that is an **error** ("a hook that cannot run is a gate that is off"). Both
  installers write the same dispatcher, and a test pins that they stay identical.

It also denies the *visibility flips* that expose a whole history at once:
`gh repo edit --visibility public|internal`, `gh repo create --public`, and `gh api` PATCH/POST
calls to `repos/<owner>/<repo>` that set `private=false` or `visibility=public`, including the
glued short-flag spellings (`-XPATCH`, `-Fprivate=false`). A body passed with `--input` is
refused because the gate cannot read it.

What the scan itself cannot be talked out of (found by review on the first version): the patches
are produced with `--text --no-textconv --no-ext-diff` and fixed `a/` `b/` prefixes, so a
`diff=` attribute, a `textconv` driver, an external diff driver or `-diff` in `.gitattributes`
cannot hide an added line. A **binary** (a NUL byte in what git would diff) is a *finding* in a
public or unknown target, not a note: an xlsx or a pdf full of personal data must not sail
through. A reviewed binary goes in `PII_EXCEPTIONS` keyed by path and the sha256 of its git
object id. Annotated tag messages are scanned too (nested tags peeled), and when the URL behind a
remote name changes, its old tracking refs stop hiding commits from the scan. The new URL is
recorded (as a hash, in `hooks/pii-gate-remotes.json`) only after a run that let the push go,
so repeating a blocked push unchanged is still scanned in full.

Limits, stated out loud:

- A person at a terminal can still `--no-verify`; the hook protects against mistakes and
  against agents, not against its owner. CI is the check a hook cannot be.
- The destructive-gate reads command text. A quoted string containing a space is data to
  it, so a GraphQL mutation inside `-f query='...'` is not seen. `curl`, `python` or `node`
  calling the GitHub API directly (a PATCH to `repos/<o>/<r>` with `private:false`) is not
  something this gate recognises; it is only as covered as the egress gate covers that script.
  The same goes for any script or interpreter that writes under `.git/hooks` itself.
- A hook runs inside the repository it was installed in. A fresh clone has none, so cloning the
  repository elsewhere and pushing from the clone is not seen by this gate; that is the natural
  edge of any git hook, and the reason CI is the check a hook cannot be.
- Removing the `15-personal-data-gate` member from a hook directory the installers wrote is not
  silent: `pre-push.required` lists it, and a listed member that is missing (or whose bytes no
  longer match the recorded hash) blocks the push. Measured with the installed hook. A checkout
  that was never installed has no manifest and so nothing to compare against; the destructive-gate
  denies the commands that would remove the member, and a re-run of `scripts/sync-hooks.sh`
  restores it.
- The manifest hash covers the members of `.git/hooks/pre-push.d`, not the code they run. The
  `15-personal-data-gate` member executes the install root's own sources (`scripts/secret-gate.ts`,
  `src/security/pii-*.ts`); whoever rewrites those files switches the gate off while the member's
  recorded hash still matches. Editing them is the same class as the interpreter write above.
- The destructive-gate asks git for the effective `core.hooksPath` of the repository the push
  runs in. A push aimed at a different repository through the environment (`export GIT_DIR=...`
  before `git push`) is not that repository's hook problem and is not seen; it is the same edge
  as the fresh-clone limit above.
- Known over-blocking, in the fail-closed direction: commands that only *read* `.git/config` or
  copy `.git/hooks/pre-push` out (`sed -n` on the file, `cp` to a temp path) are denied, and
  `XDG_CONFIG_HOME=` is denied on any command, not only in front of `git`. Measured by review on
  the fleet's recorded commands: zero pure copy-out cases (the `cp` hits were copies *into*
  `.git/hooks`, rightly denied, or sat in a command that also edited the hook), about a dozen pure
  `sed -n` reads, and zero env cases. The copy-out over-block exists, but was only reproduced with
  hand-made probes.
- The detectors know *shapes*. An address written as `name at domain dot com`, a path assembled
  by string concatenation or a number written in words is not seen. The e-mail rules also let
  through role mailboxes and the placeholder domains listed in `pii-gate.ts`; each word in those
  lists is a claim that the thing is not a real organisation.
- The `--remotes=<name>` exclusion trusts the tracking refs under that name. If they are stale
  they make the scan *larger*, never smaller; the URL-change record above covers the one case
  where they describe the wrong repository.
- Measured on the last 150 develop commits (1401 commits, 9 s): after calibration the audit
  flags 83 home-directory lines and 27 addresses, mostly real-looking account names and free-mail
  addresses in test fixtures. That is the `--pii-range` audit, not what a push scans: a push
  scans only the commits the remote does not have. Run `--pii-range` yourself before relying on
  the numbers.

# Bash egress deny rules

`scripts/hooks/egress-gate.mjs` compares a URL against the allowlist, but it is
wired as a `PreToolUse` hook with matcher `WebFetch` **only**. Bash was never
ungated (`outgoing-copy-gate.py` and `email-approval-gate.py` on the main agent,
`email-send-gate.mjs` and `self-pace-gate.mjs` on sub-agents) but none of those
gates looks at the destination host, so a shell `curl` never met the allowlist.
The realistic threat is not a malicious agent: it is a fetched page telling an
agent to run a `curl`, which is why the quarantine-reader exists in the first
place.

## What it does

`BASH_EGRESS_DENY` in `src/web/agent-scaffold.ts` is the single source of truth
for the EGRESS part of `permissions.deny`, and it lands in **every** agent's
`settings.json` by three routes:

- on spawn, via `writeAgentSettingsFromProfile()`,
- on server startup, via `ensureBashEgressDeny()` (existing fleet, and the main
  agent -- see the scope note below),
- on scaffold, via `templates/settings.json.template` (so the next agent created
  starts gated -- a parity test keeps the template and the constant in step).

It is **not** the only list any more: since DENYARGS925 a second constant, the
fleet deny FLOOR, feeds the same block. The two are described together in the
next section, because the difference between them is not what they deny but how
they REACH an agent -- and that is the part that decides what happens when one
of them is edited.

Denied: `curl` to an `https://` URL, and `wget` / `nc` / `ncat` / `telnet`
outright. A `deny` rule is checked **before** the
`--dangerously-skip-permissions` bypass, so it binds on permissive profiles too.
Sanctioned tooling that speaks HTTPS on its own account (`git`, `gh`, `npm`) is
deliberately untouched: denying it would break the release path without closing
anything an agent could not do through it anyway.

The sanctioned route for external content is unchanged: the quarantine-reader
sub-agent, through `WebFetch`, where the domain check already runs. A host being
on the egress allowlist does not open it to the shell.

## Two lists, and why they are not one

Since DENYARGS925 (2026-09-25) `permissions.deny` is fed by TWO constants in
`src/web/agent-scaffold.ts`. Reading either one as "the" deny list is the
mistake this section exists to prevent.

| | `BASH_EGRESS_DENY` | `FLEET_BASELINE_DENY` |
|---|---|---|
| covers | shell URL-fetch verbs: `curl` to `https://`, `wget`, `nc`, `ncat`, `telnet` | the fleet FLOOR: key/credential dirs, `.env`, `sudo`, `rm -rf` of `$HOME` and `/`, force-push (friction only), the unsafe browser-code MCP tool |
| sub-agent gets it | spawn + server-startup migration + scaffold template | **spawn only** (`writeAgentSettingsFromProfile`) |
| main agent gets it | `ensureBashEgressDeny()` into its own config dir | the repo's tracked `.claude/settings.json` (the scaffold never writes the main agent, #1305) |
| parity guarded by | `bash-egress-deny.test.ts` (template vs constant) | `fleet-baseline-deny.test.ts` (shipped file vs constant, both directions) |

Two consequences follow from the row that differs, and both are deliberate:

**The floor has no startup migration.** An agent that is running right now and is
not respawned keeps whatever deny list it started with; the egress rules would be
merged into its file at the next server start, the floor would not. The floor
therefore takes effect at the next spawn, not at the next server restart. This is
the honest limit, not a claim of immediate fleet-wide cover.

**The floor is deliberately NOT in `templates/settings.json.template`.** Measured
2026-09-25: after `scaffoldAgentDir()` the template-derived file carries 10 deny
rules and **zero** of the floor's 13 -- but on the create path
(`routes/agents.ts`) `scaffoldAgentDir()`, `writeAgentModel()`,
`writeAgentSecurityProfile()` and `writeAgentSettingsFromProfile()` are four
SYNCHRONOUS calls with no await and no session launch between them, and on the
spawn path the profile write runs before the Claude Code process starts. So the
template-only state exists on disk but no session reads it, and
`loadProfileTemplate()` cannot throw its way around that: a missing or unparseable
profile falls back to `default` and finally to `HARDCODED_DEFAULT_PROFILE`. The
live fleet agrees: the leanest agent here carries 16 rules, none carries 10.

If a future change adds a route that scaffolds WITHOUT writing the profile
straight after, that reasoning expires and the floor belongs in the template too.
The parity test names this condition so the decision can be re-measured rather
than re-argued.

## Where the main agent's copy goes

The main agent's nominal settings path is the shared user root
(`~/.claude/settings.json`) -- and that same file is the operator's own
interactive Claude Code sessions. The owner's decision (2026-09-07) was that
their own shell stays unrestricted while the fleet stays gated, which makes the
shared file unusable in both directions: writing there restricts the operator,
removing it from there un-gates the main agent, which is the one agent that
reads untrusted web content on the owner's behalf.

Measured way out: when the install gives the main agent a config dir of its own
(`MAIN_AGENT_CONFIG_DIR`, or the provisioned isolated dir behind
`MAIN_AGENT_ISOLATED_CONFIG`), that dir's `settings.json` is the agent's user
scope and the operator's shell does not read it. `bashEgressDenyTargetPath()`
sends the rules there. The separation survives restarts: the provisioner
rebuilds that file from the shared one on every start but keeps keys the shared
file never mentions, and `permissions` is such a key.

When the main agent runs on the shared root there is no scope that covers it
without covering the operator, so **nothing is written** and the startup log
says so. Giving the main agent its own config dir is the fix; picking a side
quietly is not this code's call.

## The trap for whoever measures this next

The two scopes do not behave the same way, and the difference is invisible until
it misleads you (both measured 2026-09-07):

- The **project scope** (`<cwd>/.claude/settings.json` and `settings.local.json`)
  is re-read while a session runs. A rule written there fires immediately, which
  makes it a fine live test bench: drop a narrow, unique rule in, probe it, then
  delete the file.
- The **user scope** (the `settings.json` in the session's `CLAUDE_CONFIG_DIR`)
  is read when the session STARTS and is not re-read afterwards. A rule written
  there while the session runs does nothing at all.

So a probe that works perfectly on the project scope reports a confident
"allowed" on the user scope, and the honest-looking conclusion -- "the rule does
not work" -- is wrong. What it means is "this session has not read it yet".
Measure a user-scope rule from a session that started AFTER the write, or after
the next restart.

The same asymmetry is why a newly written rule binds the main agent from its
next restart rather than immediately.

## Limits, stated out loud

This is a deny list, not a sandbox.

- **The localhost exception is why only `https://` is denied for `curl`.** The
  rule language has no negation and `deny` always beats `allow`, so "any
  `http://` host except localhost" cannot be expressed. A `*http://*` rule would
  also match `http://localhost:3420/...` and mute the whole fleet (memory,
  kanban, message queue, approvals all ride that URL).
- Still open, by construction: plain-http external fetches, an interpreter
  one-liner (`python3 -c`, `node -e`), and a URL hidden in a shell variable.
  Closing those needs a Bash `PreToolUse` hook that parses the command.
- Known collateral: an internal POST whose **double-quoted** payload quotes an
  `https://` URL matches the `curl` rule. Single-quoted payloads do not (the
  permission engine excludes single-quoted content). Use single quotes or
  `-d @file` for such a call.

# What the URL gate does not cover

Both web controls are wired to **one tool**. `scripts/hooks/egress-gate.mjs`
runs as a `PreToolUse` hook with matcher `WebFetch`, and `wrapUntrustedFetch()`
(`src/prompt-safety.ts`) frames what that tool returns. Everything else that
brings the outside world into an agent's context is outside both:

- **`WebSearch`** -- result snippets are external text; no allowlist decided
  which sites they came from. The envelope hook below now frames them on the
  way in (wired by default since MARVEENGAPS1020, on WebSearch and WebFetch);
  nothing filters them.
- **Any MCP server that fetches** -- a browser server (playwright, chrome), a
  docs server, an API connector. The agent's own `curl` is denied by
  `BASH_EGRESS_DENY`, but an MCP server makes the request in its own process,
  where neither control can see it.

This is stated in a comment inside `egress-gate.mjs`. It was not stated here,
which is the wrong place for it to be missing: the comment is read by whoever
edits the gate, this file is read by whoever decides what to install. An
operator adding a browser MCP server was therefore adding an ungated,
unlabelled content path while reading that egress was covered.

The fleet ships no browser by default, so a stock install is unaffected. But
the fleet's own scaffolding expects browsers to appear (the largest profile is
described as "filesystem + playwright + chrome"), so this is a normal
deployment, not an exotic one.

## Why a browser payload is the sharper case

A fetched page cannot run code in the agent; it can only try to talk to it. A
browser payload arrives the same way -- except the browser it arrives through
holds live logged-in sessions, and the agent reading it has a shell, a
filesystem and outbound channels. The realistic attack is not an exploit, it is
a sentence: text on the page addressed to the agent rather than to the reader.

The defence against that is framing, not filtering: content the agent knows is
content cannot impersonate an instruction. `WebFetch` gets that framing from
the wrapper. A browser payload gets none.

## The envelope hook (default on WebSearch and WebFetch, opt-in for browser MCP servers)

`scripts/hooks/browser-content-notice.py` is a `PostToolUse` hook that wraps
browser / search results in an `<untrusted source="..." fetch-nonce="...">`
envelope before the model sees them -- the same framing `wrapUntrustedFetch()`
gives the `WebFetch` path -- scrubs forged security tags out of the payload,
names any injection patterns it matched (forged `<untrusted>` /
`<system-reminder>` envelopes, a pre-injected scrub sentinel, instruction
overrides, credential targets, exfil shapes) and appends the full payload to
`store/browser-content.log` for reading outside the model's context. The log is
capped: past `BROWSER_CONTENT_LOG_MAX_BYTES` (default 10 MiB) it moves to
`browser-content.log.1`, replacing an older one, so at most about twice the cap
is kept; both files are mode 0600, a symlinked log path or lock file
(`browser-content.log.lock`) is refused, and a line that cannot be written
leaves a note in `store/hook-errors.log`.

Since MARVEENGAPS1020 (c) it is **wired by default for `WebSearch` and `WebFetch`**
(for WebFetch too because the allowlist decides which host is reached, not
whether its content can be trusted): in the
repo-shipped `.claude/settings.json` for the main agent, and by the scaffold
(`injectWebSearchEnvelope`, with a startup migration for existing agents) for
every sub-agent. Every agent can call WebSearch: three profiles allow it by
name, and the permissive ones run with the permission bypass. The hook does
nothing until WebSearch or WebFetch is called. Its label tells the agent to read and use
the content's facts and to refuse only its imperatives, so an agent does not
stop on a round whose content was its job (BORITOOLVASAT921).

Two strengths of signal. A forged security frame (`<untrusted>`, `<system-reminder>`,
a directive header, the scrub sentinel, a channel envelope) has no benign reading,
so the label tells the agent to report it to the owner. The content heuristics
(instruction override, role reassignment, agent addressing, credential target,
exfil shape) also match ordinary technical text, such as an install line, a `.env`
step or an `api_key:` field. For those, the label only says not to act on the
content's say-so, and that its facts are usable.

There is no per-agent opt-out: the startup migration re-adds a removed WebSearch
group on the next dashboard start, as it does for the gates. An operator who
wires the envelope under their own matcher that also covers WebSearch (the
browser pattern below) keeps theirs, and no second copy is added.

A browser MCP server is still **not wired by default**, because an install with
no browser gains nothing from it. Operators who run one add its matcher
themselves, in the project `settings.json` or `settings.local.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__playwright__browser_.*|mcp__chrome.*|WebSearch",
        "hooks": [
          {
            "type": "command",
            "command": "python3 -I -S \"$CLAUDE_PROJECT_DIR/scripts/hooks/browser-content-notice.py\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### The shape rule, and the silent fallback behind it

`hookSpecificOutput.updatedToolOutput` replaces a tool result before it reaches
the model. It is not unconditional, and the condition is the important part
(measured 2026-09-20, Claude Code 2.1.278):

- **MCP tool**: a plain string replaced the result outright. The original never
  reached the model.
- **Built-in tool** (`WebSearch`): the replacement must match THAT TOOL'S
  OUTPUT SHAPE. A string was rejected -- `expected: object` -- the harness
  logged `... does not match WebSearch's output shape; using original output`,
  and the raw payload reached the model unchanged.

The rejection is an execution-error record, not part of the tool result, so
**from the model's side a broken envelope is indistinguishable from a working
one**: the content simply arrives unwrapped, as it always did.

That is why the hook writes two layers on every call and never treats the
first as sufficient:

1. `updatedToolOutput` -- the envelope. Shape-preserving: a string stays a
   string, MCP content blocks stay blocks with their original keys, a record
   keeps every key and only its free-text leaves are wrapped. A shape it
   cannot mirror confidently is left alone, because a rejected replacement
   leaves the RAW payload in context -- declining is the safer failure.
2. `additionalContext` -- the label, which cannot be shape-rejected. It states
   that a payload arriving WITHOUT an envelope means the envelope was rejected,
   so the absence is readable rather than invisible.

The label quotes nothing back. Its own text is trusted framing, so echoing a
matched line there would reopen the channel the hook exists to close. Pattern
names and counts only; the payload itself goes to the log.

`envelope_attempted` in the log records which shape the hook tried. It says
"attempted", never "succeeded": the hook cannot observe the harness's decision,
and a field that claimed success would be the most misleading line in the file.

# Email approvals consumed on the send path

At `email_send` level 2 an approval authorizes ONE letter: `content_hash` pins
it to the exact envelope and `consumed_at` makes it one-shot. The gate
(`scripts/hooks/email-approval-gate.py`) flips `consumed_at` itself, but only
for a send it can read in the command text (an MCP mail tool, an inline mailer
call). A tool that mails through a script on another host,
for example `ssh <host> 'tsx send-letter.mjs'`, is invisible to it, so its
approval stayed unconsumed and could authorize a second send.

This project's own senders (`scripts/support-mail/send.py`,
`scripts/graph-mail.ts`) do the same without the endpoint: they run
`scripts/hooks/sender_check.py` on the envelope they are about to deliver,
which consumes the approval of THAT envelope with the gate's own one-shot
update (and applies the standing-recipient list and level 1 / 3 the same
way). The gate therefore does not consume for them: a literal call of one of
them passes the hook at level 2, any other spelling of them is denied without
consuming and without an anchor, and the sender's refusal prints the anchor
to approve.

Any other tool consumes on its own path, right BEFORE the letter goes out, and
sends only on a yes:

```bash
python3 scripts/approval-consume.py --id <approval id> --content-hash <anchor> \
  --consumer <tool name> --message-id '<id@your.domain>' || exit 1   # 0 = send now
```

`POST /api/approvals/<id>/consume` is one conditional write (approved,
`email_send`, unconsumed, the same anchor, inside the fixed 1800 s window,
the same as the gate's; no environment variable changes it). Of two attempts exactly one gets 200; the other gets
409 with a reason (`already_consumed`, `not_approved`, `hash_mismatch`,
`expired`, `wrong_category`). The row records the consumer and the Message-Id
the tool generated up front (`consumed_by`, `consumed_ref`), and every call,
refused ones included, leaves a row in `approval_events`. The gate and the
endpoint read the same `consumed_at IS NULL`, so a letter consumed by one path
is refused by the other.

A 409 means: do not send, and check the sent mailbox before deciding anything,
because the earlier attempt may already have gone out.

# Approving takes the owner's session

Approving a request (`PATCH /api/approvals/<id>` with `status=approved`, and the born-approved
`POST /api/approvals` with `owner_approved_message_id`) goes through the same predicate as issuing
credentials (`mayActAsOwner`, #2163): the owner's dashboard session, also when the browser
sends the stored access token alongside it; the bare token never, not even before the first dashboard
login exists (OWNERGATE4-1104: the 403 then carries `setup_required: true`). The shared token, which every agent holds, can still file a request and resolve it as
`rejected` or `timeout` (that only cancels it), but no longer approve one: measured before, with it
any agent made its own letter approved and the email gate let it through (kanban 80d0e3c6). A
device key is not an owner session, whatever its scope.

What the owner sees:
- A browser that came in with `?token=` or through the mobile QR now gets a "Sign in with the
  dashboard password" button (Settings, Security): it drops the stored token, and from then on the
  browser runs on the owner's session, so approving from it works.
- A Telegram "YES <id>" (or "IGEN <id>") reply no longer closes an approval: the agent sends the
  owner to the dashboard instead.

# Memory delete needs an approval (data_delete)

`DELETE /api/memories/:id` is final: the row's versions are purged with it. The
autonomy config ships `data_delete` at level 1, locked, but until this change no
code read that level; only the tier guard stood in the way, and the caller could
pass it with `?confirm_overwrite=1`.

Now the route reads the level (`src/web/autonomy-level.ts`; a missing config or
key reads as level 1):

- **Level 3**: the delete runs as before, with the tier guard.
- **Level 1 or 2**: the delete runs only with `?approval_id=<id>` of an approved,
  unused `data_delete` approval bound to this memory in its current content state.
  Without one the server files the request itself, on the same path as
  `POST /api/approvals`: the owner is notified, and the description is worded by
  the server from the row (id, owner, tier, length, the first 160 characters),
  not by the caller. The answer is `409 approval_required` with the approval id,
  so a script never reads the request as done. A retry gets the same open
  request back instead of a new one.
- The approval is consumed once, inside the same window as an email approval
  (a fixed 1800 s from the approval). An edit to the memory
  after the approval changes the anchor, and the approval no longer deletes it.
- The anchor is the memory id plus its content version. A row deleted and later
  restored with the same id and the same content (a DB restore, a re-import)
  has the same anchor again; the approval that deleted it is already consumed,
  so it cannot delete the restored row, and a fresh request is filed instead.

Considered and not chosen: turning the delete into an archive (a soft delete).
That would keep the data, but it is a different feature with its own readers
(every list and search would have to skip archived rows). The approval keeps
the delete what it is and puts the decision where the config says it belongs.

**Limit:** the approval can be resolved by any holder of the shared dashboard
token, as every approval can today, so an agent could approve its own request.
"Only a human may delete" needs the per-agent identity decision (#1985) first.

# New skills wait for approval (skill quarantine)

A skill is an instruction set, and the global root `~/.claude/skills` is loaded
by every agent of the fleet. Four dashboard routes bring new skill content in:

- `POST /api/skills` (an LLM-generated `SKILL.md`, global);
- `POST /api/skills/import` (an uploaded `.skill` / zip archive, global);
- `POST /api/agents/:name/skills` and `POST /api/agents/:name/skills/import`
  (the same, for one agent's own root).

Until this change all four made the content live at once. The import checked
only the structure (path traversal, a name clash, symlinks, a `SKILL.md`
somewhere), never the text or the scripts shipped with it.

Now all four write into `store/skills-pending/<id>/`, outside every skill root,
so a pending skill is inert: no agent loads it. It goes live only when it is
approved on the dashboard's Skills page, which shows first:

- where it will land, named plainly: global means the whole fleet loads it
  (a skill queued for the main agent is global, because its root is the global
  one);
- every file IN FULL: the text of every file, losslessly (control bytes such as
  NUL, and bytes that are not UTF-8, appear as `<0xNN>`; C1 controls and the
  U+2028/U+2029 separators as `<U+XXXX>`; all of them flagged), the size and
  sha256 of every file, and whether it is executable, with scripts, binaries and
  executables listed first. An image is shown by size and sha256 only, and a
  file counts as an image by its first bytes (PNG, JPEG, GIF, WEBP, BMP, ICO,
  matching its extension), not by its name: a text file named `logo.png` is
  shown and scanned as text. The readable runs between a real image's bytes
  (at least 8 printable characters; a control byte such as NUL is skipped, not
  a break, so text spelled out between NULs or as UTF-16LE is one run) are
  shown under the file and scanned, because `cat` hands them to the model;
  a line break stays a line break, so each line is scanned on its own. Text drawn
  inside a real image is not shown. A PDF
  (the model reads its text) and a compiled program (ELF, PE, Mach-O) cannot be
  reviewed there, so a skill that carries one cannot be approved from the
  dashboard;
- the scan findings: invisible Unicode (zero-width and tag characters), forged
  security envelopes and directive headers, instruction overrides, credential
  targets, exfil and pipe-to-shell shapes, decode-and-run, shell exec,
  persistence targets (settings, scheduled tasks, shell rc files), install
  hooks and long encoded blobs;
- the `SKILL.md` text.

The approval is bound to the hash of that content and of the name and target
shown (`meta.json` is inside the hash): a file added, removed or changed, or the
target edited, after the listing makes the approval fail (409), and a symlink
planted into the pending skill blocks it. A skill over the review bounds (300
files or 8 MiB) cannot be shown in full, so it cannot be approved from the
dashboard.

**The scan is a triage list, not a verdict.** No text filter is a security
boundary for prompt injection (see the SKILLSCAN824 research). An empty findings
list means the filter found no known shape, not that the skill is safe. The
load-bearing control is that nothing goes live without the approval.

A fifth route, `POST /api/skills/propose`, is how an agent offers a skill to the
whole fleet: it sends a complete `SKILL.md`, which is queued for the global root
like the others. If that name is already live, the proposal is a replacement:
its `SKILL.md` replaces the live one and the live skill's other files are copied
into the proposal, so the approver sees (and the hash binds) the whole directory
that goes live; the approver is also shown the current `SKILL.md`, the approval
fails if the live skill changed since it was proposed, and on approval the old
version is moved to `store/skills-replaced/` first. Proposing needs only the
dashboard token; approving needs the owner's session, as for every pending skill.
When the backup area and the skill root are on different filesystems, the
move is a copy and a remove: the live skill is re-hashed after the copy and
removed only if it did not change, so a write that lands in the short window
between that check and the remove would be lost. That is a stated limit, not a
boundary: the same OS user can write `~/.claude/skills` directly anyway.

An agent's OWN skill folder (its working directory's `.claude/skills`) is left
outside the quarantine on purpose: only that agent loads it, and it already
writes anything else in its own directory with its file tools, so a queue there
would add a click without adding a boundary. The shipped instructions tell every
agent to write its own skills there and to propose everything global. That is an
instruction, not a control: the same OS user can still write `~/.claude/skills`.
The main agent has no private folder (its working directory is the project root,
which every sub-agent sees), so its instructions always propose.

**Not covered, stated out loud:**

- An agent writing a skill directory directly with its file tools. All agents
  run as one OS user. The shipped instructions keep direct writes to the
  agent's own folder and send everything global through
  `POST /api/skills/propose`, but nothing stops a direct write to
  `~/.claude/skills`.
- The fleet import, the agent-bundle import and the `skill` CLI, which have
  their own paths.
- Editing a live skill's `SKILL.md` through `PUT /api/skills/:name` (a follow-up
  PR puts it through the same queue).
- Who approves. The approve and reject routes take the owner's browser session;
  the shared dashboard token every agent holds is refused, except before the
  first dashboard login exists. On such an install an agent could approve its
  own proposal, so log in once before relying on the queue.

# A second reviewer for high-risk tool calls (opt-in)

A security profile can set `"secondReviewer": true`. A sub-agent rendered from
that profile gets `scripts/hooks/second-reviewer-gate.py` as a `PreToolUse`
hook on Bash and on MCP tools. The main agent never gets it, and no shipped
profile sets the flag: every reviewed call costs a model call, so turning it on
is the operator's decision. Switching it off later removes the hook from an
agent at its next respawn or at the next dashboard start. Until then that
agent's high-risk calls are stopped: the route answers a caller whose profile
does not set the flag like an unknown route (404), and the hook is fail-closed.

The hook reviews only high-risk shapes and lets everything else through
untouched: a Bash command that deletes recursively, pushes, resets hard,
uploads or posts with curl or wget, opens ssh/scp/rsync, uses sudo, changes
ownership or modes recursively, wipes a disk, edits the crontab, kills
processes, removes containers or drops tables; an MCP tool whose name says it
sends, replies, posts, publishes, forwards, deletes, removes, transfers, pays,
shares or invites. These patterns are a triage of what is worth a review, not a
boundary.

For such a call the hook asks `POST /api/review-action`. The server gives the
call, wrapped as untrusted data, to a model with a fixed prompt, for at most 45
seconds. `allow` lets the call run; `deny` stops it with the reviewer's reason.
Anything else (an `ask` verdict, a timeout, a frozen fleet, an answer that does
not parse) files an approval for the owner (category `second_review`) and stops
the call. Once the owner approved it, the same call goes through once. "The
same call" means the same agent, tool and effect: for Bash the command only
(the tool input's model-written description changes on every retry), for any
other tool its whole input. A call whose effect is longer than 4 000
characters is denied without a review: the reviewer and the owner must both
see the whole call they decide on. The hook is fail-closed: if the dashboard cannot be
reached, the call is stopped.

What it is not: a model is not a security boundary. The reviewer sees only the
call, not the task, and can only say no or ask; it never widens what an agent
may do. An agent that runs as the same OS user can still act outside its tool
calls.

# Vault reads go through the dashboard (a trail and an opt-in allowlist)

The two resolver scripts that hand secrets to MCP servers
(`scripts/vault-resolve.mjs` for env bindings, `scripts/vault-headers-helper.mjs`
for header bindings) used to decrypt the vault inside the agent's own process.
They now ask the dashboard (`POST /api/vault/resolve`), so every read leaves a
row in the dashboard's vault log: which secret, which agent claimed to ask
(`X-Agent-Id`, taken from the launcher's environment or from the agent's
working directory), and what the allowlist said.

`VAULT_ACL_MODE` (Settings, audit module) decides what the allowlist
(`store/vault-acl.json`, `{ "<secret-id>": ["agent", ...] }`) does. The dashboard and the scripts read it the same way:
the Settings page value, else the `.env` line, else `audit`; a `VAULT_ACL_MODE=enforce` in the process environment also
enforces and cannot be undone from the Settings page. The `.env` line counts only when it tightens (`enforce`): like
every security key, VAULT_ACL_MODE is overrides-only (ENVRELAXGATE1104), and loosening it is the Settings page's,
behind the owner login. Each side reads only its own process environment, so set the
mode on the Settings page or in `.env`, where the dashboard and the scripts both see it. A change takes effect on the
next read, without a restart:

- `audit` (the default): nothing is refused; every read is logged. If the
  dashboard cannot be reached, the scripts print a warning and resolve locally,
  so that read is not in the log.
- `enforce`: a caller that claims an agent name gets a secret only if the
  allowlist lists that agent for it, through the scripts and through
  `GET /api/vault/:id`. If the dashboard cannot be reached, the scripts stop
  with exit code 5 and resolve nothing, so the MCP server does not start.
  That includes a dashboard restart: an MCP server launched while the
  dashboard is down does not start. This fail-closed is deliberate; know it
  before you switch `enforce` on.

A sub-agent's OWN token (`AGENT_TOKENS`, `docs/agens-azonositas-api.md`) is not governed by `VAULT_ACL_MODE`: the
claim it decides about is self-asserted, the own token is authenticated. It has its own switch,
`VAULT_ACL_AGENT_MODE` (VAULTSZELES826):

- `enforce` (the default): the token reads only the secrets the allowlist lists for that agent. An empty or missing
  file means no secret value at all.
- `audit`: the observation week before the list exists. Every read passes and leaves the same log row, with the
  allowlist's verdict (`acl`) and `agent_mode: "audit"`; `scripts/vault-acl-suggest.mjs` turns the week's rows into a
  proposed `store/vault-acl.json` (printed, never written: the owner approves the list). Setting `audit` loosens, so
  it is overrides-only and needs the owner login, like `VAULT_ACL_MODE`.

In both positions SSH material and the vault's own sub-resources are refused to a sub-agent token.

What it is not: isolation. Every agent runs as the same OS user and can read
the master-key file, the agent name is claimed, not authenticated, a caller
that claims no name is treated as the owner, and in `audit` mode the local
fallback is a way around the trail. It is a record of who read what, and an
access rule that holds for agents that follow the shipped paths.

Two consequences worth knowing: the auth gate drops an `X-Agent-Id` that does
not name a registered agent, so such a caller is an owner lane and is never
refused; and `resolve` is now a sub-route like `bindings` and `sync`, so a
secret whose id is literally `resolve` can no longer be read or deleted
through `GET` / `DELETE /api/vault/:id`. A dashboard token file that exists
but is empty, unreadable or malformed counts as an unreachable dashboard
(a warning in `audit`, exit 5 in `enforce`), not as "no dashboard". An id that cannot be sent (empty, or longer than 200
characters) counts as missing; only in `audit` mode with no dashboard token file is it looked up locally.

# Fleet import takes over only the identity keys

`POST /api/fleet/import?apply=true` makes the target install adopt the source's
main-agent identity: it writes the identity into `store/config-overrides.json`
and mirrors it into `.env`, because `scripts/channels.sh` reads `MAIN_AGENT_ID`
and `CHANNEL_PROVIDER` from `.env` directly.

Until FLEETIMPORTENVKEY1021 the takeover copied every key of
`mainAgent.identity`. The import is reachable with the fleet's one shared
dashboard token, and `.env` also holds keys that decide what an agent may do,
so one import call could set any of them.

What happens now:

- Only the keys the export writes are taken over: `MAIN_AGENT_ID`, `BOT_NAME`,
  `BRAND_NAME`, `OWNER_NAME`, `CHANNEL_PROVIDER` (`FLEET_IDENTITY_KEYS` in
  `src/web/fleet-transfer.ts`). The same set goes into both files.
- A value with a control character is left out, not cleaned. `.env` values are
  written unquoted, one per line, so a line break would start a line of the
  file's choosing. If `MAIN_AGENT_ID` is left out, nothing is taken over.
- Every key that is left out is named in a warning, in the dry run and in the
  apply result.
- `updateEnvFile` itself refuses a value with CR, LF or NUL, and a key that is
  not a plain env name, before it reads the file.
- The identity is checked against the target (FLEETIMPORTFOLLOW1021), in the
  dry run and the apply alike. `MAIN_AGENT_ID` must have the installer's slug
  shape and must not be the name of a sub-agent, on the target or in the same
  import; otherwise nothing is taken over. `CHANNEL_PROVIDER` is taken over only
  when the target already holds a token for that channel (the import carries
  none), or when it is the target's own provider; otherwise that key alone is
  left out, with a warning.
- `MAIN_AGENT_ID` must also not be an id the message layer owns
  (FLEETRESERVEDNAME1021, `RESERVED_AGENT_IDS` in `src/config.ts`, the fixed
  part in `src/web/sanitize.ts`): `system` is refused on every POST, so a main
  agent with that id could not send, and the voice channel id
  (`VOICE_CHANNEL_ID`, `hanna` by default) is accepted only from a device key
  and framed as the owner; the id in effect is the reserved one, and none is
  when the voice lane is off (even `hanna` names another sender).
  A SUB-agent under a reserved id is refused on every path that creates one:
  `POST /api/agents` (409), the agent bundle import (a single bundle is
  refused, a fleet bundle skips that agent with a reason), and the fleet
  transfer import (`validateNames`, before the dry run or any write).
  `scripts/migrate-main-agent-id.sh` refuses the same ids, a `BOT_NAME`
  whose id is already a sub-agent, and a migration that would move the voice
  channel id (it is resolved again against the new main agent id), before it
  stops anything. The installers
  (`install-macos.sh`, `install-linux.sh`) derive the id from `BOT_NAME`
  without this check.

**Not covered, stated out loud:** on a single-user host an agent whose Bash is
permissive can write `.env` directly. Closing that needs the per-agent identity
decision (#1985) and per-agent OS users, not this filter. (The rest of the
import no longer runs on the shared token once a login exists: see the next
section.)

# Fleet transfer: the applied import and the vault export take the owner

FLEETIMPORTGATE1022. The fleet's one shared dashboard token reaches
`/api/fleet/*` from every agent, and two of those calls were wider than the
token should reach:

- `POST /api/fleet/import?apply=true` overwrites `store/autonomy-config.json`
  from the payload, `maxLevel` included. With `email_send` at 3 the mail
  approval gate (`scripts/hooks/email-approval-gate.py`) lets every send
  through; measured in a throwaway store: level 2 denies, level 3 allows. The
  same call writes the agents' settings and the global skills.
- `GET /api/fleet/export` with an `X-Vault-Password` returns the vault's master
  key and every secret, encrypted with a password the CALLER chose, so the
  caller can open it.

Both take the owner's session, also before the first dashboard login exists
(`mayActAsOwner`, the owner gate since DEVKEYMINT1022; OWNERGATE4-1104), checked before the body is read or anything is exported; any
other caller gets 403 `owner_session_required`. A full device key is refused
too. The dry run (no `apply`, writes nothing) and the export without a vault
password (no secret; it refuses rather than leak one) stay on the token. On a
fresh install with no dashboard user yet, the token keeps both for the setup.

Related, not changed here: `POST /api/autonomy` raises a level with the token
too, up to the category's `maxLevel` (a locked category stays at 1).

# Sub-agent mail gate: sender scripts under any name

`scripts/email-send-gate.mjs` (sub-agents only) denies every Bash send it
recognises. `isSendInvocation` recognises a Python sender only by the name
`send.py`, so a self-written SMTP script under any other name
(`python3 helden_send.py --to x@y < body.txt`) was no send for it.

`gateDecision` therefore also runs `scriptRunSends` on the Bash path
(SCRIPTSENDGATE1020). A run is a send when:

- **An address flag.** An interpreter (python, node, tsx, bun, deno) or a
  directly executed script is given an e-mail address after `--to`, `--cc` or
  `--bcc`. This also holds when no script file is named (`python3 -m pkg`,
  `python3 -c ...`). A Telegram chat id after `--to` is not an address.
- **A mail-library import in the script.** The script file is resolved against
  the hook payload `cwd` and read up to 1 MiB. It imports a mail library:
  - an `import` / `from ... import` of `smtplib`, `aiosmtplib` or `yagmail`
    (or `importlib.import_module` of one) in a python script;
  - a `require` / `import` of `nodemailer` in a node script.

  A bare mention of the name is no import: a comment, a mock
  (`send.smtplib.SMTP_SSL = ...`) or a regex. So this gate's own source, a test
  that mocks the library and a config that names it are not denied.
- **A helper that imports one.** One level of local helper modules imports a
  mail library. Helpers are the modules the script imports, resolved next to
  it (`from mailhelper import send_mail` reads `mailhelper.py`; `./mh.js` for
  node).
- **A shell `-c` string.** The string of `sh`, `bash`, `zsh` or `dash -c`
  (also `-lc`, `-ec`) runs one of the above.

A directly executed file (`./x`, `/abs/x`, `x.py`) is read as python or node by
its `#!` line (`#!/usr/bin/env python3`, `#!/usr/bin/env -S node`), else by its
extension. An extensionless file without a python or node `#!` line is not
judged.

The check is deliberately not part of `isSendInvocation`. That function is the
contract shared with the main agent's Python gates (`send-invocation-cases.json`),
and the main agent's `email_send` approval gate keeps its current reach.

**Known limits.** These are allowed, so do not read the gate as complete:

- **Mail sent without one of these libraries:**
  - the Gmail API client (`users().messages().send`);
  - an HTTP mail API through `requests.post` or `fetch`;
  - raw `socket` / `ssl` SMTP;
  - `perl` Net::SMTP and `ruby` net/smtp.
- **Script sources the gate does not read:**
  - a script read from stdin (`python3 < smtp_send.py`);
  - a script path through a variable (`"$PWD/x.py"`, `$S`);
  - a module run with `-m` and no address flag;
  - an import after the first 1 MiB of the file.
- **Reach:**
  - helpers past the first level;
  - code assembled at runtime.
- **Closed since (JSCDSEND1104):** a script started after `cd dir &&` (or
  `env -C dir`, `sudo -D dir`, `pushd dir`) is resolved under `dir` too. When
  the run is addressed (`--to`/`--cc`/`--bcc` or an e-mail address in the
  command), an undecidable `cd` (also `cd $(...)`), path or `-m`, and a missing
  script are a send on this gate; without an address they are not, so a
  developer's `cd $WT && python3 -m pytest` passes. A readable script that
  sends is a send either way. The main agent's approval gate keeps those
  branches fail-closed on every run (a false positive there is an approval
  request, not a denial). Both gates' script-run judgement runs on one shared
  table (`scripts/hooks/script-run-cases.json`), which holds both verdicts per
  row.

# Autonomy levels: a raise takes the owner

FLEETIMPORTGATE1022 (4). `POST /api/autonomy` raised any unlocked category up
to its `maxLevel` with the fleet's one shared dashboard token, so any agent
could set `email_send` to 3, and at 3 the mail approval gate
(`scripts/hooks/email-approval-gate.py`) lets every send through. Once a
dashboard login exists, a raise takes the owner's session
(`mayActAsOwner`; OWNERGATE4-1104: also before the first login); any other caller, a full device key included, gets
403 `owner_session_required` and nothing is written. Lowering and setting the
same level stay on the token: they only narrow what an agent may do. A current
level that is not a number counts as a raise. On a fresh install with no
dashboard user yet, the token keeps raising for the setup. The locked
categories and `maxLevel` are checked as before.

**Not covered, stated out loud:** an agent that can write files can still edit
`store/autonomy-config.json` directly, and the mail gate reads the file, not
this endpoint. This change closes the token path only; a write guard for that
file is separate work.

# Vault resolver: only a loopback dashboard

VAULTURLGATE1027. `scripts/vault-dashboard-client.mjs` sends the dashboard
token with every resolve request, and `VAULT_RESOLVE_URL` comes from the
environment. The URL is checked before the request is built: `http` or
`https`, no user info, and the host `127.0.0.1`, `::1` or `localhost`. Any other
URL is refused like an unreachable dashboard (audit mode: the local fallback with
a warning; enforce mode: exit 5), so the token never leaves the machine.
