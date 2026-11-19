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
only that entry. `--envelope-sha256` is gate-reserved: listing it in
`valueArgs`, `repeatableArgs` or `booleanArgs` invalidates the entry.
Missing, unreadable or invalid JSON grants no exceptions.

The grant binds the script content and path. On every invocation both gates
read the entry script ONCE, compare the sha256 of those bytes to the granted
value, and run a conservative loader scan on the SAME bytes. Unreadable files,
hash mismatches and refused source all mean no exception. The scan requires
strict UTF-8, refuses identifier Unicode escapes, dangerous loader/runtime
names and options, and accepts only literal `node:` built-in specifiers in
`require`, `import` and `from` forms. Comments and strings count too, so even
harmless mentions can refuse a script. A script that needs a child process,
a worker, vm, eval or a non-builtin module cannot use the exception.

The script file and EVERY ancestor directory, up to and including `/`, must
also be unwritable by the gate's own uid. The configured path must be its own
real path: a path with a symlink anywhere in it is refused even when every
directory is unwritable (configure the output of `realpath <file>` instead), and
a path that cannot be resolved fails closed. Unknown permission states fail closed.
A read-only file system counts as unwritable (EROFS, like EACCES and EPERM); any other error from the
permission probe fails closed, and both gates apply the same rule. A gate running as root (effective uid 0)
never grants the exception.
Sticky writable directories such as `/tmp` count as writable. A failed content or path check falls back to the
ordinary gate decisions.

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
matches the grant and the ordinary gate decisions apply. For a command naming a
sending or undecidable script that decision is the script-send deny: the
ordinary analysis recognizes the `nodejs` basename as node-ish (2026-11-17) --
including the extensionless-load rule (X, X.js, X.json) -- so a nodejs-basename
interpreter outside the allowlist is denied exactly when the same script under
`node` would be; a genuinely harmless script (see the `nodejs plain.mjs`
corpus control) is not denied. The allowlist narrows the accepted shapes but
is NOT a trust boundary: bare `node`/`nodejs` resolves through `PATH`, and
`PATH`, `NODE_OPTIONS` and the shell start-up files the agent's commands run
with are typically inside the same user boundary the agent runs in (for
example on a typical macOS install, where the early PATH entries are
user-writable). The exception trusts them as far as the agent's own process
does.

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

## Envelope digest

Send mode requires exactly one `--envelope-sha256 <64 lowercase hex>`;
missing, repeated or malformed values get no exception. Draft mode refuses
this flag entirely because drafts are not approval-bound. The JS send gate
checks only this shape; the Python approval hook verifies the digest against
the current body and attachment bytes before checking approval.

The **script envelope digest v1** is the lowercase hex sha256 of the UTF-8
bytes of the following text. Every line ends in exactly one LF (`\n`),
including the last line, with no other characters. Recipient and subject
values are exactly the parsed command-line values (empty when absent); the
parser refuses CR and LF in commands. Body and attachment hashes cover raw
file bytes. Attachment lines follow command-line order; no attachments means
no `attach=` lines.

```text
marveen-script-envelope-v1
to=<--to value, or empty>
cc=<--cc value, or empty>
subject=<--subject value, or empty>
body=<lowercase hex sha256 of --body-file bytes>
attach=<lowercase hex sha256 of --attach bytes, one line per attachment>
```

The owner must check this contract before granting a script: the script reads
each file ONCE, computes this digest over exactly those bytes, refuses to send
(non-zero exit, nothing sent) if it differs from `--envelope-sha256`, and sends
exactly the buffers it hashed. This re-verification closes the interval between
the hook's check and the script's reads. The approval envelope and its existing
`content_anchor` hash remain unchanged.

Reference implementation using only Node built-ins, with `ex` containing the
parsed values (`bodyFile`, `attach`, `to`, `cc`, `subject`, `envelopeSha256`):

```js
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function readVerifiedEnvelope(ex) {
  const body = readFileSync(ex.bodyFile);
  const attachments = ex.attach.map(path => readFileSync(path));
  const lines = ['marveen-script-envelope-v1',
    `to=${ex.to ?? ''}`, `cc=${ex.cc ?? ''}`, `subject=${ex.subject ?? ''}`,
    `body=${sha256(body)}`, ...attachments.map(data => `attach=${sha256(data)}`)];
  const digest = sha256(Buffer.from(lines.join('\n') + '\n', 'utf8'));
  if (!/^[0-9a-f]{64}$/.test(ex.envelopeSha256 ?? '') || digest !== ex.envelopeSha256)
    throw new Error('Envelope changed; refusing to send');
  return { body, attachments }; // Send exactly these buffers; never re-read files.
}
```

Let a verification error terminate with a non-zero exit before any send.

## Revoke

Remove the agent's entry. The next spawn rewrites its settings and removes
the scaffold-owned approval hooks; startup governance repair also reconciles
them. The send gate reads the config for each invocation, so a removed grant
stops matching immediately.
