#!/usr/bin/env python3
"""Tests for scripts/hook-metadata.py (fingerprint-drift validator) and
scripts/hooks/hook_switches.py (MARVEEN_DISABLED_HOOKS + stdin cap). HOOKDRIFT926.

Run: python3 scripts/__tests__/hook-metadata.test.py

Everything runs on temp projects; the repo's own settings are only READ (by
test_repo_settings_match_committed_sidecar).
"""
import contextlib
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VALIDATOR = os.path.join(ROOT, "scripts", "hook-metadata.py")
HOOKS_DIR = os.path.join(ROOT, "scripts", "hooks")


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


hm = load(VALIDATOR, "hook_metadata_under_test")
sys.path.insert(0, HOOKS_DIR)
import hook_switches  # noqa: E402


def cmd(script):
    return 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/%s"' % script


def group(script, matcher=None, timeout=10):
    g = {"hooks": [{"type": "command", "command": cmd(script), "timeout": timeout}]}
    if matcher is not None:
        g = {"matcher": matcher, **g}
    return g


class Project:
    """A throwaway project dir with .claude/settings.json and hook scripts."""

    SCRIPTS = ("log-a.py", "log-b.py", "log-c.py", "outgoing-copy-gate.py", "rogue-gate.py", "local-ledger.py")

    def __init__(self, tmp):
        self.dir = tmp
        os.makedirs(os.path.join(tmp, ".claude"))
        os.makedirs(os.path.join(tmp, "scripts", "hooks"))
        for s in self.SCRIPTS:
            with open(os.path.join(tmp, "scripts", "hooks", s), "w") as f:
                f.write('"""%s: test hook."""\n' % s)
        self.settings_path = os.path.join(tmp, ".claude", "settings.json")
        self.meta_path = os.path.join(tmp, ".claude", "hooks.metadata.json")
        self.settings = {
            "enabledPlugins": {"x": True},
            "hooks": {
                "PreToolUse": [group("outgoing-copy-gate.py", "Bash"),
                               group("outgoing-copy-gate.py", ".*send_email.*")],
                "PostToolUse": [group("log-a.py"), group("log-b.py", "Skill|Read")],
                "Stop": [group("log-c.py")],
            },
        }
        self.write()

    def write(self):
        with open(self.settings_path, "w") as f:
            json.dump(self.settings, f, indent=2)

    def update(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            rc = hm.main(["--settings", self.settings_path, "--update"])
        return rc, out.getvalue()

    def meta(self):
        with open(self.meta_path) as f:
            return json.load(f)

    def save_meta(self, meta):
        with open(self.meta_path, "w") as f:
            json.dump(meta, f, indent=2)

    def codes(self):
        findings, _ = hm.validate(self.settings_path, self.meta_path, self.dir)
        return sorted({f.code for f in findings}), findings


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = Project(self.tmp.name)
        rc, _ = self.p.update()
        self.assertEqual(rc, 0)

    def tearDown(self):
        self.tmp.cleanup()


class Validator(Base):
    def test_fresh_sidecar_validates(self):
        self.assertEqual(self.p.codes()[0], [])

    def test_missing_sidecar_file(self):
        os.remove(self.p.meta_path)
        self.assertEqual(self.p.codes()[0], ["MISSING_METADATA"])

    def test_hook_without_metadata_entry(self):
        self.p.settings["hooks"]["PostToolUse"].append(group("log-c.py", "Write"))
        self.p.write()
        codes, findings = self.p.codes()
        self.assertEqual(codes, ["MISSING_METADATA"])
        self.assertEqual(findings[0].where, "PostToolUse[2]")

    def test_new_event_without_metadata(self):
        self.p.settings["hooks"]["SessionEnd"] = [group("log-a.py")]
        self.p.write()
        self.assertEqual(self.p.codes()[0], ["MISSING_METADATA"])

    def test_metadata_points_to_missing_hook(self):
        self.p.settings["hooks"]["Stop"] = []
        self.p.write()
        codes, findings = self.p.codes()
        self.assertEqual(codes, ["ORPHAN_METADATA"])
        self.assertEqual(findings[0].where, "metadata Stop[0]")
        self.assertIn("stop/log-c", findings[0].message)

    def test_command_edit_is_drift(self):
        self.p.settings["hooks"]["Stop"][0]["hooks"][0]["command"] = cmd("log-a.py") + " --verbose"
        self.p.write()
        codes, findings = self.p.codes()
        self.assertEqual(codes, ["DRIFT"])
        self.assertEqual(findings[0].where, "Stop[0]")

    def test_replacing_a_moved_hooks_slot_is_new_not_drift(self):
        # log-a moves down one slot, a brand-new hook takes its old slot: the
        # new one is MISSING_METADATA, not a DRIFT of log-a's id.
        post = self.p.settings["hooks"]["PostToolUse"]
        post.insert(0, group("log-c.py", "Write"))
        self.p.write()
        codes, findings = self.p.codes()
        self.assertEqual(codes, ["MISSING_METADATA", "REORDERED"])
        self.assertEqual([f.where for f in findings if f.code == "MISSING_METADATA"], ["PostToolUse[0]"])

    def test_matcher_edit_is_drift(self):
        self.p.settings["hooks"]["PostToolUse"][1]["matcher"] = "Skill"
        self.p.write()
        self.assertEqual(self.p.codes()[0], ["DRIFT"])

    def test_timeout_change_is_not_drift(self):
        self.p.settings["hooks"]["Stop"][0]["hooks"][0]["timeout"] = 180
        self.p.write()
        self.assertEqual(self.p.codes()[0], [])

    def test_silent_reorder_is_flagged_not_drift(self):
        post = self.p.settings["hooks"]["PostToolUse"]
        post[0], post[1] = post[1], post[0]
        self.p.write()
        codes, findings = self.p.codes()
        self.assertEqual(codes, ["REORDERED"])
        self.assertEqual(sorted(f.where for f in findings), ["PostToolUse[0]", "PostToolUse[1]"])

    def test_deleting_a_middle_hook_shows_the_shift(self):
        del self.p.settings["hooks"]["PreToolUse"][0]
        self.p.write()
        codes, findings = self.p.codes()
        # The survivor now sits one slot up (a known fingerprint elsewhere),
        # and the last metadata slot has nothing to describe.
        self.assertEqual(codes, ["ORPHAN_METADATA", "REORDERED"])
        self.assertEqual(sorted(f.where for f in findings), ["PreToolUse[0]", "metadata PreToolUse[0]"])
        orphan = [f for f in findings if f.code == "ORPHAN_METADATA"][0]
        self.assertIn("pre-tool-use/outgoing-copy-gate'", orphan.message)

    def test_hook_moved_to_another_event_is_new_plus_orphan(self):
        # The event is part of the fingerprint: the same command under another
        # event is a different hook (different trigger), not a reorder.
        moved = self.p.settings["hooks"]["Stop"].pop(0)
        self.p.settings["hooks"]["PostToolUse"].append(moved)
        self.p.write()
        self.assertEqual(self.p.codes()[0], ["MISSING_METADATA", "ORPHAN_METADATA"])

    def test_missing_script(self):
        self.p.settings["hooks"]["Stop"][0]["hooks"][0]["command"] = cmd("gone.py")
        self.p.write()
        codes, findings = self.p.codes()
        self.assertIn("MISSING_SCRIPT", codes)
        self.assertIn("gone.py", [f for f in findings if f.code == "MISSING_SCRIPT"][0].message)

    def test_missing_script_absolute_and_relative_paths(self):
        refs = hm.script_refs("node /nope/x.mjs && bash scripts/hooks/log-a.sh; echo 1.5", self.p.dir)
        self.assertEqual([t for t, _ in refs], ["/nope/x.mjs", "scripts/hooks/log-a.sh"])
        self.assertEqual(refs[1][1], os.path.join(self.p.dir, "scripts", "hooks", "log-a.sh"))
        refs = hm.script_refs("[ -f {{PROJECT_ROOT}}/scripts/hooks/log-a.py ] && exec python3 {{PROJECT_ROOT}}/scripts/hooks/log-a.py", self.p.dir)
        self.assertTrue(all(p and os.path.isfile(p) for _, p in refs))

    def test_forbidden_group_and_handler_keys(self):
        self.p.settings["hooks"]["Stop"][0]["id"] = "stop:log-c"
        self.p.settings["hooks"]["Stop"][0]["hooks"][0]["description"] = "x"
        self.p.write()
        codes, findings = self.p.codes()
        self.assertEqual(codes, ["FORBIDDEN_KEY"])
        self.assertEqual(len(findings), 2)
        self.assertTrue(all("hooks.metadata.json" in f.message for f in findings))

    def test_documented_handler_keys_are_allowed(self):
        self.p.settings["hooks"]["Stop"][0]["hooks"][0].update({"async": True, "statusMessage": "x"})
        self.p.write()
        self.assertEqual(self.p.codes()[0], [])

    def test_bad_metadata_duplicate_id_and_index(self):
        meta = self.p.meta()
        meta["hooks"]["PostToolUse"][1]["id"] = meta["hooks"]["PostToolUse"][0]["id"]
        meta["hooks"]["Stop"][0]["index"] = 7
        self.p.save_meta(meta)
        codes, findings = self.p.codes()
        self.assertEqual(codes, ["BAD_METADATA"])
        self.assertEqual(len(findings), 2)

    def test_gate_flag_must_match_locklist(self):
        meta = self.p.meta()
        meta["hooks"]["PreToolUse"][0]["gate"] = False
        meta["hooks"]["Stop"][0]["gate"] = True
        self.p.save_meta(meta)
        codes, _ = self.p.codes()
        self.assertEqual(codes, ["GATE_NOT_LOCKED", "GATE_UNFLAGGED"])

    def test_unlisted_gate_name_is_flagged(self):
        self.p.settings["hooks"]["PreToolUse"].append(group("rogue-gate.py", "Bash"))
        self.p.write()
        self.p.update()
        codes, findings = self.p.codes()
        self.assertEqual(codes, ["GATE_NOT_LOCKED"])
        self.assertIn("rogue-gate", findings[0].message)
        self.assertIn("non_disableable", findings[0].message)

    def test_sidecar_lock_list_locks_a_local_gate(self):
        # An install's own gate is locked through the sidecar, not by editing
        # hook_switches.py; --update keeps the list and flags the entry.
        self.p.settings["hooks"]["PreToolUse"].append(group("rogue-gate.py", "Bash"))
        self.p.write()
        meta = self.p.meta()
        meta["non_disableable"] = ["rogue-gate", "local-ledger.py"]
        self.p.save_meta(meta)
        self.assertEqual(self.p.update()[0], 0)
        meta = self.p.meta()
        self.assertEqual(meta["non_disableable"], ["rogue-gate", "local-ledger.py"])
        self.assertTrue(meta["hooks"]["PreToolUse"][2]["gate"])
        self.assertEqual(self.p.codes()[0], [])

    def test_sidecar_locked_logger_must_be_flagged_gate(self):
        self.p.settings["hooks"]["Stop"].append(group("local-ledger.py"))
        self.p.write()
        self.p.update()
        meta = self.p.meta()
        self.assertFalse(meta["hooks"]["Stop"][1]["gate"])
        meta["non_disableable"] = ["local-ledger"]
        self.p.save_meta(meta)
        codes, findings = self.p.codes()
        self.assertEqual(codes, ["GATE_UNFLAGGED"])
        self.assertEqual(findings[0].where, "Stop[1]")

    def test_malformed_sidecar_lock_list_is_bad_metadata(self):
        for bad in ("rogue-gate", [1], [""], {"x": 1}):
            meta = self.p.meta()
            meta["non_disableable"] = bad
            self.p.save_meta(meta)
            codes, findings = self.p.codes()
            self.assertEqual(codes, ["BAD_METADATA"], bad)
            self.assertEqual(findings[0].where, "non_disableable")

    def test_hook_field_mismatch_is_bad_metadata(self):
        # The entry matches its group by fingerprint, but names another hook:
        # the gate cross-check would silently skip it, so it is a finding.
        meta = self.p.meta()
        meta["hooks"]["PreToolUse"][0]["hook"] = "log-a"
        self.p.save_meta(meta)
        codes, findings = self.p.codes()
        self.assertEqual(codes, ["BAD_METADATA"])
        self.assertEqual(findings[0].where, "PreToolUse[0]")
        self.assertIn("'log-a'", findings[0].message)

    def test_non_object_sidecar_is_bad_metadata(self):
        with open(self.p.meta_path, "w") as f:
            f.write("[]")
        self.assertIn("BAD_METADATA", self.p.codes()[0])

    def test_update_keeps_a_malformed_lock_list_visible(self):
        meta = self.p.meta()
        meta["non_disableable"] = "rogue-gate"
        self.p.save_meta(meta)
        self.assertEqual(self.p.update()[0], 1)
        self.assertEqual(self.p.meta()["non_disableable"], "rogue-gate")


class Update(Base):
    def test_update_prints_diff_and_is_idempotent(self):
        self.p.settings["hooks"]["Stop"].append(group("log-a.py", "x"))
        self.p.write()
        rc, out = self.p.update()
        self.assertEqual(rc, 0)
        self.assertIn("+++ ", out)
        self.assertIn('"id": "stop/log-a"', out)
        rc, out = self.p.update()
        self.assertEqual(rc, 0)
        self.assertIn("no change", out)

    def test_ids_follow_their_hook_across_a_reorder(self):
        meta = self.p.meta()
        meta["hooks"]["PostToolUse"][0]["purpose"] = "hand-written purpose A"
        self.p.save_meta(meta)
        ids = [e["id"] for e in meta["hooks"]["PostToolUse"]]
        post = self.p.settings["hooks"]["PostToolUse"]
        post[0], post[1] = post[1], post[0]
        self.p.write()
        self.assertEqual(self.p.update()[0], 0)
        new = self.p.meta()["hooks"]["PostToolUse"]
        self.assertEqual([e["id"] for e in new], ids[::-1])
        self.assertEqual(new[1]["purpose"], "hand-written purpose A")
        self.assertEqual([e["index"] for e in new], [0, 1])

    def test_intentional_edit_keeps_id_and_purpose(self):
        meta = self.p.meta()
        meta["hooks"]["Stop"][0]["purpose"] = "kept"
        self.p.save_meta(meta)
        self.p.settings["hooks"]["Stop"][0]["hooks"][0]["command"] = cmd("log-c.py") + " --x"
        self.p.write()
        self.assertEqual(self.p.update()[0], 0)
        e = self.p.meta()["hooks"]["Stop"][0]
        self.assertEqual((e["id"], e["purpose"]), ("stop/log-c", "kept"))

    def test_same_script_on_several_matchers_gets_unique_ids(self):
        ids = [e["id"] for e in self.p.meta()["hooks"]["PreToolUse"]]
        self.assertEqual(ids, ["pre-tool-use/outgoing-copy-gate", "pre-tool-use/outgoing-copy-gate/send-email"])
        self.assertTrue(all(e["gate"] for e in self.p.meta()["hooks"]["PreToolUse"]))

    def test_update_still_fails_on_missing_script(self):
        self.p.settings["hooks"]["Stop"][0]["hooks"][0]["command"] = cmd("gone.py")
        self.p.write()
        self.assertEqual(self.p.update()[0], 1)


class Cli(Base):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, VALIDATOR] + list(args), capture_output=True, text=True, timeout=60)

    def test_arbitrary_settings_path_ok_and_fail(self):
        p = self.run_cli("--settings", self.p.settings_path)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("OK, 5 hook group(s)", p.stdout)
        self.p.settings["hooks"]["Stop"][0]["matcher"] = "changed"
        self.p.write()
        p = self.run_cli("--settings", self.p.settings_path)
        self.assertEqual(p.returncode, 1)
        self.assertIn("FAIL DRIFT Stop[0]", p.stderr)
        self.assertIn("--update", p.stderr)

    def test_explicit_metadata_and_project_dir(self):
        other = os.path.join(self.p.dir, "elsewhere.json")
        os.rename(self.p.meta_path, other)
        p = self.run_cli("--settings", self.p.settings_path, "--metadata", other, "--project-dir", self.p.dir)
        self.assertEqual(p.returncode, 0, p.stderr)
        p = self.run_cli("--settings", self.p.settings_path, "--metadata", other, "--project-dir", "/nonexistent")
        self.assertEqual(p.returncode, 1)
        self.assertIn("MISSING_SCRIPT", p.stderr)

    def test_unreadable_settings_exit_2(self):
        p = self.run_cli("--settings", os.path.join(self.p.dir, "nope.json"))
        self.assertEqual(p.returncode, 2)

    def test_bad_json_sidecar_validate_exit_2(self):
        with open(self.p.meta_path, "w") as f:
            f.write("{not json")
        p = self.run_cli("--settings", self.p.settings_path)
        self.assertEqual(p.returncode, 2)
        self.assertIn("cannot read metadata", p.stderr)

    def assert_update_refuses(self, why_fragment):
        with open(self.p.meta_path, "rb") as f:
            before = f.read()
        p = self.run_cli("--settings", self.p.settings_path, "--update")
        with open(self.p.meta_path, "rb") as f:
            after = f.read()
        self.assertEqual(p.returncode, 2, p.stderr)
        self.assertIn("refusing to rewrite", p.stderr)
        self.assertIn(why_fragment, p.stderr)
        self.assertEqual(after, before)
        self.assertFalse(os.path.exists(self.p.meta_path + ".tmp"))
        self.assertNotIn("updated", p.stdout)

    def test_update_refuses_unparseable_sidecar(self):
        for body in ("{not json", ""):
            with open(self.p.meta_path, "w") as f:
                f.write(body)
            self.assert_update_refuses("cannot read it as JSON")

    def test_update_refuses_non_object_sidecar(self):
        for body in ("[]", "null", '"x"', "3"):
            with open(self.p.meta_path, "w") as f:
                f.write(body)
            self.assert_update_refuses("not an object")

    def test_update_refuses_merge_conflicted_sidecar(self):
        # The realistic trigger: a conflicted sidecar that still carries the
        # install's lock list and hand-written purposes.
        meta = self.p.meta()
        meta["non_disableable"] = ["local-ledger"]
        meta["hooks"]["Stop"][0]["purpose"] = "hand-written"
        lines = json.dumps(meta, indent=2).splitlines(True)
        k = next(i for i, l in enumerate(lines) if '"hand-written"' in l)
        lines[k:k + 1] = ["<<<<<<< HEAD\n", lines[k], "=======\n",
                          lines[k].replace("hand-written", "theirs"), ">>>>>>> upstream/develop\n"]
        with open(self.p.meta_path, "w") as f:
            f.writelines(lines)
        self.assert_update_refuses("cannot read it as JSON")

    def write_raw(self, obj):
        with open(self.p.meta_path, "w") as f:
            json.dump(obj, f, indent=2)

    # --- the --update preflight invariant (table-driven) -------------------
    # --update writes the sidecar only after BOTH inputs were read and checked
    # with zero structure findings and nothing it cannot carry over; anything
    # else is exit 2 with a byte-identical sidecar, no temp file, no traceback.

    def broken_settings_cases(self):
        def with_hooks(value):
            return lambda st: st.__setitem__("hooks", value)

        def edit(fn):
            return fn
        return [
            ("hooks is an array", with_hooks([])),
            ("hooks is a string", with_hooks("x")),
            ("hooks is null", with_hooks(None)),
            ("an event is an object", edit(lambda st: st["hooks"].__setitem__("Stop", {"0": group("log-c.py")}))),
            ("an event is a string", edit(lambda st: st["hooks"].__setitem__("Stop", "log-c"))),
            ("a group is not an object", edit(lambda st: st["hooks"]["PostToolUse"].insert(0, "log-a"))),
            ("a group's hooks is not an array", edit(lambda st: st["hooks"]["Stop"][0].__setitem__("hooks", {"x": 1}))),
            ("a group's hooks is empty", edit(lambda st: st["hooks"]["Stop"][0].__setitem__("hooks", []))),
            ("a handler is not an object", edit(lambda st: st["hooks"]["Stop"][0]["hooks"].append("x"))),
            ("a command handler has no command", edit(lambda st: st["hooks"]["Stop"][0]["hooks"][0].pop("command"))),
            ("a group carries a sidecar key", edit(lambda st: st["hooks"]["Stop"][0].__setitem__("id", "stop/x"))),
            ("the top level is an array", "[]"),
            ("the file is not JSON", '{"hooks": {<<<<<<< HEAD'),
            ("a lone surrogate in a matcher", '{"hooks": {"Stop": [{"matcher": "\\ud800", "hooks": [{"type": "command", "command": "true"}]}]}}'),
        ]

    def broken_sidecar_cases(self):
        def entry(key, value):
            def f(meta):
                meta["hooks"]["Stop"][0][key] = value
            return f

        def drop(key):
            return lambda meta: meta["hooks"]["Stop"][0].pop(key)

        def top(key, value):
            return lambda meta: meta.__setitem__(key, value)

        def dup(meta):
            meta["hooks"]["PostToolUse"][1]["id"] = meta["hooks"]["PostToolUse"][0]["id"]
        return [
            ("id is a number", entry("id", 7)),
            ("id is empty", entry("id", "")),
            ("id is null", entry("id", None)),
            ("fingerprint is a number", entry("fingerprint", 12345)),
            ("fingerprint is null", entry("fingerprint", None)),
            ("purpose is a number", entry("purpose", 3)),
            ("purpose has a lone surrogate", entry("purpose", "\ud800 broken")),
            ("gate is a string", entry("gate", "yes")),
            ("index is a string", entry("index", "0")),
            ("hook is a number", entry("hook", 5)),
            ("an entry lacks gate", drop("gate")),
            ("an entry lacks id", drop("id")),
            ("an entry has an unknown key", entry("note", "hand-written")),
            ("two entries share an id", dup),
            ("version is true", top("version", True)),
            ("version is a string", top("version", "1")),
            ("version is a float", top("version", 1.0)),
            ("version is 2", top("version", 2)),
            ("hooks is an array", top("hooks", [])),
            ("an event is an object", lambda meta: meta["hooks"].__setitem__("Stop", {"0": {}})),
            ("an entry is a string", lambda meta: meta["hooks"].__setitem__("Stop", ["entry"])),
            ("an unknown key holds a lone surrogate", top("x-note", "\udfff")),
        ]

    def assert_preflight_refuses(self, label):
        with open(self.p.meta_path, "rb") as f:
            before = f.read()
        p = self.run_cli("--settings", self.p.settings_path, "--update")
        with open(self.p.meta_path, "rb") as f:
            after = f.read()
        self.assertEqual(p.returncode, 2, "%s: rc=%s stderr=%s" % (label, p.returncode, p.stderr[-400:]))
        self.assertIn("refusing to rewrite", p.stderr, label)
        self.assertNotIn("Traceback", p.stderr, label)
        self.assertEqual(after, before, label)
        self.assertEqual(self.leftovers(), [], label)
        self.assertNotIn("updated", p.stdout, label)

    def test_update_preflight_refuses_every_broken_settings_shape(self):
        pristine = json.dumps(self.p.settings)
        for label, change in self.broken_settings_cases():
            with self.subTest(settings=label):
                if isinstance(change, str):
                    with open(self.p.settings_path, "w", encoding="utf-8") as f:
                        f.write(change)
                else:
                    self.p.settings = json.loads(pristine)
                    change(self.p.settings)
                    self.p.write()
                self.assert_preflight_refuses(label)
        self.p.settings = json.loads(pristine)
        self.p.write()
        self.assertEqual(self.p.update()[0], 0)  # the same project is fine again

    def test_update_preflight_refuses_every_broken_sidecar_shape(self):
        pristine = self.p.meta()
        for label, change in self.broken_sidecar_cases():
            with self.subTest(sidecar=label):
                meta = json.loads(json.dumps(pristine))
                change(meta)
                with open(self.p.meta_path, "w", encoding="utf-8") as f:
                    f.write(json.dumps(meta, indent=2))  # ensure_ascii: surrogates stay escaped
                self.assert_preflight_refuses(label)

    def test_update_preflight_runs_before_any_temp_file(self):
        # A refused run must not even create the temp file: mkstemp is not
        # reached (patched to fail loudly if it were).
        self.p.settings["hooks"] = []
        self.p.write()
        with mock.patch.object(hm.tempfile, "mkstemp", side_effect=AssertionError("temp file created")), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            rc = hm.main(["--settings", self.p.settings_path, "--update"])
        self.assertEqual(rc, 2)
        self.assertIn("settings SCHEMA hooks", err.getvalue())

    def test_update_write_time_exception_is_exit_2(self):
        # Not only OSError: any exception while writing is exit 2, temp removed.
        self.p.settings["hooks"]["Stop"].append(group("log-a.py", "x"))
        self.p.write()
        with open(self.p.meta_path, "rb") as f:
            before = f.read()
        with mock.patch.object(hm.os, "chmod", side_effect=UnicodeEncodeError("utf-8", "x", 0, 1, "boom")), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            rc = hm.main(["--settings", self.p.settings_path, "--update"])
        self.assertEqual(rc, 2)
        self.assertIn("UnicodeEncodeError", err.getvalue())
        with open(self.p.meta_path, "rb") as f:
            self.assertEqual(f.read(), before)
        self.assertEqual(self.leftovers(), [])

    def test_update_refuses_a_sidecar_it_cannot_carry_over(self):
        # --update writes back what it read except version/_comment/hooks;
        # a shape it could not carry over faithfully makes it refuse.
        good = self.p.meta()
        stop = dict(good["hooks"]["Stop"][0])
        cases = [
            ({"version": 1, "hooks": []}, "'hooks' is list"),
            ({"version": 1, "hooks": None}, "'hooks' is NoneType"),
            ({"version": 1, "non_disableable": ["x"]}, "'hooks' is missing"),
            ({"version": 1, "hooks": {"Stop": {"0": stop}}}, "hooks.Stop is dict, not an array"),
            ({"version": 1, "hooks": {"Stop": ["entry"]}}, "hooks.Stop[0] is str"),
            ({"version": 1, "hooks": {"Stop": [dict(stop, note="hand-written")]}}, "keys this tool would drop: ['note']"),
            (dict(good, version=2), "version 2 is not 1"),
        ]
        for obj, why in cases:
            self.write_raw(obj)
            self.assert_update_refuses(why)

    def test_update_writes_back_a_malformed_lock_list_verbatim(self):
        # A PRESENT but malformed value (null included) is not "absent": it is
        # written back unchanged and stays a BAD_METADATA finding.
        self.p.settings["hooks"]["Stop"].append(group("log-a.py", "x"))  # force a rewrite
        self.p.write()
        for bad in (None, "local-ledger", {"a": 1}, [1], []):
            meta = self.p.meta()
            meta["non_disableable"] = bad
            self.p.save_meta(meta)
            rc, _ = self.p.update()
            meta = self.p.meta()
            self.assertIn("non_disableable", meta, bad)
            self.assertEqual(meta["non_disableable"], bad)
            self.assertEqual(rc, 0 if bad == [] else 1, bad)

    def test_update_carries_unknown_top_level_keys(self):
        meta = self.p.meta()
        meta["x-install-note"] = {"owner": "ops", "list": [1, 2]}
        meta["zz"] = None
        self.p.save_meta(meta)
        self.p.settings["hooks"]["Stop"].append(group("log-a.py", "x"))
        self.p.write()
        rc, out = self.p.update()
        self.assertEqual(rc, 0)
        self.assertIn("updated", out)
        meta = self.p.meta()
        self.assertEqual(meta["x-install-note"], {"owner": "ops", "list": [1, 2]})
        self.assertIn("zz", meta)
        self.assertIsNone(meta["zz"])
        self.assertEqual(list(meta)[-1], "hooks")

    def test_update_gate_flags_follow_the_effective_lock_list(self):
        self.p.settings["hooks"]["Stop"].append(group("local-ledger.py"))
        self.p.write()
        meta = self.p.meta()
        meta["non_disableable"] = ["local-ledger"]
        self.p.save_meta(meta)
        self.assertEqual(self.p.update()[0], 0)
        self.assertTrue(self.p.meta()["hooks"]["Stop"][1]["gate"])
        # Lock list now malformed: the install's locks are unknown, so the
        # old flag is kept instead of falling back to the built-in floor.
        for bad in ("local-ledger", [3], None):
            meta = self.p.meta()
            meta["non_disableable"] = bad
            meta["hooks"]["Stop"][1]["purpose"] = "touched %r" % (bad,)
            self.p.save_meta(meta)
            self.p.settings["hooks"]["Stop"][0]["hooks"][0]["command"] = cmd("log-c.py") + " --%d" % id(bad)
            self.p.write()
            self.assertEqual(self.p.update()[0], 1)  # BAD_METADATA for the list
            meta = self.p.meta()
            self.assertTrue(meta["hooks"]["Stop"][1]["gate"], bad)
            self.assertFalse(meta["hooks"]["Stop"][0]["gate"], bad)
            self.assertTrue(meta["hooks"]["PreToolUse"][0]["gate"], bad)  # built-in floor

    def test_update_keeps_the_file_mode(self):
        os.chmod(self.p.meta_path, 0o644)
        self.p.settings["hooks"]["Stop"].append(group("log-a.py", "x"))
        self.p.write()
        rc, out = self.p.update()
        self.assertEqual(rc, 0)
        self.assertIn("updated", out)
        self.assertEqual(oct(os.stat(self.p.meta_path).st_mode & 0o777), oct(0o644))

    def leftovers(self):
        d = os.path.dirname(self.p.meta_path)
        return sorted(n for n in os.listdir(d) if n.endswith(".tmp"))

    def test_update_replace_failure_is_exit_2_without_leftover(self):
        self.p.settings["hooks"]["Stop"].append(group("log-a.py", "x"))
        self.p.write()
        with open(self.p.meta_path, "rb") as f:
            before = f.read()
        err = io.StringIO()
        with mock.patch.object(hm.os, "replace", side_effect=OSError(28, "No space left on device")), \
                contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(err):
            rc = hm.main(["--settings", self.p.settings_path, "--update"])
        self.assertEqual(rc, 2)
        self.assertIn("writing the new version failed", err.getvalue())
        self.assertNotIn("updated", out.getvalue())
        with open(self.p.meta_path, "rb") as f:
            self.assertEqual(f.read(), before)
        self.assertEqual(self.leftovers(), [])

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root writes into a read-only dir")
    def test_update_temp_file_failure_is_exit_2_without_traceback(self):
        self.p.settings["hooks"]["Stop"].append(group("log-a.py", "x"))
        self.p.write()
        with open(self.p.meta_path, "rb") as f:
            before = f.read()
        d = os.path.dirname(self.p.meta_path)
        os.chmod(d, 0o500)
        try:
            p = self.run_cli("--settings", self.p.settings_path, "--update")
        finally:
            os.chmod(d, 0o755)
        self.assertEqual(p.returncode, 2, p.stderr)
        self.assertIn("writing the new version failed", p.stderr)
        self.assertNotIn("Traceback", p.stderr)
        with open(self.p.meta_path, "rb") as f:
            self.assertEqual(f.read(), before)
        self.assertEqual(self.leftovers(), [])

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root reads a mode-000 file")
    def test_update_refuses_unopenable_sidecar(self):
        with open(self.p.meta_path, "rb") as f:
            before = f.read()
        os.chmod(self.p.meta_path, 0)
        try:
            up = self.run_cli("--settings", self.p.settings_path, "--update")
            val = self.run_cli("--settings", self.p.settings_path)
        finally:
            os.chmod(self.p.meta_path, 0o644)
        with open(self.p.meta_path, "rb") as f:
            self.assertEqual(f.read(), before)
        self.assertEqual(up.returncode, 2, up.stderr)
        self.assertIn("refusing to rewrite", up.stderr)
        self.assertIn("Permission denied", up.stderr)
        self.assertNotIn("Traceback", up.stderr)
        self.assertFalse(os.path.exists(self.p.meta_path + ".tmp"))
        self.assertEqual(val.returncode, 2)
        self.assertNotIn("Traceback", val.stderr)


