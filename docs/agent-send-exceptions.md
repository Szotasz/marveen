# Named-script send exceptions

## What opens

An owner can grant a sub-agent a fixed Bash invocation of an external script
in `draft` and/or `send` mode. The exact absolute script path, modes and flags
come from install-local operator config in `store/agent-send-exceptions.json`.
The framework ships no grants. No environment variable redirects this file.

## Config

```json
{
  "agents": {
    "<agent-name>": {
      "scripts": ["/absolute/path/to/runner.ext"],
      "modes": ["draft", "send"],
      "valueArgs": ["--to", "--cc", "--subject", "--body-file"],
      "repeatableArgs": ["--attach"],
      "booleanArgs": ["--confirm-send"]
    }
  }
}
```

All five entry keys are required and contain arrays of nonempty strings.
Script paths must be absolute; modes are `draft` and `send`. Flag names must
be distinct across the three flag lists. Unknown entry keys invalidate only
that entry. Missing, unreadable or invalid JSON grants no exceptions.

The whole command must be one literal invocation: optional `node`, `nodejs`,
an absolute interpreter path ending in `node` or `nodejs`, or `/usr/bin/env node`,
then the exact configured script path, mode and listed flags. Whole quoted
arguments are accepted; expansions, escapes, quote concatenation, shell
metacharacters, assignments, compound commands, pipes and redirections are
not. Value flags take one value and cannot repeat; only repeatable value flags
can repeat. Positional arguments and unlisted flags do not qualify.
`--body-file` and every `--attach` value must be absolute paths. Other Bash
send shapes retain the existing gate decisions.

## Recipients and approval

Both modes require ledger-verified `--to` and `--cc` recipients. A draft does
not consume approval. For an enabled entry the scaffold also installs the
separate email approval hook, using the project's existing matchers and
fail-closed timeout wrapper.

A send follows `email_send` levels: level 1 denies; level 2 requires an
unconsumed written approval within 1800 seconds for the exact envelope hash;
level 3 allows. The hash covers recipients, subject, body-file content and
each attachment's digest, name and size through the existing envelope canon.
Standing-recipient approvals cannot replace this per-envelope approval.
Unreadable body or attachment files deny. Allowing the send gate exception
only passes that hook; other hooks still decide independently.

## Revoke

Remove the agent's entry. The next spawn rewrites its settings and removes
the scaffold-owned approval hooks; startup governance repair also reconciles
them. The send gate reads the config for each invocation, so a removed grant
stops matching immediately.
