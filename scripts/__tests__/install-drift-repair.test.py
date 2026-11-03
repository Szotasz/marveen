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

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "scripts", "install-drift-repair.py")
SHIPPED_SETTINGS = open(os.path.join(ROOT, ".claude", "settings.json"), "rb").read()
MARKER = "# --- INSTWIZ1 headless-install helpers (contract) BEGIN ---"
LOCK = (b'{\n  "packages": {\n    "node_modules/better-sqlite3": {\n      "version": "13.0.3",\n'
        b'      "integrity": "sha512-x",\n      "license": "MIT"\n    }\n  }\n}\n')
LOCK_NPM = LOCK.replace(b'"integrity": "sha512-x",\n', b'"integrity": "sha512-x",\n      "hasInstallScript": true,\n')
INSTALLER = b"#!/bin/bash\nINSTALL_STEP=\"init\"\necho install\n"


def cli_enable(raw, key, value=True):
    """What `claude plugin enable --scope project` produced on marveen2: indent=2, enabledPlugins last."""
    d = json.loads(raw)
    plugins = d.pop("enabledPlugins", {})
    plugins[key] = value
    d["enabledPlugins"] = plugins
    return (json.dumps(d, indent=2) + "\n").encode()


class Repo:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="driftrepair-")
        self.git("init", "-q")
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
        p = subprocess.run([sys.executable, "-I", SCRIPT, "--install-dir", self.dir, "--json"] + list(extra),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return p.returncode, json.loads(p.stdout.decode())

    def actions(self, out):
        return {r["path"]: r["action"] for r in out["results"]}

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class Base(unittest.TestCase):
    def setUp(self):
        self.r = Repo()

    def tearDown(self):
        self.r.close()


class Restores(Base):
    def test_clean_tree_is_a_no_op(self):
        code, out = self.r.repair()
        self.assertEqual((code, out["results"]), (0, []))

    def test_marveen2_fresh_bridge_install_all_three(self):
        # The exact marveen2 shape: telegram@marveen-marketplace added + reformat,
        # the Bridge's headless installer at 0644, the npm lock line.
        self.r.write(".claude/settings.json", cli_enable(SHIPPED_SETTINGS, "telegram@marveen-marketplace"))
        self.r.write("install-macos.sh", INSTALLER + (MARKER + "\nprompt_or_preset() { :; }\n").encode(), mode=0o644)
        self.r.write("package-lock.json", LOCK_NPM)
        self.r.write("README.md", b"customer note\n")  # unrelated: never touched
        code, out = self.r.repair()
        self.assertEqual(code, 0, out)
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
    """Anything that is not ours stays, and the exit code says so (the stash path takes over)."""

    def assertLeft(self, path, reason_part):
        before = self.r.read(path)
        code, out = self.r.repair()
        self.assertEqual(code, 1, out)
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
        p = subprocess.run([sys.executable, "-I", SCRIPT, "--install-dir", self.r.dir],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(p.returncode, 2)
        self.assertEqual(self.r.status(), " M package-lock.json\n")

    def test_not_the_top_of_a_work_tree(self):
        p = subprocess.run([sys.executable, "-I", SCRIPT, "--install-dir", os.path.join(self.r.dir, ".claude")],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(p.returncode, 2)


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
        self.assertEqual(code, 1)
        self.assertEqual(self.r.actions(out), {".claude/settings.json": "leave"})
        self.assertIn("UU .claude/settings.json", self.r.status())


if __name__ == "__main__":
    unittest.main(verbosity=1)