class RepoSidecar(unittest.TestCase):
    SETTINGS = os.path.join(ROOT, ".claude", "settings.json")
    SIDECAR = os.path.join(ROOT, ".claude", "hooks.metadata.json")

    def test_repo_settings_match_committed_sidecar(self):
        dirty = subprocess.run(["git", "-C", ROOT, "diff", "--quiet", "HEAD", "--", ".claude/settings.json"])
        if dirty.returncode != 0:
            self.skipTest("checkout has a locally modified .claude/settings.json; validate it with the CLI instead")
        findings, _ = hm.validate(self.SETTINGS, self.SIDECAR, ROOT)
        self.assertEqual([str(f) for f in findings], [])

    def test_drifted_copy_of_repo_settings_fails(self):
        # The committed sidecar against a copy of the committed settings with
        # one gate's command edited: the validator must name the drift.
        with open(self.SETTINGS) as f:
            settings = json.load(f)
        handler = settings["hooks"]["PreToolUse"][0]["hooks"][0]
        handler["command"] = handler["command"] + " --drifted"
        with tempfile.TemporaryDirectory() as tmp:
            drifted = os.path.join(tmp, "settings.json")
            with open(drifted, "w") as f:
                json.dump(settings, f)
            findings, _ = hm.validate(drifted, self.SIDECAR, ROOT)
        self.assertEqual([(f.code, f.where) for f in findings], [("DRIFT", "PreToolUse[0]")])

    def test_repo_sidecar_names_no_hook_that_is_not_shipped(self):
        # The sidecar describes the repo's own settings only: every hook it
        # names must be a script that ships in scripts/hooks.
        with open(self.SIDECAR) as f:
            meta = json.load(f)
        shipped = {hook_switches.normalize(n) for n in os.listdir(HOOKS_DIR)}
        names = {e["hook"] for entries in meta["hooks"].values() for e in entries}
        self.assertEqual(sorted(names - shipped), [])


