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
for a small `permissions.deny` list that lands in **every** agent's
`settings.json`:

- on spawn, via `writeAgentSettingsFromProfile()`,
- on server startup, via `ensureBashEgressDeny()` (existing fleet, and the main
  agent -- see the scope note below),
- on scaffold, via `templates/settings.json.template` (so the next agent created
  starts gated -- a parity test keeps the template and the constant in step).

Denied: `curl` to an `https://` URL, and `wget` / `nc` / `ncat` / `telnet`
outright. A `deny` rule is checked **before** the
`--dangerously-skip-permissions` bypass, so it binds on permissive profiles too.
Sanctioned tooling that speaks HTTPS on its own account (`git`, `gh`, `npm`) is
deliberately untouched: denying it would break the release path without closing
anything an agent could not do through it anyway.

The sanctioned route for external content is unchanged: the quarantine-reader
sub-agent, through `WebFetch`, where the domain check already runs. A host being
on the egress allowlist does not open it to the shell.

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
