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
  inline environment the push would run with. Any value from any source (repo, user, system, an
  included file) blocks the push. `git config include.path` / `includeIf.*` writes are denied
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
  which sites they came from, and nothing wraps them on the way in.
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

## The opt-in envelope hook

`scripts/hooks/browser-content-notice.py` is a `PostToolUse` hook that wraps
browser / search results in an `<untrusted source="..." fetch-nonce="...">`
envelope before the model sees them -- the same framing `wrapUntrustedFetch()`
gives the `WebFetch` path -- scrubs forged security tags out of the payload,
names any injection patterns it matched (forged `<untrusted>` /
`<system-reminder>` envelopes, a pre-injected scrub sentinel, instruction
overrides, credential targets, exfil shapes) and appends the full payload to
`store/browser-content.log` for reading outside the model's context.

It is **not registered by default** -- an install with no browser gains nothing
from it. Operators who run a browser MCP server wire it themselves, in the
project `settings.json` or `settings.local.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__playwright__browser_.*|mcp__chrome.*|WebSearch",
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/browser-content-notice.py\"",
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
for a send it can read in the command text (an MCP mail tool, `send.py --to`,
an inline mailer call). A tool that mails through a script on another host,
for example `ssh <host> 'tsx send-letter.mjs'`, is invisible to it, so its
approval stayed unconsumed and could authorize a second send.

Such a tool consumes on its own path, right BEFORE the letter goes out, and
sends only on a yes:

```bash
python3 scripts/approval-consume.py --id <approval id> --content-hash <anchor> \
  --consumer <tool name> --message-id '<id@your.domain>' || exit 1   # 0 = send now
```

`POST /api/approvals/<id>/consume` is one conditional write (approved,
`email_send`, unconsumed, the same anchor, inside `EMAIL_APPROVAL_WINDOW_S`,
1800 s like the gate). Of two attempts exactly one gets 200; the other gets
409 with a reason (`already_consumed`, `not_approved`, `hash_mismatch`,
`expired`, `wrong_category`). The row records the consumer and the Message-Id
the tool generated up front (`consumed_by`, `consumed_ref`), and every call,
refused ones included, leaves a row in `approval_events`. The gate and the
endpoint read the same `consumed_at IS NULL`, so a letter consumed by one path
is refused by the other.

A 409 means: do not send, and check the sent mailbox before deciding anything,
because the earlier attempt may already have gone out.
