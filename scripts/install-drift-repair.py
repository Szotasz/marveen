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

Usage: install-drift-repair.py --install-dir DIR [--resolve-conflicts] [--dry-run] [--backup-dir DIR] [--json | --lines]

It never needs its own location: the Bridge runs it from stdin, with no file on
the target:  python3 -I - --install-dir "$HOME/marveen" --resolve-conflicts --lines < it

  --resolve-conflicts  the Bridge "repair install" mode (BRIDGEREPAIR1103): first
                       check out EVERY unmerged path from HEAD, then `git reset -q`,
                       then the narrow cleanup below. Allowed only while a
                       marveen-update-auto-stash entry exists, because the local side
                       of every conflict lives on in it. update.sh and the dashboard
                       do NOT pass it.
  --lines              the Bridge's line protocol on stdout, nothing else:
                         REPAIR_STEP repair|dry_run
                         REPAIR_RESTORED <path>            an unmerged path checked out from HEAD
                         REPAIR_CLEANED <path> <pattern>   settings_enabled_plugins | headless_installer
                                                           | installer_mode_only | lock_has_install_script
                         REPAIR_LEFT <path>                not ours, untouched
                         REPAIR_STASH before=<n> after=<n>
                         REPAIR_RESULT <state>             exactly one, always last
                       <path> is repo-relative; every byte outside [A-Za-z0-9._/-] is
                       %XX-encoded. Under --dry-run the same lines say what WOULD happen.
  --backup-dir DIR     every file is copied here BEFORE it is overwritten (conflict
                       markers included); must be outside the tree. Default
                       ~/.marveen-repair/backup-<UTC timestamp>. A dry run writes none.
  --json               one JSON object (version 1): {version, ok, state, exitCode, dryRun,
                       resolvedConflicts[{path, action, reason, backup}], results[{path,
                       status, action, reason, pattern, backup?}], unmergedLeft[],
                       stash{before, after, kept, autoStash[]}, treeClean, dirtyLeft[],
                       backupDir, conflictsLeft[], markersLeft[], error?}. exit 0 means UNBLOCKED (nothing unmerged, the
                       known paths clean); treeClean/dirtyLeft say whether the WHOLE
                       tracked tree is clean.

States and exit codes:
  ok | nothing_to_do                                       exit 0 (REPAIR_LEFT paths may remain
                                                           dirty: not ours, they take the stash path)
  refused:not_a_repo | refused:operation_in_progress |
  refused:index_locked | refused:backup_inside_tree |
  refused:no_auto_stash | refused:unknown_change           exit 3 (unknown_change: an unmerged path is
                                                           still left, or one could not be resolved:
                                                           conflictsLeft / markersLeft name it; otherwise
                                                           nothing changed)
  failed:<step>  (resolve_conflicts | cleanup | stash_check) exit 1 (stash_check: an entry that
                                                           existed before is gone; must never happen)
