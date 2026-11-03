#!/usr/bin/env python3
"""Restore the tracked files that a Marveen INSTALL itself dirtied (INSTALLDIRTYTREE1103).

Why this exists
---------------
Up to v1.46.0 a fresh install changed three tracked files, and a tracked change
sends every later update down the stash path (marveen2, 2026-11-03: the stash pop
conflicted inside .claude/settings.json and left it invalid JSON):

  .claude/settings.json   the installers' `claude plugin enable --scope project`
                          (and channels.sh's guard on Slack installs) rewrote the
                          compact file with indent=2 and changed enabledPlugins;
  install-macos.sh /      the Bridge overwrote the tracked script with its derived
  install-linux.sh        headless variant (INSTWIZ1 marker), mode 0644;
  package-lock.json       a fresh `npm install` added "hasInstallScript": true.

The installers no longer do any of this. This script cleans the trees they already
dirtied. It restores a file from HEAD ONLY when every difference is one of those
known, generated changes; anything else -- a customer's own plugin, a hook edit,
an unknown key -- leaves the file alone, and the update takes its usual stash path.

It is standalone on purpose (stdlib + the git CLI, no imports from the repo), so
the same logic runs three ways:
  - update.sh calls it before its dirty-tree guard;
  - the dashboard's /api/updates/apply calls it before its preflight;
  - the Bridge "repair install" step can upload it to an UNTRACKED path on the
    customer machine and run it from the outside -- the only way to reach a tree
    whose own updater cannot run any more (a v1.46.0 tree stuck with an unmerged
    settings.json: its update.sh exits at the stash push, before any new code).

Unmerged paths (a conflicted `git stash pop`) are handled: the side that is not
HEAD's version is checked against the merge base with the same rules, and on a
match the path is checked out from HEAD. The stash entry is never dropped.

Usage: install-drift-repair.py --install-dir DIR [--resolve-conflicts] [--dry-run] [--json]

  --resolve-conflicts  the Bridge "repair install" mode (BRIDGEREPAIR1103): first
                       check out EVERY unmerged path from HEAD, then `git reset -q`,
                       then the narrow cleanup below. Allowed only while a
                       marveen-update-auto-stash entry exists, because the local side
                       of every conflict lives on in it. update.sh and the dashboard
                       do NOT pass it.
  --json               exactly one JSON object on stdout (contract version 1):
                       {version, ok, exitCode, dryRun, resolvedConflicts[], results[],
                        unmergedLeft[], stash{before, after, kept, autoStash[]}}
                       or, when it cannot run, {version, ok:false, exitCode:2, error}.

Exit:  0 the known paths are clean and nothing is unmerged;
       1 something is left (a non-generated change, or an unmerged path);
       2 cannot run (not a git work-tree top, a merge/rebase in progress, git
         missing, or --resolve-conflicts without an auto-stash entry): nothing changed;
       3 a stash entry that existed before is gone afterwards (must never happen).
The stash is NEVER dropped, popped or applied by this script.
"""
import argparse
import difflib
import json
import os
import re
import subprocess
import sys

SETTINGS = ".claude/settings.json"
INSTALL_SCRIPTS = ("install-macos.sh", "install-linux.sh")
LOCK = "package-lock.json"
KNOWN_PATHS = (SETTINGS,) + INSTALL_SCRIPTS + (LOCK,)

# The shipped channel plugin ids. A VALUE change of one of these, when the key is
# already in HEAD's enabledPlugins, is ours (channels.sh's guard, the installer).
CHANNEL_KEYS = frozenset((
    "telegram@claude-plugins-official",
    "discord@claude-plugins-official",
    "slack-channel@marveen-marketplace",
    "whatsapp@marveen-marketplace",
    "teams@marveen-marketplace",
))
# The key the installers ADDED: `claude plugin enable "$PLUGIN_SHORT@marveen-marketplace"`
# with PLUGIN_SHORT in {telegram, discord, slack-channel}, always set to true.
GENERATED_NEW_KEY = re.compile(r"(telegram|discord|slack-channel)@marveen-marketplace")
# The Bridge's derived headless installer carries this line (derive-headless.mjs).
INSTWIZ_MARKER = "# --- INSTWIZ1 headless-install helpers (contract) BEGIN ---"
HAS_INSTALL_SCRIPT = re.compile(r'\s*"hasInstallScript": true,?\s*')
UNMERGED = {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}
MISSING = object()


class GitError(Exception):
    pass


def git(cwd, *args, check=True):
    try:
        p = subprocess.run(["git", "-C", cwd] + list(args), stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE)
    except OSError as e:
        raise GitError("git not runnable: %s" % e)
    if check and p.returncode != 0:
        raise GitError("git %s: %s" % (" ".join(args), p.stderr.decode("utf-8", "replace").strip()))
    return p


def blob(cwd, spec):
    """Bytes of a blob (`HEAD:path`, `:1:path`, ...) or None when it does not exist."""
    p = git(cwd, "show", spec, check=False)
    return p.stdout if p.returncode == 0 else None


