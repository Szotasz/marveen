# Named-script send exceptions

## What opens

An owner can grant a sub-agent a fixed Bash invocation of an external script
in `draft` and/or `send` mode. The exact absolute script path, its content
hash, modes and flags come from install-local operator config in
`store/agent-send-exceptions.json`. The framework ships no grants. No
environment variable redirects this file.

The gate resolves bare interpreter names (`node`, `nodejs`, or the `node` in
`/usr/bin/env node`) using the hook's own PATH. The Bash tool runs the command
after loading the session's shell snapshot (aliases, functions and PATH) from
the agent's startup files. The gate cannot see that snapshot, so those startup
files must stay owner-controlled.

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
      "booleanArgs": ["--confirm-send"],
      "readFiles": ["/absolute/path/to/extra.json"]
    }
  }
}
```

The original five entry keys are required. The optional `readFiles` key is an
array (possibly empty) of unique, nonempty absolute path strings. An absent
`readFiles` means an empty list. It permits additional read paths in the
invocation; these paths need not be included in every invocation. `scripts` is an array of `{ "path", "sha256" }`
objects: at least one entry, no duplicate paths, an absolute `path` and a
`sha256` of exactly 64 lowercase hex characters. The other four keys are
arrays of distinct nonempty strings; modes are `draft` and `send`. Flag names
must be distinct across the three flag lists. Unknown entry keys invalidate
only that entry. `--envelope-sha256`, `--bcc`, `--reply-to`, `--from`,
`--sender` and `--return-path` are gate-reserved: listing any of them in
`valueArgs`, `repeatableArgs` or `booleanArgs` invalidates the entry.
Missing, unreadable or invalid JSON grants no exceptions.

The grant binds the script content and path. On every invocation both gates
read the entry script ONCE, compare the sha256 of those bytes to the granted
value, and run a conservative loader scan on the SAME bytes as an early refusal only.
The scanner does not grant the exception; Node runtime restrictions are required. Unreadable files,
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

The whole command must be one literal invocation with this exact shape:

```text
<interp> --permission --allow-fs-read=<P1> ... --allow-fs-read=<Pn> <script> <mode> <args...>
```

`--permission` must immediately follow the interpreter. At least one read flag
is required, and only `--allow-fs-read=<absolute-path>` flags may occur before
the script. Use **one flag per path**: a comma-joined list grants nothing on
current Node (measured on v22.22.2), and the gate refuses it. The read values
must be unique and include the script, the `--body-file` value if present,
and every `--attach` value. Only paths in that required set or the grant's
optional `readFiles` list may appear. Any subset of `readFiles` may be included.
The allow flags may appear in any order. Other runtime flags, two-token read
flags, relative read paths and the old command shape receive no exception.
Each read path must be a regular file or must not exist yet, and must be
written in canonical form: no `.`, `..` or empty segment and no trailing
slash. A directory, a symlink (to a file or a directory), a non-canonical
spelling or a path the gate cannot inspect receives no exception: Node
treats a granted directory, also one reached through a symlink, as a grant
for its whole tree, and it resolves a grant path lexically, so a missing
parent followed by `..` becomes a grant for the directory above it (both
measured on v22.22.2). The check runs
when the gate decides; a swap by a concurrent process afterwards is out of
scope.

Whole quoted arguments are accepted; expansions, escapes, quote concatenation,
shell metacharacters, assignments, compound commands, pipes and redirections
are not. Value flags take one value and cannot repeat; only repeatable value
flags can repeat. Positional arguments and unlisted flags do not qualify.
`--body-file` and every `--attach` value must be absolute paths. Other Bash
send shapes retain the existing gate decisions.

The interpreter prefix remains the exact allowlist: bare `node` or `nodejs`
(as found on `PATH`), `/usr/bin/node`, `/usr/local/bin/node`, and the two-token
`/usr/bin/env node`. Direct script execution and other interpreter paths
receive no exception. After all other checks pass, the gate resolves the
interpreter and runs `--version` without a shell, with a two-second timeout.
A bare name is looked up the way the shell does it: every `PATH` entry up to
the match must be absolute (an empty or relative entry gives no exception),
and the candidate is `<entry>/<name>` as written, not normalized, so a `..`
after a symlinked directory leads to the same file the shell runs.
Before it is run, the resolved interpreter is held to the same rule as the
script: if it is a symlink, has a writable path component, or the runner is
root, there is no exception and the interpreter is never executed (so a
`nodejs` that is a symlink, or a `node` in a user-writable directory such as a
version manager's, receives no exception).
A missing interpreter, failed probe or invalid version receives no exception.
The minimum is **22.13.0 on Node 22, 23.5.0 on Node 23, or any Node 24+**;
other versions receive no exception. The history tables of the Node docs
(https://nodejs.org/api/permissions.html, Permission Model, and
https://nodejs.org/api/cli.html, `--permission`) record it as stable from
v22.13.0 and v23.5.0. These minimums are taken from the docs; only v22.22.2
was measured locally.

**macOS receives no exception** because the permission model was not measured
there. This is a belt against accidental loading, not a sandbox against
malicious code: the script is hash-bound and Node refuses reads outside the
list, writes and child processes. Network is open in the measured runtime;
the trust boundary for `NODE_OPTIONS` and shell start-up files is unchanged.
The exception continues to trust them as the agent's own process does; from
`PATH` it only takes an interpreter that passes the rule above.

## Recipients and approval

Both modes require ledger-verified `--to` and `--cc` recipients. These two flags
are the only recipient channel the gates verify and hash. The gates refuse an
entry that names `--bcc`, `--reply-to`, `--from`, `--sender` or `--return-path`;
any other flag through which the granted script could name an address is
outside the gates' view, so the owner must not grant one. A draft does
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
