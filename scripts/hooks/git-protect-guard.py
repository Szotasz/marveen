#!/usr/bin/env python3
"""PreToolUse hook: protect the shared git checkout from documented footguns.

Multiple agents share one working tree (see the shared-checkout rule). These git
moves reliably corrupt a shared checkout or a protected branch, and every one of
them has already bitten this fleet at least once:

  1. `git add -A` / `git add .` / `git add --all` -- stages OTHER agents' unrelated
     changes into your commit. The rule is: stage only your own files/hunks.
  2. force-push (`git push --force` / `-f` / `--force-with-lease`) to a protected
     branch (main / develop) -- rewrites shared history.
  3. `git add`-ing the contended lockfile (pnpm-lock.yaml / package-lock.json) --
     A koordinátor batches dependency changes; agents never touch the lockfile.
  4. DESTRUCTIVE WHOLE-TREE ops (card 6b532950) -- `git reset --hard`,
     `git checkout .` / `git checkout -- .`, `git restore .`, `git stash` (bare),
     `git clean -fd`. These do not just affect YOUR files: in a shared checkout
     they silently delete every other agent's uncommitted work. Real incident:
     a hard-reset wiped backend's uncommitted 21a34658 WIP right after another
     agent's commit (see memories uncommitted-edits-wiped-in-shared-tree and
     gate-agent-stashes-active-wip).

This guard parses the Bash command and blocks (exit 2) ONLY on a clear match of
one of the above. It is intentionally conservative -- the cost of a false block
is a wedged agent, so every rule below is scoped to the WHOLE-TREE form and the
targeted//safe forms stay allowed:

  - It only inspects Bash tool calls; everything else is allowed.
  - `git add -p` / `git add <specific-path>` -> allowed (the correct pattern).
  - A protected-branch force-push is blocked; a force-push to a private feature
    branch is allowed (that is a legitimate agent workflow).
  - `git reset <file>` / bare `git reset` / `--soft` / `--mixed` -> allowed: they
    move HEAD and/or the index but NEVER discard working-tree edits. Only
    `--hard` (and `--merge`/`--keep`, which also overwrite the tree) is blocked.
  - `git checkout <branch>` / `git checkout -b` / `git checkout <ref> -- <path>`
    -> allowed. Only the whole-tree `.`/`--all` form is blocked; a targeted
    single-file restore is a legitimate, reviewable operation.
  - `git stash pop|apply|list|show|drop|branch` -> allowed (those RESTORE or
    inspect). Only a bare `git stash` / `git stash push` with no pathspec is
    blocked -- that is the form that hides a peer's in-flight work.
  - `git clean -n` / `--dry-run` -> allowed. Only an actually-deleting `-f` is
    blocked.
  - Any parse error -> FAIL-OPEN (exit 0). Never wedge the fleet on a guard bug.

WHAT THIS IS NOT (be honest with anyone reading this before trusting it): this is a
regex over the command STRING, so it stops ACCIDENTS, not a determined actor. It
does not survive variable indirection (`g=git; $g reset --hard`), string splitting
(`git rese""t --hard`), a command written to a file and executed, or TWO levels of
wrapper nesting (`bash -c "bash -c '...'"` -- one level is unwrapped, deliberately:
at two levels a caller is evading, not phrasing, and no string matcher wins that
race). Closing those would need real shell parsing or an allowlist, which would cost
far more false positives than the footguns are worth. Treat it as a seatbelt for
tired agents, NOT as a security boundary -- the actual protection against losing work
is committing early (shared-checkout rule).

WHAT IS COVERED that a naive matcher misses (added after the c9e4b5d gate): git's
GLOBAL options and env prefixes before the subcommand -- `git -C <path> reset --hard`,
`git --git-dir=... reset --hard`, `GIT_DIR=... git reset --hard`. These are not
evasions but the normal cross-repo idiom, so missing them left the guard blind in
exactly its primary scenario. Heredoc BODIES are stripped before scanning, so writing
a doc or fixture that quotes a destructive command is not refused.
"""
import sys
import re
import json

PROTECTED_BRANCHES = ("main", "master", "develop")
LOCKFILES = ("pnpm-lock.yaml", "package-lock.json", "yarn.lock")

