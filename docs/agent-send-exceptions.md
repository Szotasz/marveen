# Named-script send exceptions

## What opens

An owner can grant a sub-agent a fixed Bash invocation of an external script
in `draft` and/or `send` mode. The exact absolute script path, its content
hash, modes and flags come from install-local operator config in
`store/agent-send-exceptions.json`. The framework ships no grants. No
environment variable redirects this file.

## Config

```json
{
  "agents": {
    "<agent-name>": {
      "scripts": [
        { "path": "/absolute/path/to/runner.ext", "sha256": "<64 lowercase hex>" }
      ],
      "modes": ["draft", "send"],
      "valueArgs": ["--to", "--cc", "--subject", "--body-file"],
      "repeatableArgs": ["--attach"],
      "booleanArgs": ["--confirm-send"]
    }
  }
}
```

All five entry keys are required. `scripts` is an array of `{ "path", "sha256" }`
objects: at least one entry, no duplicate paths, an absolute `path` and a
`sha256` of exactly 64 lowercase hex characters. The other four keys are
arrays of distinct nonempty strings; modes are `draft` and `send`. Flag names
must be distinct across the three flag lists. Unknown entry keys invalidate
only that entry. Missing, unreadable or invalid JSON grants no exceptions.

The grant binds the script CONTENT, not only its path. On every invocation
both gates read the entry script's raw bytes and compare its sha256 to the
granted value; an unreadable or missing file, or a hash mismatch, means the
invocation does not qualify (fail-closed), however well the command line
matches. The hash covers ONLY the entry script file -- modules it imports
are not covered -- so a single-file script (or a self-contained bundle) is
required.

The whole command must be one literal invocation: an optional interpreter
prefix (the exact allowlist below), then the exact configured script path,
mode and listed flags. Whole quoted arguments are accepted; expansions,
escapes, quote concatenation, shell metacharacters, assignments, compound
commands, pipes and redirections are not. Value flags take one value and
cannot repeat; only repeatable value flags can repeat. Positional arguments
and unlisted flags do not qualify. `--body-file` and every `--attach` value
must be absolute paths. Other Bash send shapes retain the existing gate
decisions.

The interpreter prefix is an exact allowlist (owner decision, 2026-11-17):
the bare `node` or `nodejs` (as found on `PATH`), `/usr/bin/node`,
`/usr/local/bin/node`, and the two-token `/usr/bin/env` + `node`. Every other
absolute interpreter path -- `/usr/bin/nodejs`, `/usr/local/bin/nodejs`,
`/tmp/x/node`, anything else -- gets no exception: the command no longer
matches the grant and the ordinary gate decisions apply. The reason: a
writable fake interpreter at an arbitrary path would run instead of the
granted, hash-verified script, so the shape of the interpreter path can carry
no trust.

## Recipients and approval

Both modes require ledger-verified `--to` and `--cc` recipients. A draft does
not consume approval. For an enabled entry the scaffold also installs the
separate email approval hook, using the project's existing matchers and
fail-closed timeout wrapper.

A send follows `email_send` levels -- an owner decision (2026-11-17): the
grant's send mode FOLLOWS the install's `email_send` autonomy level, and the
grant itself never adds a per-letter approval requirement. Level 1 denies;
level 2 keeps the usual per-envelope approval -- an unconsumed written
approval within 1800 seconds for the exact envelope hash; level 3 sends
autonomously. An "always require envelope approval regardless of level"
variant was considered and rejected by the owner (2026-11-17). The hash
covers recipients, subject, body-file content and each attachment's digest,
name and size through the existing envelope canon. Standing-recipient
approvals cannot replace this per-envelope approval. Unreadable body or
attachment files deny. Allowing the send gate exception only passes that
hook; other hooks still decide independently.

## Revoke

Remove the agent's entry. The next spawn rewrites its settings and removes
the scaffold-owned approval hooks; startup governance repair also reconciles
them. The send gate reads the config for each invocation, so a removed grant
stops matching immediately.