# --- the three rules: is every difference from `base` to `local` one of ours? ------------

def settings_generated(base, local):
    try:
        b = json.loads(base.decode("utf-8"))
        l = json.loads(local.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return False, "not valid JSON"
    if not isinstance(b, dict) or not isinstance(l, dict):
        return False, "not a JSON object"
    bp = b.pop("enabledPlugins", {})
    lp = l.pop("enabledPlugins", {})
    if b != l:
        return False, "changes outside enabledPlugins"
    if not isinstance(bp, dict) or not isinstance(lp, dict):
        return False, "enabledPlugins is not an object"
    for key in set(bp) | set(lp):
        old, new = bp.get(key, MISSING), lp.get(key, MISSING)
        if old == new and type(old) is type(new):
            continue
        if new is MISSING:
            return False, "enabledPlugins key removed: %s" % key
        if old is not MISSING:
            if key in CHANNEL_KEYS and isinstance(old, bool) and isinstance(new, bool):
                continue
            return False, "enabledPlugins value changed: %s" % key
        if GENERATED_NEW_KEY.fullmatch(key) and new is True:
            continue
        return False, "enabledPlugins key added: %s" % key
    return True, "only installer-generated enabledPlugins changes and formatting"


def install_script_generated(base, local):
    if local == base:
        return True, "mode-only change"
    text = local.decode("utf-8", "replace")
    if INSTWIZ_MARKER in text and INSTWIZ_MARKER not in base.decode("utf-8", "replace"):
        return True, "the Bridge's derived headless installer"
    return False, "content differs and is not the Bridge's headless installer"


def lock_generated(base, local):
    a = base.decode("utf-8", "replace").splitlines()
    b = local.decode("utf-8", "replace").splitlines()
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        for line in a[i1:i2] + b[j1:j2]:
            if not HAS_INSTALL_SCRIPT.fullmatch(line):
                return False, "lock changes beyond hasInstallScript"
    return True, "only hasInstallScript lines"


def rule_for(path):
    if path == SETTINGS:
        return settings_generated
    if path in INSTALL_SCRIPTS:
        return install_script_generated
    return lock_generated


# --- per-path decision ---------------------------------------------------------------------

def status_codes(cwd):
    """{path: XY} for the known paths that differ from HEAD (tracked only)."""
    out = git(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=no", "--", *KNOWN_PATHS).stdout
    codes = {}
    for entry in out.split(b"\0"):
        if len(entry) > 3:
            codes[entry[3:].decode("utf-8", "replace")] = entry[:2].decode("ascii", "replace")
    return codes


def decide(cwd, path, xy):
    """Return (restore?, reason)."""
    rule = rule_for(path)
    head = blob(cwd, "HEAD:" + path)
    if head is None:
        return False, "not in HEAD"
    if xy in UNMERGED:
        base, ours, theirs = blob(cwd, ":1:" + path), blob(cwd, ":2:" + path), blob(cwd, ":3:" + path)
        if base is None or ours is None or theirs is None:
            return False, "unmerged without all three stages (%s)" % xy
        # A conflicted `git stash pop`: stage 2 is HEAD (upstream), stage 3 the stash.
        if ours == head:
            local = theirs
        elif theirs == head:
            local = ours
        else:
            return False, "unmerged and neither side is HEAD"
        ok, why = rule(base, local)
        return ok, ("unmerged; the local side: " + why)
    # Not unmerged: the index AND the work tree must each be HEAD or ours, because the
    # restore resets both.
    candidates = []
    index = blob(cwd, ":0:" + path)
    if index is not None and index != head:
        candidates.append(("index", index))
    full = os.path.join(cwd, path)
    if os.path.lexists(full):
        if os.path.islink(full) or not os.path.isfile(full):
            return False, "not a regular file"
        with open(full, "rb") as f:
            work = f.read()
        if work != head:
            candidates.append(("work tree", work))
    else:
        return False, "deleted in the work tree"
    if not candidates:
        return True, "mode-only change" if path in INSTALL_SCRIPTS else "no content change"
    reasons = []
    for where, content in candidates:
        ok, why = rule(head, content)
        if not ok:
            return False, "%s: %s" % (where, why)
        reasons.append(why)
    return True, reasons[0]


def operation_in_progress(cwd):
    for name in ("MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"):
        p = git(cwd, "rev-parse", "--git-path", name).stdout.decode().strip()
        if not os.path.isabs(p):
            p = os.path.join(cwd, p)
        if os.path.exists(p):
            return name
    return None


AUTO_STASH_TAG = "marveen-update-auto-stash"


def stash_entries(cwd):
    """[(commit, subject)] of `git stash list`, newest first."""
    out = git(cwd, "stash", "list", "--format=%H%x09%gs").stdout.decode("utf-8", "replace")
    return [tuple(l.split("\t", 1)) for l in out.splitlines() if "\t" in l]


def unmerged_paths(cwd):
    out = git(cwd, "diff", "--name-only", "--diff-filter=U", "-z").stdout
    return sorted({p.decode("utf-8", "replace") for p in out.split(b"\0") if p})


def resolve_all_conflicts(cwd, dry_run):
    """--resolve-conflicts: every unmerged path -> HEAD, then `git reset -q`.

    Safe only because a conflicted `git stash pop` KEEPS the stash entry: the
    local side of every conflict is still in it. So this runs only when such an
    entry exists, and the caller verifies afterwards that no entry disappeared.
    """
    paths = unmerged_paths(cwd)
    if not paths:
        return []
    if not any(AUTO_STASH_TAG in subject for _, subject in stash_entries(cwd)):
        raise GitError("unmerged paths but no %s entry in `git stash list`; the local side "
                       "would not be preserved, not resolving" % AUTO_STASH_TAG)
    out = []
    for path in paths:
        if blob(cwd, "HEAD:" + path) is None:
            out.append({"path": path, "action": "leave", "reason": "unmerged and not in HEAD"})
            continue
        if not dry_run:
            git(cwd, "checkout", "HEAD", "--", path)
        out.append({"path": path, "action": "resolve" if dry_run else "resolved-to-head",
                    "reason": "unmerged; the local side stays in the auto-stash"})
    if not dry_run:
        git(cwd, "reset", "-q")
    return out


def run(install_dir, dry_run, resolve_conflicts=False):
    cwd = os.path.realpath(install_dir)
    top = git(cwd, "rev-parse", "--show-toplevel", check=False)
    if top.returncode != 0 or os.path.realpath(top.stdout.decode().strip()) != cwd:
        raise GitError("%s is not the top of a git work tree" % cwd)
    busy = operation_in_progress(cwd)
    if busy:
        raise GitError("a git operation is in progress (%s); not touching anything" % busy)
    stash_before = stash_entries(cwd)
    conflicts = resolve_all_conflicts(cwd, dry_run) if resolve_conflicts else []
    pending = {c["path"] for c in conflicts if c["action"] == "resolve"}
    results = []
    restore = []
    for path, xy in sorted(status_codes(cwd).items()):
        if path in pending:
            continue  # dry run: would be resolved to HEAD first
        ok, why = decide(cwd, path, xy)
        results.append({"path": path, "status": xy, "action": "restore" if ok else "leave", "reason": why})
        if ok:
            restore.append(path)
    if restore and not dry_run:
        git(cwd, "checkout", "HEAD", "--", *restore)
        left = status_codes(cwd)
        for r in results:
            if r["action"] == "restore":
                r["action"] = "restored" if r["path"] not in left else "restore-failed"
    stash_after = stash_entries(cwd)
    after_ids = {c for c, _ in stash_after}
    stash = {
        "before": len(stash_before),
        "after": len(stash_after),
        "kept": all(c in after_ids for c, _ in stash_before),
        "autoStash": [{"commit": c, "subject": s} for c, s in stash_after if AUTO_STASH_TAG in s],
    }
    unmerged_left = [] if dry_run else unmerged_paths(cwd)
    left_known = [r for r in results if r["action"] in ("leave", "restore-failed")]
    left_conflicts = [c for c in conflicts if c["action"] == "leave"]
    summary = {
        "resolvedConflicts": conflicts,
        "results": results,
        "unmergedLeft": unmerged_left,
        "stash": stash,
    }
    if not stash["kept"]:
        return summary, 3
    return summary, (1 if (left_known or left_conflicts or unmerged_left) else 0)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--install-dir", required=True, help="the install's git work-tree top")
    ap.add_argument("--dry-run", action="store_true", help="decide and report, change nothing")
    ap.add_argument("--resolve-conflicts", action="store_true",
                    help="first check out EVERY unmerged path from HEAD and `git reset -q` "
                         "(only with a marveen-update-auto-stash entry present; it is never dropped)")
    ap.add_argument("--json", action="store_true", help="one JSON object on stdout")
    a = ap.parse_args(argv)
    try:
        summary, code = run(a.install_dir, a.dry_run, a.resolve_conflicts)
    except GitError as e:
        if a.json:
            print(json.dumps({"version": 1, "ok": False, "exitCode": 2, "error": str(e)}))
        else:
            print("install-drift-repair: %s" % e, file=sys.stderr)
        return 2
    if a.json:
        print(json.dumps(dict({"version": 1, "ok": code == 0, "exitCode": code, "dryRun": a.dry_run}, **summary)))
    else:
        for c in summary["resolvedConflicts"]:
            print("install-drift-repair: %-22s UU %s (%s)" % (c["path"], c["action"], c["reason"]))
        if not summary["results"] and not summary["resolvedConflicts"]:
            print("install-drift-repair: the known install files are clean")
        for r in summary["results"]:
            print("install-drift-repair: %-22s %s %s (%s)" % (r["path"], r["status"], r["action"], r["reason"]))
        st = summary["stash"]
        print("install-drift-repair: stash entries %d -> %d, kept=%s" % (st["before"], st["after"], st["kept"]))
    return code


if __name__ == "__main__":
    sys.exit(main())