def sidecar(tmp, body):
    # A fresh file per call: hook_switches caches the lock list per path
    # (one hook process reads it once), so a path is never rewritten here.
    fd, path = tempfile.mkstemp(dir=tmp, suffix=".hooks.metadata.json")
    with os.fdopen(fd, "w") as f:
        f.write(body if isinstance(body, str) else json.dumps(body))
    return path


class Switches(unittest.TestCase):
    """hook_switches with an explicit sidecar path (hermetic)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.empty = sidecar(self.tmp.name, {"version": 1, "hooks": {}})

    def tearDown(self):
        self.tmp.cleanup()

    def test_disable_list_parsing(self):
        env = {"MARVEEN_DISABLED_HOOKS": " Log-A.py ; tool-log-capture,,x "}
        self.assertEqual(hook_switches.disabled_hooks(env), {"log-a", "tool-log-capture", "x"})
        self.assertTrue(hook_switches.is_disabled("log-a", env, self.empty))
        self.assertTrue(hook_switches.is_disabled("/abs/scripts/hooks/tool-log-capture.py", env, self.empty))
        self.assertFalse(hook_switches.is_disabled("skill-usage-capture", env, self.empty))
        self.assertFalse(hook_switches.is_disabled("log-a", {}, self.empty))

    def test_gates_cannot_be_disabled_by_env(self):
        everything = ",".join(sorted(hook_switches.DEFAULT_NON_DISABLEABLE))
        env = {"MARVEEN_DISABLED_HOOKS": everything + ",log-a"}
        for path in (self.empty, None):  # a temp sidecar, and the repo's own
            for name in hook_switches.DEFAULT_NON_DISABLEABLE:
                self.assertFalse(hook_switches.is_disabled(name, env, path), name)
                self.assertFalse(hook_switches.is_disabled(name + ".py", env, path), name)
            self.assertTrue(hook_switches.is_disabled("log-a", env, path))

    def test_named_security_gates_are_on_the_default_locklist(self):
        for name in ("email-send-gate", "outgoing-copy-gate", "email-approval-gate",
                     "egress-gate", "provenance-gate", "credential-gate", "destructive-gate",
                     "fleet-freeze-gate", "telegram-reply-guard"):
            self.assertIn(name, hook_switches.DEFAULT_NON_DISABLEABLE)

    def test_every_shipped_gate_script_is_locked_by_default(self):
        # Any *-gate / *-guard hook that ships with the repo (a script in
        # scripts/hooks, or one the settings template / agent scaffold /
        # repo settings wire as a hook) is on the built-in floor, so an
        # install with no sidecar entry for it still cannot env-disable it.
        names = set()
        for n in os.listdir(HOOKS_DIR):
            stem = hook_switches.normalize(n)
            if stem != n.lower() and hm.GATE_NAME_RE.search(stem):
                names.add(stem)
        for rel in ("templates/settings.json.template", "src/web/agent-scaffold.ts", ".claude/settings.json"):
            with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
                text = f.read()
            for m in re.finditer(r"[\w.-]+[-_](?:gate|guard)\.(?:py|mjs|cjs|js|sh|ts)\b", text):
                names.add(hook_switches.normalize(m.group(0)))
        self.assertGreater(len(names), 10)
        self.assertEqual(sorted(names - hook_switches.DEFAULT_NON_DISABLEABLE), [])

    def test_sidecar_adds_locks_for_local_hooks(self):
        path = sidecar(self.tmp.name, {"version": 1, "hooks": {}, "non_disableable": ["local-ledger.py", "Local-Post-Gate"]})
        env = {"MARVEEN_DISABLED_HOOKS": "local-ledger,local-post-gate,log-a"}
        self.assertEqual(hook_switches.locked_names(path) - hook_switches.DEFAULT_NON_DISABLEABLE,
                         {"local-ledger", "local-post-gate"})
        self.assertFalse(hook_switches.is_disabled("local-ledger", env, path))
        self.assertFalse(hook_switches.is_disabled("local-post-gate", env, path))
        self.assertTrue(hook_switches.is_disabled("log-a", env, path))
        # The same names are disableable where the sidecar does not lock them.
        self.assertTrue(hook_switches.is_disabled("local-ledger", env, self.empty))

    def test_sidecar_cannot_unlock_the_default_floor(self):
        path = sidecar(self.tmp.name, {"version": 1, "hooks": {}, "non_disableable": []})
        self.assertTrue(hook_switches.DEFAULT_NON_DISABLEABLE <= hook_switches.locked_names(path))
        env = {"MARVEEN_DISABLED_HOOKS": "egress-gate"}
        self.assertFalse(hook_switches.is_disabled("egress-gate", env, path))

    def test_missing_sidecar_means_default_floor_only(self):
        path = os.path.join(self.tmp.name, "absent.json")
        self.assertEqual(hook_switches.locked_names(path), hook_switches.DEFAULT_NON_DISABLEABLE)
        self.assertTrue(hook_switches.is_disabled("log-a", {"MARVEEN_DISABLED_HOOKS": "log-a"}, path))

    def test_broken_sidecar_fails_safe(self):
        # The install's own lock list is unknown: nothing may be env-disabled.
        env = {"MARVEEN_DISABLED_HOOKS": "log-a,tool-log-capture"}
        for body in ("{not json", "[]", {"non_disableable": "local-ledger"}, {"non_disableable": [3]}):
            path = sidecar(tempfile.mkdtemp(dir=self.tmp.name), body)
            self.assertEqual(hook_switches.sidecar_locks(path)[1], False, body)
            self.assertFalse(hook_switches.is_disabled("log-a", env, path), body)
            self.assertFalse(hook_switches.is_disabled("tool-log-capture", env, path), body)
            self.assertTrue(hook_switches.is_locked("log-a", path), body)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as cm:
            hook_switches.read_hook_stdin("log-a", io.BytesIO(b"12345"), {"MARVEEN_HOOK_INPUT_MAX_BYTES": "4"}, path)
        self.assertEqual(cm.exception.code, 2)

    def test_sidecar_lock_also_closes_the_stdin_cap(self):
        path = sidecar(self.tmp.name, {"version": 1, "hooks": {}, "non_disableable": ["local-ledger"]})
        env = {"MARVEEN_HOOK_INPUT_MAX_BYTES": "4"}
        self.assertIsNone(hook_switches.read_hook_stdin("local-ledger", io.BytesIO(b"12345"), env, self.empty))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as cm:
            hook_switches.read_hook_stdin("local-ledger", io.BytesIO(b"12345"), env, path)
        self.assertEqual(cm.exception.code, 2)

    def test_lookup_path_is_not_taken_from_the_environment(self):
        self.assertEqual(hook_switches.DEFAULT_METADATA_PATH, os.path.join(ROOT, ".claude", "hooks.metadata.json"))

    def test_every_repo_gate_in_the_sidecar_is_locked(self):
        with open(os.path.join(ROOT, ".claude", "hooks.metadata.json")) as f:
            meta = json.load(f)
        gates = {e["hook"] for entries in meta["hooks"].values() for e in entries if e["gate"]}
        self.assertTrue(gates)
        env = {"MARVEEN_DISABLED_HOOKS": ",".join(gates)}
        for name in gates:
            self.assertFalse(hook_switches.is_disabled(name, env), name)

    def test_stdin_cap_fail_open_for_logging(self):
        env = {"MARVEEN_HOOK_INPUT_MAX_BYTES": "10"}
        self.assertEqual(hook_switches.read_hook_stdin("log-a", io.BytesIO(b"0123456789"), env), "0123456789")
        self.assertIsNone(hook_switches.read_hook_stdin("log-a", io.BytesIO(b"0123456789A"), env))

    def test_stdin_cap_fail_closed_for_gates(self):
        env = {"MARVEEN_HOOK_INPUT_MAX_BYTES": "10"}
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as cm:
            hook_switches.read_hook_stdin("outgoing-copy-gate", io.BytesIO(b"x" * 11), env)
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("fails closed", err.getvalue())

    def test_bad_cap_value_uses_default(self):
        for raw in ("", "abc", "0", "-5"):
            self.assertEqual(hook_switches.max_input_bytes({"MARVEEN_HOOK_INPUT_MAX_BYTES": raw}),
                             hook_switches.DEFAULT_MAX_INPUT_BYTES)


class WiredHooks(unittest.TestCase):
    """The helper wired into the tool-log-capture logging hook."""

    def test_tool_log_capture_reads_through_the_helper(self):
        mod = load(os.path.join(HOOKS_DIR, "tool-log-capture.py"), "tool_log_capture_under_test")
        payload = {"session_id": "s", "tool_name": "Bash"}
        cases = [({}, payload), ({"MARVEEN_DISABLED_HOOKS": "tool-log-capture"}, None),
                 ({"MARVEEN_HOOK_INPUT_MAX_BYTES": "5"}, None)]
        for env, expected in cases:
            saved = {k: os.environ.pop(k, None) for k in ("MARVEEN_DISABLED_HOOKS", "MARVEEN_HOOK_INPUT_MAX_BYTES")}
            os.environ.update(env)
            real = sys.stdin
            sys.stdin = io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode()))
            try:
                self.assertEqual(mod._read_payload(), expected, env)
            finally:
                sys.stdin = real
                for k in ("MARVEEN_DISABLED_HOOKS", "MARVEEN_HOOK_INPUT_MAX_BYTES"):
                    os.environ.pop(k, None)
                    if saved[k] is not None:
                        os.environ[k] = saved[k]


if __name__ == "__main__":
    unittest.main(verbosity=2)