# A git invocation only counts when it sits at a COMMAND boundary (start of the
# command, or right after a shell separator), optionally behind `sudo`/`time`.
# This is what stops the frequent false positive: the literal string "git add -A"
# embedded in a QUOTED argument to another command (a curl -d payload, an echo, a
# log line that documents the rule) is NOT at a boundary, so it is not matched.
# Backtick is deliberately NOT a boundary here -- inside single quotes it is a
# literal char in docs far more often than a real command substitution.
# Leading environment assignments (`GIT_DIR=.git git ...`, `FOO=1 git ...`).
_ENV_PREFIX = r"(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]*\s+)*"
# Git GLOBAL options, which may sit BETWEEN `git` and the subcommand (Cybersec/QA NO-GO on c9e4b5d).
# `git -C <path> reset --hard` is not an evasion -- it is the NORMAL way to operate on a repo you are
# not cd'd into, i.e. exactly how an agent working from the shared repo root touches the shared CleanCore
# checkout. Missing it meant the guard missed its own primary scenario. Options that take a SEPARATE
# argument (-C, -c) must consume that argument too, or the subcommand match lands on the wrong token.
_GIT_GLOBAL = (
    r"(?:"
    r"(?:-C|-c)\s+[^\s;&|]+\s+"                                   # -C <path>, -c <key=val>
    r"|--(?:git-dir|work-tree|namespace|exec-path)(?:=[^\s;&|]*\s+|\s+[^\s;&|]+\s+)"
    r"|--(?:no-pager|paginate|bare|literal-pathspecs|icase-pathspecs|no-replace-objects)\s+"
    r"|-[pP]\s+"
    r")*"
)
_CMD = (
    r"(?:^|[\n;&|(])\s*" + _ENV_PREFIX + r"(?:sudo\s+)?(?:time\s+)?git\s+" + _GIT_GLOBAL
)
# `git add` with a stage-everything flag (-A, --all, or a bare `.`).
ADD_ALL_RX = re.compile(_CMD + r"add\b[^\n&|;]*?(?:(?<!\S)-A\b|--all\b|(?<!\S)\.(?:\s|$))")
# `git commit -a`/`-am`/`--all` -- the OTHER swallow vector (card 42a2f45d). `-a` stages EVERY
# modified tracked file at commit time, so on a shared checkout it sweeps a peer's in-flight tracked
# edits into your commit exactly like `git add -A` -- and the guard did not cover it, so it was the
# path the swallow kept happening through after `git add -A` was blocked. Matches a short-flag cluster
# containing `a` (`-a`, `-am`, `-ap`) and `--all`; `--amend` and `-m` alone (no `a`) stay allowed.
COMMIT_ALL_RX = re.compile(
    _CMD + r"commit\b[^\n&|;]*?(?:--all\b|(?<!\S)-[A-Za-z]*a[A-Za-z]*\b)"
)
# `git add` naming a lockfile explicitly.
ADD_LOCK_RX = re.compile(
    _CMD + r"add\b[^\n&|;]*?(?:" + "|".join(re.escape(f) for f in LOCKFILES) + r")"
)
# force-push in any argument order.
FORCE_PUSH_RX = re.compile(_CMD + r"push\b[^\n&|;]*?(?:--force(?:-with-lease)?\b|(?<!\S)-f\b)")

# --- destructive whole-tree ops (card 6b532950) ------------------------------------------------
# `git reset --hard|--merge|--keep` -- the modes that OVERWRITE the working tree. `--soft`/`--mixed`
# (and a bare `git reset` / `git reset <file>`) only touch HEAD/index and are deliberately allowed.
RESET_HARD_RX = re.compile(_CMD + r"reset\b[^\n&|;]*?--(?:hard|merge|keep)\b")

# `git checkout -f|--force` -- a forced branch switch OVERWRITES uncommitted local changes, so in a
# shared tree it is as destructive as `checkout .` even though it names a branch.
CHECKOUT_FORCE_RX = re.compile(_CMD + r"checkout\b[^\n&|;]*?(?:--force\b|(?<!\S)-f\b)")

# `git checkout .` / `git checkout -- .` / `git checkout --all`, and the same shapes for the modern
# `git restore`. A trailing `.` (or `*`) as the PATHSPEC means "throw away the whole tree".
# `git restore --staged .` is NOT matched: that only unstages, it does not touch the working tree.
_WHOLE_TREE_PATHSPEC = r"(?:(?<!\S)\.(?:\s|$)|(?<!\S)\*(?:\s|$)|--all\b)"
CHECKOUT_ALL_RX = re.compile(_CMD + r"checkout\b(?:(?!\bHEAD\b|[\n&|;])[^\n&|;])*?" + _WHOLE_TREE_PATHSPEC)
RESTORE_ALL_RX = re.compile(
    _CMD + r"restore\b(?![^\n&|;]*--staged\b)[^\n&|;]*?" + _WHOLE_TREE_PATHSPEC
)

# Bare `git stash` / `git stash push` with NO pathspec -- stashes the WHOLE tree, including every
# other agent's uncommitted work. The restoring/inspecting subcommands are explicitly allowed.
STASH_SAFE_SUB = r"(?:pop|apply|list|show|drop|branch|clear)\b"
STASH_ALL_RX = re.compile(_CMD + r"stash\b(?:\s+(?:push|save)\b)?\s*(?:-[uak]\b\s*)*(?:$|[\n;&|])")