The stash is NEVER dropped, popped, cleared or applied; no reset --hard, no clean.
"""
import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import time

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

# Pattern ids, as the --lines protocol names them (REPAIR_CLEANED <path> <id>).
PATTERN_ID = {
    "settings": "settings_enabled_plugins",
    "installer": "headless_installer",
    "installer_mode": "installer_mode_only",
    "lock": "lock_has_install_script",
}


class Refused(Exception):
    """Cannot or must not run; nothing was changed. `state` goes after `refused:`."""

    def __init__(self, state, message):
        Exception.__init__(self, message)
        self.state = state


class Failed(Exception):
    """A git step failed midway. `step` goes after `failed:`."""

    def __init__(self, step, message):
        Exception.__init__(self, message)
        self.step = step


def pattern_of(path, reason):
    if path == SETTINGS:
        return PATTERN_ID["settings"]
    if path in INSTALL_SCRIPTS:
        return PATTERN_ID["installer_mode"] if reason == "mode-only change" else PATTERN_ID["installer"]
    return PATTERN_ID["lock"]


def stash_entries(cwd):
    """[(commit, subject)] of `git stash list`, newest first."""
    out = git(cwd, "stash", "list", "--format=%H%x09%gs").stdout.decode("utf-8", "replace")
    return [tuple(l.split("\t", 1)) for l in out.splitlines() if "\t" in l]


def unmerged_paths(cwd):
    out = git(cwd, "diff", "--name-only", "--diff-filter=U", "-z").stdout
    return sorted({p.decode("utf-8", "replace") for p in out.split(b"\0") if p})


def backup(cwd, backup_dir, path):
    """Copy the work-tree file (conflict markers and all) to backup_dir/<path> before
    it is overwritten. The stash keeps the PRE-pop local side; this keeps what the
    tree held at repair time (Geri 67344 (3)). Returns the backup path or None."""
    src = os.path.join(cwd, path)
    if not os.path.isfile(src) or os.path.islink(src):
        return None
    dst = os.path.join(backup_dir, path)
    os.makedirs(os.path.dirname(dst), mode=0o700, exist_ok=True)
    with open(src, "rb") as f, open(dst, "wb") as g:
        g.write(f.read())
    return dst


CONFLICT_MARKER = re.compile(rb"^(<<<<<<<|>>>>>>>) ", re.M)


def has_markers(path):
    if not os.path.isfile(path) or os.path.islink(path):
        return False
    with open(path, "rb") as f:
        return bool(CONFLICT_MARKER.search(f.read()))


def resolve_all_conflicts(cwd, dry_run, backup_dir):
    """--resolve-conflicts: every unmerged path -> HEAD, then `git reset -q`.

    Safe only because a conflicted `git stash pop` KEEPS the stash entry: the
    local side of every conflict is still in it. So this runs only when such an
    entry exists, and the caller verifies afterwards that no entry disappeared.
    """
    paths = unmerged_paths(cwd)
    if not paths:
        return []
    if not any(AUTO_STASH_TAG in subject for _, subject in stash_entries(cwd)):
        raise Refused("no_auto_stash", "unmerged paths but no %s entry in `git stash list`; the local "
                      "side would not be preserved, not resolving" % AUTO_STASH_TAG)
    out = []
    for path in paths:
        if blob(cwd, "HEAD:" + path) is None:
            out.append({"path": path, "action": "leave", "reason": "unmerged and not in HEAD"})
            continue
        saved = None
        if not dry_run:
            saved = backup(cwd, backup_dir, path)
            git(cwd, "checkout", "HEAD", "--", path)
        out.append({"path": path, "action": "resolve" if dry_run else "resolved-to-head",
                    "reason": "unmerged; the local side stays in the auto-stash", "backup": saved})
    if not dry_run:
        git(cwd, "reset", "-q")
    return out


def default_backup_dir():
    return os.path.join(os.path.expanduser("~"), ".marveen-repair",
                        "backup-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))


def run(install_dir, dry_run, resolve_conflicts=False, backup_dir=None):
    """Returns (summary, state). state: ok | nothing_to_do | refused:<why> | failed:<step>."""
    cwd = os.path.realpath(install_dir)
    try:
        top = git(cwd, "rev-parse", "--show-toplevel", check=False)
    except GitError as e:
        raise Refused("not_a_repo", str(e))
    if top.returncode != 0 or os.path.realpath(top.stdout.decode().strip()) != cwd:
        raise Refused("not_a_repo", "%s is not the top of a git work tree" % cwd)
    busy = operation_in_progress(cwd)
    if busy:
        raise Refused("operation_in_progress", "a git operation is in progress (%s); not touching anything" % busy)
    lock = git(cwd, "rev-parse", "--git-path", "index.lock").stdout.decode().strip()
    if os.path.exists(lock if os.path.isabs(lock) else os.path.join(cwd, lock)):
        # A running update.sh or git holds the index: a checkout would fail midway (Geri 67344).
        raise Refused("index_locked", "index.lock present; another git process is running, not touching anything")
    stash_before = stash_entries(cwd)
    step = "resolve_conflicts"
    try:
        backup_dir = os.path.realpath(backup_dir or default_backup_dir())
        if backup_dir == cwd or backup_dir.startswith(cwd + os.sep):
            raise Refused("backup_inside_tree", "the backup dir must be outside the work tree: %s" % backup_dir)
        conflicts = resolve_all_conflicts(cwd, dry_run, backup_dir) if resolve_conflicts else []
        step = "cleanup"
        pending = {c["path"] for c in conflicts if c["action"] == "resolve"}
        results = []
        restore = []
        for path, xy in sorted(status_codes(cwd).items()):
            if path in pending:
                continue  # dry run: would be resolved to HEAD first
            ok, why = decide(cwd, path, xy)
            results.append({"path": path, "status": xy, "action": "restore" if ok else "leave", "reason": why,
                            "pattern": pattern_of(path, why) if ok else None})
            if ok:
                restore.append(path)
        if restore and not dry_run:
            for r in results:
                if r["action"] == "restore":
                    r["backup"] = backup(cwd, backup_dir, r["path"])
            git(cwd, "checkout", "HEAD", "--", *restore)
            left = status_codes(cwd)
            for r in results:
                if r["action"] == "restore":
                    r["action"] = "restored" if r["path"] not in left else "restore-failed"
        step = "stash_check"
        stash_after = stash_entries(cwd)
        if dry_run:  # what WOULD still be unmerged afterwards
            unmerged_left = [u for u in unmerged_paths(cwd) if u not in pending and u not in restore]
        else:
            unmerged_left = unmerged_paths(cwd)
        dirty_left = sorted(
            e[3:].decode("utf-8", "replace") for e in
            git(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=no").stdout.split(b"\0") if len(e) > 3
        ) if not dry_run else None
    except GitError as e:
        raise Failed(step, str(e))
    after_ids = {c for c, _ in stash_after}
    stash = {
        "before": len(stash_before),
        "after": len(stash_after),
        "kept": all(c in after_ids for c, _ in stash_before),
        "autoStash": [{"commit": c, "subject": s} for c, s in stash_after if AUTO_STASH_TAG in s],
    }
    # Samu 67345: an unmerged path that could NOT be resolved (not in HEAD) loses its
    # unmerged state to the `git reset -q`, so unmergedLeft alone would miss it. Name it,
    # and say whether its file still carries conflict markers.
    conflicts_left = [c["path"] for c in conflicts if c["action"] == "leave"]
    markers_left = [p for p in conflicts_left if has_markers(os.path.join(cwd, p))]
    summary = {"resolvedConflicts": conflicts, "results": results, "unmergedLeft": unmerged_left, "stash": stash,
               "conflictsLeft": conflicts_left, "markersLeft": markers_left,
               # exit 0 = unblocked (nothing unmerged, the known paths clean). Whether the WHOLE
               # tracked tree is clean is a separate fact (Geri 67344 (2)): treeClean + dirtyLeft.
               "treeClean": (not dirty_left) if dirty_left is not None else None,
               "dirtyLeft": dirty_left,
               "backupDir": backup_dir if any(x.get("backup") for x in conflicts + results) else None}
    if not stash["kept"]:
        return summary, "failed:stash_check"
    if any(r["action"] == "restore-failed" for r in results):
        return summary, "failed:cleanup"
    # Still blocked: an unmerged path is left (a customer change in default mode, or not in HEAD).
    if unmerged_left or conflicts_left:
        return summary, "refused:unknown_change"
    acted = [c for c in conflicts if c["action"] in ("resolved-to-head", "resolve")] + \
        [r for r in results if r["action"] in ("restored", "restore")]
    return summary, ("ok" if acted else "nothing_to_do")


EXIT_FOR = {"ok": 0, "nothing_to_do": 0, "refused": 3, "failed": 1}


def exit_code(state):
    return EXIT_FOR[state.split(":", 1)[0]]


SAFE_PATH = re.compile(r"[A-Za-z0-9._/-]")


def line_path(path):
    """Percent-encode every byte outside [A-Za-z0-9._/-] so a path is one token."""
    out = []
    for ch in path:
        if SAFE_PATH.fullmatch(ch):
            out.append(ch)
        else:
            out.extend("%%%02X" % b for b in ch.encode("utf-8"))
    return "".join(out)


def emit_lines(summary, state, dry_run):
    w = sys.stdout.write
    if summary is not None:
        w("REPAIR_STEP %s\n" % ("dry_run" if dry_run else "repair"))
        for c in summary["resolvedConflicts"]:
            if c["action"] in ("resolved-to-head", "resolve"):
                w("REPAIR_RESTORED %s\n" % line_path(c["path"]))
            else:
                w("REPAIR_LEFT %s\n" % line_path(c["path"]))
        for r in summary["results"]:
            if r["action"] in ("restored", "restore"):
                w("REPAIR_CLEANED %s %s\n" % (line_path(r["path"]), r["pattern"]))
            else:
                w("REPAIR_LEFT %s\n" % line_path(r["path"]))
        for path in summary["unmergedLeft"]:
            if not any(x["path"] == path for x in summary["results"] + summary["resolvedConflicts"]):
                w("REPAIR_LEFT %s\n" % line_path(path))
        st = summary["stash"]
        w("REPAIR_STASH before=%d after=%d\n" % (st["before"], st["after"]))
    w("REPAIR_RESULT %s\n" % state)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--install-dir", required=True, help="the install's git work-tree top (absolute)")
    ap.add_argument("--dry-run", action="store_true", help="decide and report, change nothing")
    ap.add_argument("--resolve-conflicts", action="store_true",
                    help="first check out EVERY unmerged path from HEAD and `git reset -q` "
                         "(only with a marveen-update-auto-stash entry present; it is never dropped)")
    ap.add_argument("--backup-dir", help="where every overwritten file is copied first (outside the tree; "
                                        "default ~/.marveen-repair/backup-<UTC timestamp>)")
    fmt = ap.add_mutually_exclusive_group()
    fmt.add_argument("--json", action="store_true", help="one JSON object on stdout (version 1)")
    fmt.add_argument("--lines", action="store_true", help="the REPAIR_* line protocol on stdout (the Bridge)")
    a = ap.parse_args(argv)
    summary, error = None, None
    try:
        summary, state = run(a.install_dir, a.dry_run, a.resolve_conflicts, a.backup_dir)
    except Refused as e:
        state, error = "refused:" + e.state, str(e)
    except Failed as e:
        state, error = "failed:" + e.step, str(e)
    code = exit_code(state)
    if error:
        print("install-drift-repair: %s" % error, file=sys.stderr)
    if a.lines:
        emit_lines(summary, state, a.dry_run)
    elif a.json:
        doc = {"version": 1, "ok": code == 0, "state": state, "exitCode": code, "dryRun": a.dry_run}
        if summary is not None:
            doc.update(summary)
        if error:
            doc["error"] = error
        print(json.dumps(doc))
    elif summary is not None:
        for c in summary["resolvedConflicts"]:
            print("install-drift-repair: %-22s UU %s (%s)" % (c["path"], c["action"], c["reason"]))
        for r in summary["results"]:
            print("install-drift-repair: %-22s %s %s (%s)" % (r["path"], r["status"], r["action"], r["reason"]))
        st = summary["stash"]
        print("install-drift-repair: %s; stash entries %d -> %d, kept=%s" % (state, st["before"], st["after"], st["kept"]))
    else:
        print("install-drift-repair: %s" % state)
    return code


if __name__ == "__main__":
    sys.exit(main())
