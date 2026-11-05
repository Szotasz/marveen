#!/usr/bin/env python3
"""INSTALLDIRTYTREE1103: install-drift-repair.py restores ONLY the install-generated drift.

Every case builds a throwaway git repo shaped like an install (the shipped
.claude/settings.json is the repo's own, so the compact shape is real), applies the
drift a v1.45/v1.46 install produced, and runs the script as a subprocess -- the way
update.sh, the dashboard and the Bridge run it. The unmerged cases are produced by a
REAL conflicting `git stash pop`, the marveen2 sequence of 11-03.

Run: python3 scripts/__tests__/install-drift-repair.test.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

# A run without --backup-dir would write ~/.marveen-repair: point HOME at a temp dir for
# the whole test process, so no test can touch the real one.
os.environ["HOME"] = tempfile.mkdtemp(prefix="driftrepair-home-")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "scripts", "install-drift-repair.py")
SHIPPED_SETTINGS = open(os.path.join(ROOT, ".claude", "settings.json"), "rb").read()
MARKER = "# --- INSTWIZ1 headless-install helpers (contract) BEGIN ---"
LOCK = (b'{\n  "packages": {\n    "node_modules/better-sqlite3": {\n      "version": "13.0.3",\n'
        b'      "integrity": "sha512-x",\n      "license": "MIT"\n    }\n  }\n}\n')
LOCK_NPM = LOCK.replace(b'"integrity": "sha512-x",\n', b'"integrity": "sha512-x",\n      "hasInstallScript": true,\n')
INSTALLER = b"#!/bin/bash\nINSTALL_STEP=\"init\"\necho install\n"
# REPAIRSLACKOFF1105: the launchers decide whether restoring settings.json is safe. A tree from
# this branch on passes the PRIMARY plugin at launch; a v1.46.1 tree (main 00d82dbb) only the extras.
LAUNCHERS_PRIMARY = {
    "scripts/channels.sh": b'EXTRA_SETTINGS_FLAG="$(main_extra_settings_flag "$INSTALL_DIR" "$PLUGIN_ID" $CHANNEL_PLUGINS_EXTRA)"\n',
    "scripts/channel-watchdog.sh": b'EXTRA_SETTINGS_FLAG="$(main_extra_settings_flag "$INSTALL_DIR" "$PRIMARY_PLUGIN_ID" $CHANNEL_PLUGINS_EXTRA)"\n',
}
LAUNCHERS_V1461 = {  # verbatim from main 00d82dbb: channels.sh:684, channel-watchdog.sh:126
    "scripts/channels.sh": b'EXTRA_SETTINGS_FLAG="$(main_extra_settings_flag "$INSTALL_DIR" $CHANNEL_PLUGINS_EXTRA)"\n',
    "scripts/channel-watchdog.sh": b'EXTRA_SETTINGS_FLAG="$(main_extra_settings_flag "$INSTALL_DIR" $CHANNEL_PLUGINS_EXTRA)"\n',
}


def cli_enable(raw, key, value=True):
    """What `claude plugin enable --scope project` produced on marveen2: indent=2, enabledPlugins last."""
    d = json.loads(raw)
    plugins = d.pop("enabledPlugins", {})
    plugins[key] = value
    d["enabledPlugins"] = plugins
    return (json.dumps(d, indent=2) + "\n").encode()


class Repo:
    def __init__(self, launchers=LAUNCHERS_PRIMARY):
        self.dir = tempfile.mkdtemp(prefix="driftrepair-")
        self.backups = tempfile.mkdtemp(prefix="driftrepair-bak-")
        self.git("init", "-q")
        for rel, data in launchers.items():
            self.write(rel, data, mode=0o755)
        self.write(".claude/settings.json", SHIPPED_SETTINGS)
        self.write("install-macos.sh", INSTALLER, mode=0o755)
        self.write("install-linux.sh", INSTALLER, mode=0o755)
        self.write("package-lock.json", LOCK)
        self.write("README.md", b"readme\n")
        self.commit("base")

    def git(self, *args, check=True):
        return subprocess.run(["git", "-C", self.dir, "-c", "user.email=t@t", "-c", "user.name=t"] + list(args),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)

    def write(self, rel, data, mode=None):
        p = os.path.join(self.dir, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)
        if mode is not None:
            os.chmod(p, mode)

    def read(self, rel):
        with open(os.path.join(self.dir, rel), "rb") as f:
            return f.read()

    def commit(self, msg):
        self.git("add", "-A")
        self.git("commit", "-qm", msg)

    def status(self):
        return self.git("status", "--porcelain", "--untracked-files=no").stdout.decode()

    def repair(self, *extra):
        p = subprocess.run([sys.executable, "-I", SCRIPT, "--install-dir", self.dir, "--backup-dir", self.backups,
                            "--json"] + list(extra),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return p.returncode, json.loads(p.stdout.decode())

    def actions(self, out):
        return {r["path"]: r["action"] for r in out["results"]}

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)
        shutil.rmtree(self.backups, ignore_errors=True)


class Base(unittest.TestCase):
    def setUp(self):
        self.r = Repo()

    def tearDown(self):
        self.r.close()


class Restores(Base):
    def test_clean_tree_is_a_no_op(self):
        code, out = self.r.repair()
        self.assertEqual((code, out["state"], out["results"]), (0, "nothing_to_do", []))

    def test_marveen2_fresh_bridge_install_all_three(self):
        # The exact marveen2 shape: telegram@marveen-marketplace added + reformat,
        # the Bridge's headless installer at 0644, the npm lock line.
        self.r.write(".claude/settings.json", cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))
        self.r.write("install-macos.sh", INSTALLER + (MARKER + "\nprompt_or_preset() { :; }\n").encode(), mode=0o644)
        self.r.write("package-lock.json", LOCK_NPM)
        self.r.write("README.md", b"customer note\n")  # unrelated: never touched
        code, out = self.r.repair()
        self.assertEqual((code, out["state"]), (0, "ok"), out)
        self.assertEqual(self.r.actions(out), {".claude/settings.json": "restored", "install-macos.sh": "restored",
                                               "package-lock.json": "restored"})
        self.assertEqual(self.r.status(), " M README.md\n")
        self.assertEqual(self.r.read(".claude/settings.json"), SHIPPED_SETTINGS)
        self.assertEqual(os.stat(os.path.join(self.r.dir, "install-macos.sh")).st_mode & 0o777, 0o755)

    def test_slack_install_shipped_channel_value_flip(self):
        self.r.write(".claude/settings.json", cli_enable(SHIPPED_SETTINGS, "slack-channel@marveen-marketplace", True))
        code, out = self.r.repair()
        self.assertEqual((code, self.r.actions(out)), (0, {".claude/settings.json": "restored"}))

    def test_mode_only_installer_change(self):
        os.chmod(os.path.join(self.r.dir, "install-linux.sh"), 0o644)
        code, out = self.r.repair()
        self.assertEqual((code, self.r.actions(out)), (0, {"install-linux.sh": "restored"}))
        self.assertEqual(self.r.status(), "")

    def test_dry_run_changes_nothing(self):
        self.r.write("package-lock.json", LOCK_NPM)
        code, out = self.r.repair("--dry-run")
        self.assertEqual((code, self.r.actions(out)), (0, {"package-lock.json": "restore"}))
        self.assertEqual(self.r.status(), " M package-lock.json\n")


class Leaves(Base):
    """Anything that is not ours stays (REPAIR_LEFT); the update then takes the stash path."""

    def assertLeft(self, path, reason_part):
        before = self.r.read(path)
        code, out = self.r.repair()
        self.assertEqual((code, out["state"]), (0, "nothing_to_do"), out)
        self.assertEqual(self.r.actions(out)[path], "leave")
        self.assertIn(reason_part, [r for r in out["results"] if r["path"] == path][0]["reason"])
        self.assertEqual(self.r.read(path), before)

    def test_customer_enabled_their_own_plugin(self):
        # Samu 67320 point 2: a project-level plugin the CUSTOMER enabled must survive.
        raw = cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace")
        self.r.write(".claude/settings.json", cli_enable(raw, "frontend-design@claude-plugins-official"))
        self.assertLeft(".claude/settings.json", "key added: frontend-design@claude-plugins-official")

    def test_customer_enabled_an_unknown_marketplace_key(self):
        self.r.write(".claude/settings.json", cli_enable(SHIPPED_SETTINGS, "whatsapp@marveen-marketplace"))
        self.assertLeft(".claude/settings.json", "key added: whatsapp@marveen-marketplace")

    def test_generated_key_set_false_is_not_ours(self):
        self.r.write(".claude/settings.json", cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace", False))
        self.assertLeft(".claude/settings.json", "key added")

    def test_hook_or_permission_edit(self):
        d = json.loads(SHIPPED_SETTINGS)
        d["permissions"]["deny"].append("Bash(rm:*)")
        self.r.write(".claude/settings.json", (json.dumps(d, indent=2) + "\n").encode())
        self.assertLeft(".claude/settings.json", "outside enabledPlugins")

    def test_shipped_channel_key_removed(self):
        d = json.loads(SHIPPED_SETTINGS)
        del d["enabledPlugins"]["slack-channel@marveen-marketplace"]
        self.r.write(".claude/settings.json", (json.dumps(d, indent=2) + "\n").encode())
        self.assertLeft(".claude/settings.json", "key removed")

    def test_invalid_json(self):
        self.r.write(".claude/settings.json", SHIPPED_SETTINGS[:-20])
        self.assertLeft(".claude/settings.json", "not valid JSON")

    def test_customer_edited_installer(self):
        self.r.write("install-macos.sh", INSTALLER + b"echo my change\n", mode=0o755)
        self.assertLeft("install-macos.sh", "not the Bridge")

    def test_other_lock_change(self):
        self.r.write("package-lock.json", LOCK_NPM.replace(b"13.0.3", b"13.0.4"))
        self.assertLeft("package-lock.json", "beyond hasInstallScript")

    def test_staged_customer_change_blocks_even_if_work_tree_is_ours(self):
        raw = cli_enable(SHIPPED_SETTINGS, "frontend-design@claude-plugins-official")
        self.r.write(".claude/settings.json", raw)
        self.r.git("add", ".claude/settings.json")
        self.r.write(".claude/settings.json", cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))
        self.assertLeft(".claude/settings.json", "index")

    def test_merge_in_progress_touches_nothing(self):
        self.r.write("package-lock.json", LOCK_NPM)
        head = self.r.git("rev-parse", "HEAD").stdout.decode().strip()
        with open(os.path.join(self.r.dir, ".git", "MERGE_HEAD"), "w") as f:
            f.write(head + "\n")
        code, out = self.r.repair()
        self.assertEqual((code, out["state"]), (3, "refused:operation_in_progress"))
        self.assertEqual(self.r.status(), " M package-lock.json\n")

    def test_not_the_top_of_a_work_tree(self):
        p = subprocess.run([sys.executable, "-I", SCRIPT, "--install-dir", os.path.join(self.r.dir, ".claude"), "--json"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(p.returncode, 3)
        self.assertEqual(json.loads(p.stdout)["state"], "refused:not_a_repo")


class ConflictedStashPop(Base):
    """marveen2, 11-03: dirty install -> auto-stash -> pull (upstream changed settings.json) -> stash pop UU."""

    def make_conflict(self, local_settings):
        self.r.write(".claude/settings.json", local_settings)
        self.r.write("README.md", b"customer note\n")
        self.r.git("stash", "push", "-q", "-m", "marveen-update-auto-stash test")
        # A real upstream edit inside a compact one-line hook entry: the reformatted
        # local side rewrote exactly those lines, so the 3-way merge must conflict.
        upstream = SHIPPED_SETTINGS.replace(b'ledger-capture.py\\"", "timeout": 15', b'ledger-capture.py\\"", "timeout": 20', 1)
        self.assertNotEqual(upstream, SHIPPED_SETTINGS)
        self.r.write(".claude/settings.json", upstream)
        self.r.commit("upstream release")
        pop = self.r.git("stash", "pop", check=False)
        self.assertNotEqual(pop.returncode, 0)
        self.assertIn("UU .claude/settings.json", self.r.status())
        return upstream

    def test_ours_on_the_stash_side_is_resolved_to_head_and_the_stash_stays(self):
        upstream = self.make_conflict(cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))
        code, out = self.r.repair()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.r.actions(out), {".claude/settings.json": "restored"})
        self.assertEqual(self.r.read(".claude/settings.json"), upstream)
        json.loads(self.r.read(".claude/settings.json"))
        self.assertNotIn("UU", self.r.status())
        self.assertIn("marveen-update-auto-stash test", self.r.git("stash", "list").stdout.decode())

    def test_a_customer_key_on_the_stash_side_stays_unmerged(self):
        raw = cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace")
        self.make_conflict(cli_enable(raw, "frontend-design@claude-plugins-official"))
        code, out = self.r.repair()
        self.assertEqual((code, out["state"]), (3, "refused:unknown_change"))
        self.assertEqual(self.r.actions(out), {".claude/settings.json": "leave"})
        self.assertIn("UU .claude/settings.json", self.r.status())


class ResolveConflictsMode(Base):
    """BRIDGEREPAIR1103: the Bridge repair step passes --resolve-conflicts."""

    make_conflict = ConflictedStashPop.make_conflict

    def test_customer_key_on_the_stash_side_is_resolved_and_preserved_in_the_stash(self):
        raw = cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace")
        local = cli_enable(raw, "frontend-design@claude-plugins-official")
        upstream = self.make_conflict(local)
        stash_commit = self.r.git("rev-parse", "stash@{0}").stdout.decode().strip()
        code, out = self.r.repair("--resolve-conflicts")
        self.assertEqual(code, 0, out)
        self.assertEqual([(c["path"], c["action"]) for c in out["resolvedConflicts"]],
                         [(".claude/settings.json", "resolved-to-head")])
        self.assertEqual(out["unmergedLeft"], [])
        self.assertEqual(self.r.read(".claude/settings.json"), upstream)
        self.assertEqual(self.r.git("diff", "--cached", "--name-only").stdout.decode(), "")  # git reset -q ran
        # the customer's key is NOT lost: it is in the kept stash entry
        self.assertEqual(out["stash"]["before"], 1)
        self.assertEqual(out["stash"]["after"], 1)
        self.assertTrue(out["stash"]["kept"])
        self.assertEqual(out["stash"]["autoStash"][0]["commit"], stash_commit)
        self.assertIn(b"frontend-design@claude-plugins-official",
                      self.r.git("show", "stash@{0}:.claude/settings.json").stdout)

    def test_any_unmerged_path_is_resolved_not_only_the_known_ones(self):
        self.r.write("CLAUDE.md", b"line\n")
        self.r.commit("add CLAUDE.md")
        self.r.write("CLAUDE.md", b"customer line\n")
        self.r.git("stash", "push", "-q", "-m", "marveen-update-auto-stash x")
        self.r.write("CLAUDE.md", b"upstream line\n")
        self.r.commit("upstream")
        self.assertNotEqual(self.r.git("stash", "pop", check=False).returncode, 0)
        code, out = self.r.repair("--resolve-conflicts")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.r.read("CLAUDE.md"), b"upstream line\n")
        self.assertEqual(self.r.status(), "")
        self.assertTrue(out["stash"]["kept"])

    def test_refuses_without_an_auto_stash_entry(self):
        self.make_conflict(cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))
        # rename the entry: no marveen-update-auto-stash left in the list
        c = self.r.git("rev-parse", "stash@{0}").stdout.decode().strip()
        self.r.git("stash", "drop", "-q")
        self.r.git("stash", "store", "-m", "someone else's stash", c)
        code, out = self.r.repair("--resolve-conflicts")
        self.assertEqual((code, out["ok"], out["exitCode"], out["state"]), (3, False, 3, "refused:no_auto_stash"))
        self.assertIn("auto-stash", out["error"])
        self.assertIn("UU .claude/settings.json", self.r.status())

    def test_dry_run_reports_and_changes_nothing(self):
        self.make_conflict(cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))
        before = self.r.status()
        code, out = self.r.repair("--resolve-conflicts", "--dry-run")
        self.assertEqual([(c["path"], c["action"]) for c in out["resolvedConflicts"]],
                         [(".claude/settings.json", "resolve")])
        self.assertEqual(self.r.status(), before)

    def test_json_contract_v1(self):
        code, out = self.r.repair("--resolve-conflicts")
        self.assertEqual(code, 0)
        self.assertEqual(set(out), {"version", "ok", "state", "exitCode", "dryRun", "resolvedConflicts", "results",
                                    "unmergedLeft", "stash", "treeClean", "dirtyLeft", "backupDir",
                                    "conflictsLeft", "markersLeft"})
        self.assertEqual((out["treeClean"], out["dirtyLeft"], out["backupDir"]), (True, [], None))
        self.assertEqual(out["state"], "nothing_to_do")
        self.assertEqual(out["version"], 1)
        self.assertEqual(set(out["stash"]), {"before", "after", "kept", "autoStash"})

    def test_a_lost_stash_entry_is_exit_3_not_success(self):
        # The script never drops a stash; this guards the CHECK itself: inject a
        # resolver that drops the entry and the run must say so (exit 3, kept=False).
        import importlib.util
        spec = importlib.util.spec_from_file_location("install_drift_repair", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.make_conflict(cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))
        real = mod.resolve_all_conflicts

        def dropping(cwd, dry_run, backup_dir):
            out = real(cwd, dry_run, backup_dir)
            mod.git(cwd, "stash", "drop", "-q")
            return out
        mod.resolve_all_conflicts = dropping
        summary, state = mod.run(self.r.dir, False, True, self.r.backups)
        self.assertEqual(state, "failed:stash_check")
        self.assertEqual(mod.exit_code(state), 1)
        self.assertFalse(summary["stash"]["kept"])

    def test_install_dir_is_required(self):
        p = subprocess.run([sys.executable, "-I", SCRIPT, "--json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(p.returncode, 2)  # argparse usage error


class LineProtocol(Base):
    """BRIDGEREPAIR1103 (Geri 67333): the Bridge parses ONLY REPAIR_* lines, run from stdin."""

    make_conflict = ConflictedStashPop.make_conflict

    def lines(self, *extra, stdin=False):
        if stdin:
            with open(SCRIPT, "rb") as f:
                p = subprocess.run([sys.executable, "-I", "-", "--install-dir", self.r.dir, "--backup-dir", self.r.backups,
                                    "--lines"] + list(extra),
                                   stdin=f, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=tempfile.gettempdir())
        else:
            p = subprocess.run([sys.executable, "-I", SCRIPT, "--install-dir", self.r.dir, "--backup-dir", self.r.backups,
                                "--lines"] + list(extra),
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out = p.stdout.decode().splitlines()
        for line in out:  # the allowlist: nothing else on stdout
            self.assertRegex(line, r"^REPAIR_(STEP|RESTORED|CLEANED|LEFT|STASH|RESULT) ")
        self.assertEqual(sum(1 for l in out if l.startswith("REPAIR_RESULT ")), 1)
        self.assertTrue(out[-1].startswith("REPAIR_RESULT "))
        return p.returncode, out

    def test_marveen2_conflict_from_stdin_exact_lines_then_idempotent(self):
        self.make_conflict(cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))
        self.r.write("install-macos.sh", INSTALLER + (MARKER + "\n").encode(), mode=0o644)
        self.r.write("package-lock.json", LOCK_NPM)
        code, out = self.lines("--resolve-conflicts", stdin=True)
        self.assertEqual(code, 0)
        self.assertEqual(out, [
            "REPAIR_STEP repair",
            "REPAIR_RESTORED .claude/settings.json",
            "REPAIR_CLEANED install-macos.sh headless_installer",
            "REPAIR_CLEANED package-lock.json lock_has_install_script",
            "REPAIR_STASH before=1 after=1",
            "REPAIR_RESULT ok",
        ])
        code, out = self.lines("--resolve-conflicts", stdin=True)
        self.assertEqual((code, out[-2:]), (0, ["REPAIR_STASH before=1 after=1", "REPAIR_RESULT nothing_to_do"]))

    def test_dry_run_lines_change_nothing(self):
        self.make_conflict(cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))
        before = self.r.status()
        code, out = self.lines("--resolve-conflicts", "--dry-run")
        self.assertEqual(code, 0)
        self.assertEqual(out[0], "REPAIR_STEP dry_run")
        self.assertIn("REPAIR_RESTORED .claude/settings.json", out)
        self.assertEqual(self.r.status(), before)

    def test_left_and_cleaned_with_a_settings_pattern(self):
        self.r.write(".claude/settings.json", cli_enable(SHIPPED_SETTINGS, "slack-channel@marveen-marketplace"))
        self.r.write("install-linux.sh", INSTALLER + b"echo mine\n", mode=0o755)
        code, out = self.lines()
        self.assertEqual(code, 0)
        self.assertIn("REPAIR_CLEANED .claude/settings.json settings_enabled_plugins", out)
        self.assertIn("REPAIR_LEFT install-linux.sh", out)

    def test_a_path_outside_the_safe_charset_is_percent_encoded(self):
        self.r.write("my notes é.md", b"a\n")
        self.r.commit("add")
        self.r.write("my notes é.md", b"customer\n")
        self.r.git("stash", "push", "-q", "-m", "marveen-update-auto-stash enc")
        self.r.write("my notes é.md", b"upstream\n")
        self.r.commit("upstream")
        self.assertNotEqual(self.r.git("stash", "pop", check=False).returncode, 0)
        code, out = self.lines("--resolve-conflicts")
        self.assertEqual(code, 0)
        self.assertIn("REPAIR_RESTORED my%20notes%20%C3%A9.md", out)

    def test_refusals_are_exit_3_with_one_result_line(self):
        code, out = self.lines()  # clean tree first: nothing_to_do
        self.assertEqual((code, out[-1]), (0, "REPAIR_RESULT nothing_to_do"))
        p = subprocess.run([sys.executable, "-I", SCRIPT, "--install-dir", os.path.join(self.r.dir, ".claude"), "--lines"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual((p.returncode, p.stdout.decode()), (3, "REPAIR_RESULT refused:not_a_repo\n"))
        self.make_conflict(cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))
        c = self.r.git("rev-parse", "stash@{0}").stdout.decode().strip()
        self.r.git("stash", "drop", "-q")
        self.r.git("stash", "store", "-m", "not ours", c)
        code, out = self.lines("--resolve-conflicts")
        self.assertEqual((code, out), (3, ["REPAIR_RESULT refused:no_auto_stash"]))


class GeriReview(Base):
    """Geri 67344: index.lock, whole-tree status, backups of every overwritten file."""

    make_conflict = ConflictedStashPop.make_conflict

    def test_index_lock_refuses_and_changes_nothing(self):
        self.r.write("package-lock.json", LOCK_NPM)
        open(os.path.join(self.r.dir, ".git", "index.lock"), "w").close()
        code, out = self.r.repair()
        self.assertEqual((code, out["state"]), (3, "refused:index_locked"))
        self.assertEqual(self.r.read("package-lock.json"), LOCK_NPM)

    def test_whole_tree_status_next_to_exit_0(self):
        self.make_conflict(cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))  # README.md also dirty
        code, out = self.r.repair("--resolve-conflicts")
        self.assertEqual((code, out["state"]), (0, "ok"))
        self.assertEqual((out["treeClean"], out["dirtyLeft"]), (False, ["README.md"]))

    def test_every_overwritten_file_is_backed_up_first_markers_included(self):
        self.make_conflict(cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))
        self.r.write("package-lock.json", LOCK_NPM)
        code, out = self.r.repair("--resolve-conflicts")
        self.assertEqual(code, 0, out)
        conflict = out["resolvedConflicts"][0]
        with open(conflict["backup"], "rb") as f:
            self.assertIn(b"<<<<<<< ", f.read())
        self.assertTrue(conflict["backup"].startswith(os.path.realpath(self.r.backups) + os.sep))
        lock = [r for r in out["results"] if r["path"] == "package-lock.json"][0]
        with open(lock["backup"], "rb") as f:
            self.assertEqual(f.read(), LOCK_NPM)
        self.assertEqual(out["backupDir"], os.path.realpath(self.r.backups))

    def test_dry_run_writes_no_backup(self):
        self.make_conflict(cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))
        self.r.repair("--resolve-conflicts", "--dry-run")
        self.assertEqual(os.listdir(self.r.backups), [])

    def test_a_backup_dir_inside_the_tree_is_refused(self):
        self.r.write("package-lock.json", LOCK_NPM)
        p = subprocess.run([sys.executable, "-I", SCRIPT, "--install-dir", self.r.dir,
                            "--backup-dir", os.path.join(self.r.dir, "bak"), "--json"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual((p.returncode, json.loads(p.stdout)["state"]), (3, "refused:backup_inside_tree"))
        self.assertEqual(self.r.read("package-lock.json"), LOCK_NPM)

    def test_default_backup_dir_is_under_home_marveen_repair(self):
        self.r.write("package-lock.json", LOCK_NPM)
        p = subprocess.run([sys.executable, "-I", SCRIPT, "--install-dir", self.r.dir, "--json"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out = json.loads(p.stdout)
        self.assertTrue(out["backupDir"].startswith(os.path.realpath(os.path.join(os.environ["HOME"], ".marveen-repair", "backup-"))))


class UnresolvableConflict(Base):
    """Samu 67345: an unmerged path not in HEAD survives the reset as a plain file -- name it."""

    def test_modify_delete_conflict_is_named_and_not_ok(self):
        self.r.write("notes.md", b"base\n")
        self.r.commit("add notes")
        self.r.write("notes.md", b"customer\n")
        self.r.git("stash", "push", "-q", "-m", "marveen-update-auto-stash md")
        self.r.git("rm", "-q", "notes.md")
        self.r.commit("upstream deletes notes")
        self.assertNotEqual(self.r.git("stash", "pop", check=False).returncode, 0)
        self.assertRegex(self.r.status(), r"(DU|UD) notes.md")
        code, out = self.r.repair("--resolve-conflicts")
        self.assertEqual((code, out["state"]), (3, "refused:unknown_change"), out)
        self.assertEqual((out["conflictsLeft"], out["markersLeft"]), (["notes.md"], []))
        self.assertTrue(out["stash"]["kept"])

    def test_has_markers(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("idr", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.r.write("a.txt", b"x\n<<<<<<< Updated upstream\ny\n=======\nz\n>>>>>>> Stashed changes\n")
        self.r.write("b.txt", b"a markdown rule\n=======\n")
        self.assertTrue(mod.has_markers(os.path.join(self.r.dir, "a.txt")))
        self.assertFalse(mod.has_markers(os.path.join(self.r.dir, "b.txt")))


class PrimaryPluginStaysOn(unittest.TestCase):
    """REPAIRSLACKOFF1105 (Dani 70671): on a tree whose launchers do not enable the primary
    plugin themselves (v1.46.1), restoring settings.json from HEAD would switch the main channel
    off at the next restart. There the file is NOT ours: it is left, never restored."""

    def setUp(self):
        self.r = Repo(launchers=LAUNCHERS_V1461)

    def tearDown(self):
        self.r.close()

    def reason(self, out, path):
        return [r for r in out["results"] if r["path"] == path][0]["reason"]

    def test_v1461_slack_enabled_by_the_installer_is_left_not_restored(self):
        enabled = cli_enable(SHIPPED_SETTINGS, "slack-channel@marveen-marketplace", True)
        self.r.write(".claude/settings.json", enabled)
        code, out = self.r.repair()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.r.actions(out), {".claude/settings.json": "leave"})
        self.assertIn("launchers do not enable the primary plugin", self.reason(out, ".claude/settings.json"))
        self.assertEqual(self.r.read(".claude/settings.json"), enabled, "the file is untouched: slack stays true")

    def test_v1461_an_added_marketplace_channel_is_left_too(self):
        self.r.write(".claude/settings.json", cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))
        code, out = self.r.repair()
        self.assertEqual(self.r.actions(out), {".claude/settings.json": "leave"})

    def test_v1461_formatting_only_is_still_restored(self):
        # Nothing switches off: the restore only undoes the reformat, so it stays safe.
        self.r.write(".claude/settings.json", (json.dumps(json.loads(SHIPPED_SETTINGS), indent=2) + "\n").encode())
        code, out = self.r.repair()
        self.assertEqual((code, self.r.actions(out)), (0, {".claude/settings.json": "restored"}))
        self.assertEqual(self.r.read(".claude/settings.json"), SHIPPED_SETTINGS)

    def test_v1461_other_cleanups_still_run(self):
        self.r.write(".claude/settings.json", cli_enable(SHIPPED_SETTINGS, "slack-channel@marveen-marketplace", True))
        self.r.write("install-linux.sh", INSTALLER + (MARKER + "\n").encode(), mode=0o644)
        code, out = self.r.repair()
        self.assertEqual(self.r.actions(out), {".claude/settings.json": "leave", "install-linux.sh": "restored"})

    def test_v1461_bridge_lines_say_left(self):
        self.r.write(".claude/settings.json", cli_enable(SHIPPED_SETTINGS, "slack-channel@marveen-marketplace", True))
        p = subprocess.run([sys.executable, "-I", SCRIPT, "--install-dir", self.r.dir, "--backup-dir", self.r.backups,
                            "--lines", "--dry-run"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out = p.stdout.decode().splitlines()
        self.assertIn("REPAIR_LEFT .claude/settings.json", out)
        self.assertFalse(any(l.startswith("REPAIR_CLEANED .claude/settings.json") for l in out), out)

    def test_a_commented_out_primary_line_does_not_count(self):
        self.r.write("scripts/channels.sh", b"# " + LAUNCHERS_PRIMARY["scripts/channels.sh"])
        self.r.write("scripts/channel-watchdog.sh", LAUNCHERS_PRIMARY["scripts/channel-watchdog.sh"])
        self.r.write(".claude/settings.json", cli_enable(SHIPPED_SETTINGS, "slack-channel@marveen-marketplace", True))
        code, out = self.r.repair()
        self.assertEqual(self.r.actions(out), {".claude/settings.json": "leave"})

    def test_both_launchers_are_required_and_a_missing_one_fails_closed(self):
        self.r.write("scripts/channels.sh", LAUNCHERS_PRIMARY["scripts/channels.sh"])  # watchdog still v1.46.1
        self.r.write(".claude/settings.json", cli_enable(SHIPPED_SETTINGS, "slack-channel@marveen-marketplace", True))
        code, out = self.r.repair()
        self.assertEqual(self.r.actions(out), {".claude/settings.json": "leave"})
        os.remove(os.path.join(self.r.dir, "scripts", "channel-watchdog.sh"))
        code, out = self.r.repair()
        self.assertEqual(self.r.actions(out), {".claude/settings.json": "leave"})

    def test_primary_launchers_restore_as_before(self):
        for rel, data in LAUNCHERS_PRIMARY.items():
            self.r.write(rel, data)
        self.r.commit("launchers from this branch")
        self.r.write(".claude/settings.json", cli_enable(SHIPPED_SETTINGS, "slack-channel@marveen-marketplace", True))
        code, out = self.r.repair()
        self.assertEqual((code, self.r.actions(out)), (0, {".claude/settings.json": "restored"}))

    def test_the_real_launchers_match_the_detector(self):
        # The patterns must match THIS tree's real channels.sh / channel-watchdog.sh, or every
        # repair here would leave settings.json for nothing.
        import importlib.util
        spec = importlib.util.spec_from_file_location("idr", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.assertTrue(mod.launchers_pass_primary(ROOT))


if __name__ == "__main__":
    unittest.main(verbosity=1)