# `git clean` that actually deletes (-f/--force), excluding an explicit dry run.
CLEAN_FORCE_RX = re.compile(
    _CMD + r"clean\b(?![^\n&|;]*(?:--dry-run\b|(?<!\S)-n\b))[^\n&|;]*?(?:--force\b|(?<!\S)-[a-eg-mo-z]*f)"
)


_SHARED_TREE_NOTE = (
    " KOZOS CHECKOUT: ez nem csak a TE valtozasaidat torli -- minden mas agent "
    "commitolatlan munkajat is. Ha tenyleg kell, elobb commitold a sajatodat, es "
    "hasznalj CELZOTT format (pl. `git checkout <ref> -- <fajl>`), vagy kerd a koordinatort."
)

_DESTRUCTIVE_RULES = (
    (
        RESET_HARD_RX,
        "`git reset --hard/--merge/--keep` blokkolva -- felulirja a munkafat." + _SHARED_TREE_NOTE
        + " Unstage-hez hasznald: `git reset <fajl>` (ez engedelyezett).",
    ),
    (
        CHECKOUT_ALL_RX,
        "`git checkout .` / `-- .` blokkolva -- eldobja az EGESZ munkafa valtozasait."
        + _SHARED_TREE_NOTE,
    ),
    (
        CHECKOUT_FORCE_RX,
        "`git checkout -f/--force` blokkolva -- a kenyszeritett branch-valtas felulirja a "
        "commitolatlan valtozasokat." + _SHARED_TREE_NOTE
        + " Kapcsolo nelkul (`git checkout <branch>`) engedelyezett: az fail-closed, ha utkozne.",
    ),
    (
        RESTORE_ALL_RX,
        "`git restore .` blokkolva -- eldobja az EGESZ munkafa valtozasait."
        + _SHARED_TREE_NOTE
        + " (`git restore --staged .` engedelyezett: az csak unstage-el.)",
    ),
    (
        STASH_ALL_RX,
        "Csupasz `git stash` blokkolva -- elrejti az EGESZ fat, benne mas agentek "
        "eppen futo munkajat (volt mar ra eset)." + _SHARED_TREE_NOTE
        + " A `git stash pop|apply|list|show|drop` engedelyezett.",
    ),
    (
        CLEAN_FORCE_RX,
        "`git clean -f` blokkolva -- torli a nem-kovetett fajlokat, koztuk mas agentek "
        "meg nem commitolt uj fajljait." + _SHARED_TREE_NOTE
        + " Szarazon futtatva (`git clean -n`) engedelyezett.",
    ),
)


# A single level of shell-wrapper indirection: `bash -c "..."`, `sh -c '...'`, `eval "..."`.
# An agent writing `bash -c "git reset --hard"` is PHRASING, not evading -- unwrapping one level
# catches that accident. Deliberately ONE level and only these three forms: this is a footgun guard,
# not a sandbox (see the module docstring's honesty note about what it cannot catch).
_WRAPPER_RX = re.compile(
    r"(?:^|[\n;&|(])\s*(?:bash|sh|zsh)\s+-c\s+(['\"])(.*?)\1|(?:^|[\n;&|(])\s*eval\s+(['\"])(.*?)\3",
    re.S,
)


def _unwrapped_variants(cmd):
    """The command itself, plus the contents of any one-level bash -c / eval wrapper."""
    out = [cmd]
    for m in _WRAPPER_RX.finditer(cmd):
        inner = m.group(2) if m.group(2) is not None else m.group(4)
        if inner:
            out.append(inner)
    return out


# A heredoc BODY is data being written, not a command being run (Cybersec/QA LOW on c9e4b5d).
# Writing a doc, a test fixture or a guard probe whose CONTENT quotes `git reset --hard` must not be
# refused -- the fleet writes exactly such files (this guard's own selftest is one). Quoted mentions
# (echo '...', curl -d '{...}') were already exempt via the command-boundary rule; a raw heredoc body
# was not, because its lines DO start at a line boundary. Strip those bodies before scanning.
_HEREDOC_RX = re.compile(
    r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1.*?^\s*\2\s*$",
    re.S | re.M,
)


def _strip_heredoc_bodies(cmd):
    """Blank out `<<EOF ... EOF` / `<<'EOF' ... EOF` bodies so their CONTENT is not scanned."""
    return _HEREDOC_RX.sub("<<HEREDOC-BODY-STRIPPED", cmd)


