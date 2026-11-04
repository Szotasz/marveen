#!/usr/bin/env python3
"""MANAGEDSETTINGSWRITE1103: scripts/lib/managed-settings-write.py, run as a subprocess the way the
installers run it. The ownership checks use the effective uid, so here (as the test user) they
are the same checks the installer makes as root.

Run: python3 scripts/__tests__/managed-settings-write.test.py
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HELPER = os.path.join(ROOT, "scripts", "lib", "managed-settings-write.py")


def run(*args):
    p = subprocess.run([sys.executable, "-I", HELPER] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return p.returncode, p.stdout.decode() + p.stderr.decode()


class Helper(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="msw-")
        self.dir = os.path.join(self.base, "ClaudeCode")
        os.mkdir(self.dir, 0o755)
        os.chmod(self.dir, 0o755)
        self.file = os.path.join(self.dir, "managed-settings.json")

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def write(self, text, mode=0o644):
        with open(self.file, "w") as f:
            f.write(text)
        os.chmod(self.file, mode)

    def read(self):
        with open(self.file) as f:
            return json.load(f)

    def no_tmp_left(self):
        self.assertEqual([n for n in os.listdir(self.dir) if n.endswith(".tmp")], [])

    def test_create_when_missing(self):
        rc, _ = run(self.file, "--create", "--channels-enabled", "--add-plugin", "slack-channel@marveen-marketplace")
        self.assertEqual(rc, 0)
        self.assertEqual(self.read(), {"allowedChannelPlugins": [{"plugin": "slack-channel", "marketplace": "marveen-marketplace"}],
                                       "channelsEnabled": True})
        self.assertEqual(stat.S_IMODE(os.stat(self.file).st_mode), 0o644)
        self.no_tmp_left()

    def test_missing_without_create_is_left_alone(self):
        rc, out = run(self.file, "--add-plugin", "discord@claude-plugins-official")
        self.assertEqual(rc, 0)
        self.assertFalse(os.path.exists(self.file))
        self.assertIn("nothing to merge", out)

    def test_invalid_json_is_never_rebuilt(self):
        # The ensure script used to turn this into {} and write it back as root.
        self.write('{"allowedChannelPlugins": [{"plugin": "telegram",')
        before = open(self.file).read()
        rc, out = run(self.file, "--create", "--channels-enabled")
        self.assertEqual(rc, 1)
        self.assertIn("not valid JSON", out)
        self.assertEqual(open(self.file).read(), before)

    def test_not_an_object_is_refused(self):
        self.write("[1, 2]")
        rc, out = run(self.file, "--channels-enabled")
        self.assertEqual(rc, 1)
        self.assertIn("not a JSON object", out)

    def test_additive_merge_keeps_everything_else(self):
        self.write(json.dumps({"allowedChannelPlugins": [{"plugin": "telegram", "marketplace": "claude-plugins-official"}],
                               "permissions": {"deny": ["Bash(rm:*)"]}, "channelsEnabled": False}))
        rc, _ = run(self.file, "--channels-enabled", "--add-plugin", "telegram@claude-plugins-official",
                    "--add-plugin", "discord@claude-plugins-official")
        self.assertEqual(rc, 0)
        d = self.read()
        self.assertEqual(d["permissions"], {"deny": ["Bash(rm:*)"]})
        self.assertEqual(d["channelsEnabled"], True)
        self.assertEqual(d["allowedChannelPlugins"], [{"plugin": "telegram", "marketplace": "claude-plugins-official"},
                                                      {"plugin": "discord", "marketplace": "claude-plugins-official"}])
        self.no_tmp_left()

    def test_an_existing_mode_is_kept(self):
        self.write("{}", mode=0o600)
        rc, _ = run(self.file, "--channels-enabled")
        self.assertEqual(rc, 0)
        self.assertEqual(stat.S_IMODE(os.stat(self.file).st_mode), 0o600)

    def test_a_symlinked_file_is_refused_and_its_target_untouched(self):
        victim = os.path.join(self.base, "victim")
        with open(victim, "w") as f:
            f.write("VICTIM\n")
        os.symlink(victim, self.file)
        rc, out = run(self.file, "--channels-enabled")
        self.assertEqual(rc, 1)
        self.assertIn("not a regular file", out)
        self.assertEqual(open(victim).read(), "VICTIM\n")

    def test_a_planted_fixed_tmp_symlink_is_never_followed(self):
        # The old writers used <file>.tmp with a plain open(): a planted link there was written.
        self.write("{}")
        victim = os.path.join(self.base, "victim")
        with open(victim, "w") as f:
            f.write("VICTIM\n")
        os.symlink(victim, self.file + ".tmp")
        rc, _ = run(self.file, "--channels-enabled")
        self.assertEqual(rc, 0)
        self.assertEqual(open(victim).read(), "VICTIM\n")
        self.assertEqual(self.read(), {"channelsEnabled": True})
        self.assertTrue(os.path.islink(self.file + ".tmp"))   # only the planted link, untouched

    def test_a_group_writable_directory_is_refused(self):
        self.write("{}")
        os.chmod(self.dir, 0o775)
        rc, out = run(self.file, "--channels-enabled")
        self.assertEqual(rc, 1)
        self.assertIn("group- or other-writable", out)
        self.assertEqual(self.read(), {})

    def test_an_unchanged_file_is_not_rewritten(self):
        self.write(json.dumps({"channelsEnabled": True}))
        ino = os.stat(self.file).st_ino
        rc, out = run(self.file, "--channels-enabled")
        self.assertEqual(rc, 0)
        self.assertIn("not rewritten", out)
        self.assertEqual(os.stat(self.file).st_ino, ino)

    def test_a_non_list_allowlist_is_refused(self):
        self.write(json.dumps({"allowedChannelPlugins": {"x": 1}}))
        rc, out = run(self.file, "--add-plugin", "teams@marveen-marketplace")
        self.assertEqual(rc, 1)
        self.assertIn("not a list", out)


if __name__ == "__main__":
    unittest.main(verbosity=1)
