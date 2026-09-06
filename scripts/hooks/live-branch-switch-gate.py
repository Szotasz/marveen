#!/usr/bin/env python3
"""PreToolUse (Bash) gate: creating a branch in the LIVE tree.

WHAT IT PROTECTS: a marveen checkout is not only a repository, it is the RUNNING
install. The systemd units and the scheduler point at `scripts/*.sh` inside the
working tree, so switching that tree to a feature branch makes every script that
exists only on another branch disappear from disk, and the unit fails with
203/EXEC. Sub-agent working directories (`agents/<name>/`) live INSIDE that same
tree, so for them a `git checkout -b` switches the very tree the system runs from.

WHY IT IS SEEDED FOR SUB-AGENTS ONLY (measured 2026-08-31 on a live fleet):
the main agent's own transcripts held ten branch creations, ALL of them inside a
`git worktree` -- zero real cases. Both real incidents were a sub-agent's:

  * one stopped at a permission prompt on `git checkout -b` in the live tree,
  * one created the branch and LEFT the tree on it for hours. Nothing broke,
    because that branch only ADDED files, so the usual 203/EXEC symptom never
    appeared. The silent damage: the updater's preflight hard-blocks on
    `local-commits`, so the install quietly stopped being updatable.

The second case is the reason this gate exists: the failure that leaves no
symptom is the one nobody goes looking for. A gate is worth having where the
hand it holds actually reaches for the wrong thing -- see
`src/web/agent-scaffold.ts` `FLEET_ONLY_HOOK_SCRIPTS`.

IT SPEAKS EVERY TIME, not once per file: there is a cheap correct form to use
instead, so there is nothing to acknowledge -- the command should be rewritten.
(Gates whose correct step cannot be checked from a machine warn once and move on.)

FAIL-OPEN: any internal error exits 0. Exit 2 is the only stop.
"""
import json, os, re, sys

# The install this hook was seeded into: two levels up from scripts/hooks/.
# Derived from the file's own location rather than an env var, so the gate keeps
# working when the hook runs with a minimal environment.
LIVE = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", ".."))


def strip_noise(cmd):
    """Drop heredoc bodies, comment lines and DATA payloads before scanning.

    The heredoc and comment handling is taken from the remote-command gate, where
    it was measured: without it, prose typed into a heredoc is read as commands
    (about 60% of the hits were noise).

    The DATA payload rule was added from a separate measurement (2026-08-31): a
    `curl -d '...'` body carried an inter-agent MESSAGE that quoted the forbidden
    command as an example. Two of the three apparently-real hits were that. A
    message in which the wrong form APPEARS is not the wrong form being run.
    """
    cmd = re.sub(r"<<-?\s*(['\"]?)(\w+)\1.*?\n.*?^\s*\2\s*$", " ", cmd, flags=re.S | re.M)
    cmd = re.sub(r"(?:--data-urlencode|--data-raw|--data|-d)\s+'(?:[^']|'\\'')*'", " ", cmd)
    cmd = re.sub(r'(?:--data-urlencode|--data-raw|--data|-d)\s+"(?:[^"\\]|\\.)*"', " ", cmd)
    cmd = re.sub(r"`[^`]*`", " ", cmd)          # backtick quote: prose, not a command
    return "\n".join(s for s in cmd.split("\n") if not s.lstrip().startswith("#"))


# Branch CREATION from command position, the flag directly after checkout/switch.
# The `cd X ... &&` part is matched loosely because another command often sits
# between the `cd` and the `git` (`cd "$WT" && rm -rf node_modules && git checkout
# -b ...`); a strict form marked one such hit as live when it was not.
NEW_BRANCH = re.compile(
    r"(?:^|[;&|(\n]|\bthen\b|\bdo\b|\$\()\s*"
    r"(?:cd\s+(?P<cd>\S+)[^\n]*?&&\s*)?"
    r"git\s+(?:-C\s+(?P<C>\S+)\s+)?(?:checkout\s+-b|switch\s+-c)\s+(?P<br>\S+)", re.M)
WORKTREE = re.compile(r"\bgit\s+worktree\s+add\b")


def outside_live(path):
    """Does the command target a DIFFERENT tree? Only when it says so explicitly."""
    if not path:
        return False
    p = path.strip("'\"")
    if p.startswith(("$", "~", "/tmp")):
        return True          # a variable or tmp: in practice a worktree or scratch dir
    if p.startswith("/"):
        return not p.startswith(LIVE)   # anything under LIVE (incl. agents/<name>) is live
    return False             # a relative path keeps us inside the live tree


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    try:
        if payload.get("tool_name") != "Bash":
            sys.exit(0)
        cmd = (payload.get("tool_input") or {}).get("command") or ""
        if not cmd:
            sys.exit(0)
        clean = strip_noise(cmd)
        if WORKTREE.search(clean):
            sys.exit(0)                       # building a worktree: the correct form
        m = NEW_BRANCH.search(clean)
        if not m:
            sys.exit(0)
        if outside_live(m.group("C") or m.group("cd")):
            sys.exit(0)
        branch = (m.group("br") or "").strip("'\"`")
        sys.stderr.write(
            "LIVE-TREE GATE: this would create a branch (" + branch + ") in the tree the\n"
            "install RUNS FROM.\n\n"
            "The " + LIVE + " checkout is also the live system: systemd units and the\n"
            "scheduler point at its working-tree scripts/*.sh. On a branch switch, every\n"
            "script that exists only on another branch disappears from the tree and the\n"
            "unit fails with 203/EXEC. Sub-agent working directories (agents/<name>/) are\n"
            "inside this same tree.\n\n"
            "This has happened: a feature branch stood on the live tree for hours. Nothing\n"
            "visibly broke, because that branch only ADDED files -- which is why nobody\n"
            "noticed. The silent cost: the updater's preflight hard-blocks on local-commits.\n\n"
            "THE CORRECT FORM:\n"
            "  git worktree add /tmp/<name>-<task> -b " + (branch or "<branch>") + " develop\n"
            "  # do the work THERE; the live tree is untouched\n"
            "  # when done: git worktree remove /tmp/<name>-<task>\n\n"
            "Check afterwards: `git branch --show-current` should still say develop.\n"
        )
        sys.exit(2)
    except Exception:
        sys.exit(0)
    sys.exit(0)


if __name__ == "__main__":
    main()