# The CONTENT of a quoted argument is DATA, not shell syntax (card 42a2f45d). The command-boundary
# rule (_CMD) already exempts a quoted `git add -A` that has no inner separator -- but a `;`/`|`/`&`/
# newline INSIDE the quotes (a JSON payload, a curl body, a commit message, an inter-agent message
# that documents the rule) was still read as a real command boundary, so `curl -d '...; git add -A'`
# false-blocked. Blanking quoted spans (keeping the quote chars, so token structure is intact) removes
# that whole false-positive class. A REAL destructive command is never inside quotes; a `bash -c "..."`
# / `eval "..."` wrapper is handled separately by _unwrapped_variants (which reads the RAW, un-stripped
# command), so a genuinely-wrapped destructive op is still caught.
_QUOTED_RX = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", re.S)


def _strip_quoted_literals(cmd):
    """Replace the CONTENT of single-/double-quoted spans with an empty quote of the same kind, left
    to right (so a `"` inside a `'...'` span is treated as the literal it is in a shell)."""
    return _QUOTED_RX.sub(lambda m: "''" if m.group(0)[0] == "'" else '""', cmd)


def _pushes_protected(cmd):
    """True only if a force-push EXPLICITLY names a protected branch. We fail
    toward allow: a force-push with no protected-branch token (e.g. to a feature
    branch, or current branch) is permitted -- blocking those would break the
    legitimate agent workflow. Naming main/master/develop in a force-push is the
    unambiguous footgun we stop."""
    m = FORCE_PUSH_RX.search(cmd)
    if not m:
        return False
    seg = cmd[m.start():]
    return any(
        re.search(r"(?<![\w./-])" + re.escape(b) + r"(?:\s|$|:)", seg)
        for b in PROTECTED_BRANCHES
    )


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if (payload.get("tool_name") or "") != "Bash":
        sys.exit(0)

    ti = payload.get("tool_input") or {}
    cmd = ti.get("command") if isinstance(ti, dict) else None
    if not isinstance(cmd, str) or "git" not in cmd:
        sys.exit(0)

    try:
        # A heredoc body is DATA being written, not a command -- never scan its contents.
        cmd = _strip_heredoc_bodies(cmd)

        # Scan the command AND one level of bash -c / eval unwrapping (from the RAW command, so a
        # genuinely-wrapped destructive op is still seen), and within each variant blank quoted spans
        # so a separator inside a quoted payload is not read as a real command boundary (card 42a2f45d).
        for variant in (_strip_quoted_literals(v) for v in _unwrapped_variants(cmd)):
            # `git add -p` is the sanctioned staging path; never block it.
            if ADD_ALL_RX.search(variant) and not re.search(r"\bgit\s+add\s+-p\b", variant):
                sys.stderr.write(
                    "GIT-PROTECT-GUARD: `git add -A/./--all` blokkolva -- kozos "
                    "checkout-on ez mas agentek valtozasait is stage-eli. Csak a SAJAT "
                    "fajljaidat/hunkjaidat add hozza: `git add <path>` vagy `git add -p`."
                )
                sys.exit(2)

            if COMMIT_ALL_RX.search(variant):
                sys.stderr.write(
                    "GIT-PROTECT-GUARD: `git commit -a/-am/--all` blokkolva -- kozos "
                    "checkout-on ez MINDEN modositott kovetett fajlt stage-el commit kozben, "
                    "beleertve mas agentek eppen futo valtozasait. Stage-eld es commitold a "
                    "SAJAT fajljaidat: `git add <fajl> && git commit ...` vagy `git commit <fajl>`. "
                    "(`git commit -m` es `git commit --amend` -a nelkul engedelyezett.)"
                )
                sys.exit(2)

            if ADD_LOCK_RX.search(variant):
                sys.stderr.write(
                    "GIT-PROTECT-GUARD: lockfile (pnpm-lock.yaml / package-lock.json) "
                    "git add-je blokkolva -- a fuggosegeket a koordinator batcheli, agent nem "
                    "nyul a lockfile-hoz. Hagyd ki a lockfile-t a commitbol."
                )
                sys.exit(2)

            if _pushes_protected(variant):
                sys.stderr.write(
                    "GIT-PROTECT-GUARD: force-push vedett branchre (main/master/develop) "
                    "blokkolva -- ez kozos historiat ir felul. Pushold feature branchre, "
                    "vagy nyiss PR-t. Force-push privat feature branchre engedelyezett."
                )
                sys.exit(2)

            # --- destructive whole-tree ops (card 6b532950) -----------------------------------
            for rx, msg in _DESTRUCTIVE_RULES:
                if rx.search(variant):
                    sys.stderr.write("GIT-PROTECT-GUARD: " + msg)
                    sys.exit(2)
    except Exception:
        sys.exit(0)  # any guard error -> fail open

    sys.exit(0)


if __name__ == "__main__":
    main()
