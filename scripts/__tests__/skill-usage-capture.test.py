#!/usr/bin/env python3
"""Unit tests for scripts/hooks/skill-usage-capture.py.

Tests cover _classify() and _agent_id_from_cwd() -- the two pure-logic
functions that determine what gets logged and under which agent.

Privacy: only fake agent IDs (agent-a, agent-b) and synthetic paths are used.
"""
import sys
import os
import unittest

# Resolve the hook module without importing as a side-effect runner.
import importlib.util

_HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "skill-usage-capture.py",
)

_spec = importlib.util.spec_from_file_location("skill_usage_capture", _HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(hook)  # type: ignore[union-attr]


class TestClassify(unittest.TestCase):
    """_classify(tool_name, tool_input) -> (skill_name, trigger_type) | None"""

    def _call(self, tool_name, tool_input):
        return hook._classify(tool_name, tool_input)

    # Skill tool ----------------------------------------------------------------

    def test_skill_tool_returns_tool_call(self):
        result = self._call("Skill", {"skill": "fleet-helper"})
        self.assertEqual(result, ("fleet-helper", "tool_call"))

    def test_skill_tool_args_variant(self):
        result = self._call("Skill", {"skill": "deep-research", "args": "something"})
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "deep-research")
        self.assertEqual(result[1], "tool_call")

    def test_skill_tool_strips_whitespace(self):
        result = self._call("Skill", {"skill": "  fleet-helper  "})
        self.assertEqual(result, ("fleet-helper", "tool_call"))

    def test_skill_tool_empty_name_returns_none(self):
        result = self._call("Skill", {"skill": ""})
        self.assertIsNone(result)

    def test_skill_tool_missing_skill_key_returns_none(self):
        result = self._call("Skill", {})
        self.assertIsNone(result)

    # Read tool + SKILL.md path -------------------------------------------------

    def test_read_skill_md_returns_skill_read(self):
        home = os.path.expanduser("~")
        path = f"{home}/.claude/skills/fleet-helper/SKILL.md"
        result = self._call("Read", {"file_path": path})
        self.assertEqual(result, ("fleet-helper", "skill_read"))

    def test_read_skill_md_extracts_skill_name(self):
        home = os.path.expanduser("~")
        path = f"{home}/.claude/skills/deep-research/SKILL.md"
        result = self._call("Read", {"file_path": path})
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "deep-research")

    def test_read_non_skill_md_returns_none(self):
        home = os.path.expanduser("~")
        # Only the SKILL.md at the top of a skill dir should match.
        result = self._call("Read", {"file_path": f"{home}/.claude/skills/fleet-helper/references/extra.md"})
        self.assertIsNone(result)

    def test_read_arbitrary_file_returns_none(self):
        result = self._call("Read", {"file_path": "/some/other/file.md"})
        self.assertIsNone(result)

    def test_read_no_file_path_returns_none(self):
        result = self._call("Read", {})
        self.assertIsNone(result)

    # Other tools ----------------------------------------------------------------

    def test_bash_tool_returns_none(self):
        self.assertIsNone(self._call("Bash", {"command": "echo hi"}))

    def test_write_tool_returns_none(self):
        self.assertIsNone(self._call("Write", {"file_path": "/tmp/x.txt", "content": "x"}))

    def test_edit_tool_returns_none(self):
        self.assertIsNone(self._call("Edit", {"file_path": "/tmp/x.txt"}))

    def test_websearch_returns_none(self):
        self.assertIsNone(self._call("WebSearch", {"query": "something"}))

    def test_unknown_tool_returns_none(self):
        self.assertIsNone(self._call("UnknownTool", {"key": "value"}))


class TestAgentIdFromCwd(unittest.TestCase):
    """_agent_id_from_cwd(cwd) derives the agent identity from the session cwd."""

    def _call(self, cwd):
        return hook._agent_id_from_cwd(cwd)

    def _install(self):
        return hook._install_dir()

    def test_agents_subdir_returns_agent_name(self):
        install = self._install()
        cwd = os.path.join(install, "agents", "agent-a")
        self.assertEqual(self._call(cwd), "agent-a")

    def test_agents_subdir_nested_returns_first_segment(self):
        install = self._install()
        cwd = os.path.join(install, "agents", "agent-b", "subdir")
        self.assertEqual(self._call(cwd), "agent-b")

    def test_install_root_returns_main_agent_id(self):
        install = self._install()
        result = self._call(install)
        # Should fall back to MAIN_AGENT_ID or 'marveen'
        self.assertIsInstance(result, str)
        self.assertTrue(len(result) > 0)

    def test_empty_cwd_returns_nonempty_string(self):
        result = self._call("")
        self.assertIsInstance(result, str)
        self.assertTrue(len(result) > 0)

    def test_trailing_slash_ignored(self):
        install = self._install()
        cwd_with_slash = os.path.join(install, "agents", "agent-a") + "/"
        self.assertEqual(self._call(cwd_with_slash), "agent-a")

    # Regression guards for the drifted-private-copy bug: the hook used to
    # carry its own resolver that missed the install-subdirectory case and
    # invented an agent id from the cwd basename, so skill_usage rows were
    # attributed to a directory name instead of a real agent.

    def test_delegates_to_the_shared_ledger_resolver(self):
        import sys as _sys
        _sys.path.insert(0, os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"))
        import ledger_lib
        self.assertIs(hook._agent_id_from_cwd, ledger_lib.agent_id_from_cwd)

    def test_install_subdir_is_main_agent_not_directory_name(self):
        install = self._install()
        cwd = os.path.join(install, "store", "some-workdir")
        # The drifted copy returned "some-workdir" here.
        self.assertNotEqual(self._call(cwd), "some-workdir")


# 2026-09-14: a SKILL.md-minta kiterjesztese
# projekt-szintu skillekre. A REGI minta csak a futo felhasznalo HOME-ja ala
# illeszkedett, ezert a <install>/.claude/skills/<nev>/SKILL.md olvasasa SOHA nem
# keletkeztetett skill_usage sort. Merve aznap: 71 telepitett skillhez 4 usage-sor,
# mind `tool_call`, egyetlen `skill_read` sem. Ez a negy eset pinneli az uj hatart.
class TestProjectScopedSkills(unittest.TestCase):
    def _classify(self, path):
        return hook._classify("Read", {"file_path": path})

    def test_project_scoped_skill_md_matches(self):
        self.assertEqual(
            self._classify("/srv/marveen/.claude/skills/my-skill/SKILL.md"),
            ("my-skill", "skill_read"),
        )

    def test_home_scoped_still_matches(self):
        home = os.path.expanduser("~")
        self.assertEqual(
            self._classify(f"{home}/.claude/skills/fleet-helper/SKILL.md"),
            ("fleet-helper", "skill_read"),
        )

    def test_scheduled_task_skill_md_does_not_match(self):
        # A scheduled-tasks SKILL.md NEM skill, hanem egy utemezett feladat promptja.
        home = os.path.expanduser("~")
        self.assertIsNone(self._classify(f"{home}/.claude/scheduled-tasks/foo/SKILL.md"))

    def test_nested_reference_still_does_not_match(self):
        self.assertIsNone(self._classify("/srv/marveen/.claude/skills/my-skill/references/x.md"))


# SKILLBASHREAD1109: 2026-11-09-en merve 11-07 20:21 es 11-09 08:10 kozott nulla
# skill_usage sor keletkezett, mert minden SKILL.md-t Bash-bol (cat/sed) nyitottunk meg.
class TestBashSkillRead(unittest.TestCase):
    def _b(self, cmd):
        return hook._classify_bash(cmd)

    def test_cat_of_a_project_skill_counts(self):
        self.assertEqual(self._b("cat /srv/m/.claude/skills/fleet-helper/SKILL.md"), ["fleet-helper"])

    def test_home_and_isolated_roots_count(self):
        self.assertEqual(self._b("sed -n 1,40p ~/.claude/skills/a/SKILL.md"), ["a"])
        self.assertEqual(self._b("head -80 /srv/m/.channels-config/skills/b/SKILL.md"), ["b"])
        self.assertEqual(self._b("cat /srv/m/agents/x/.claude-config/skills/c/SKILL.md | head"), ["c"])

    def test_quoted_path_and_several_skills_are_distinct(self):
        cmd = 'cat "/s/.claude/skills/a/SKILL.md" && grep x "/s/.claude/skills/b/SKILL.md"; cat /s/.claude/skills/a/SKILL.md'
        self.assertEqual(self._b(cmd), ["a", "b"])

    def test_cap(self):
        cmd = " ".join(f"/s/.claude/skills/k{i}/SKILL.md" for i in range(9))
        self.assertEqual(len(self._b("cat " + cmd)), hook._MAX_BASH_SKILLS)

    def test_glob_or_variable_is_not_a_read_of_one_skill(self):
        self.assertEqual(self._b("grep -l foo ~/.claude/skills/*/SKILL.md"), [])
        self.assertEqual(self._b('cat ~/.claude/skills/$NAME/SKILL.md'), [])

    def test_writes_do_not_count(self):
        for cmd in [
            "cat > ~/.claude/skills/a/SKILL.md << 'EOF'",
            "echo x >> /s/.claude/skills/a/SKILL.md",
            "sed -i 's/a/b/' /s/.claude/skills/a/SKILL.md",
            "cp /tmp/x /s/.claude/skills/a/SKILL.md",
            "rm /s/.claude/skills/a/SKILL.md",
            "git add .claude/skills/a/SKILL.md",
        ]:
            self.assertEqual(self._b(cmd), [], cmd)

    def test_scheduled_task_and_references_do_not_count(self):
        self.assertEqual(self._b("cat ~/.claude/scheduled-tasks/foo/SKILL.md"), [])
        self.assertEqual(self._b("cat /s/.claude/skills/a/references/SKILL.md.bak"), [])

    def test_unrelated_command(self):
        self.assertEqual(self._b("echo hi"), [])
        self.assertEqual(self._b(""), [])

    # SKILLREADERONLY1109: the review of #2644 measured these as counted reads.
    def test_a_mention_is_not_a_read(self):
        for cmd in [
            'echo "see .claude/skills/gamma/SKILL.md for details"',
            "git diff -- .claude/skills/zeta/SKILL.md",
            "ls -la .claude/skills/eta/SKILL.md",
            "printf '%s\\n' /s/.claude/skills/a/SKILL.md",
            "grep -l foo /s/.claude/skills/a/SKILL.md",
            "grep -rl foo /s/.claude/skills/a/SKILL.md",
            "rg --files-with-matches foo /s/.claude/skills/a/SKILL.md",
            "grep -c foo /s/.claude/skills/a/SKILL.md",
        ]:
            self.assertEqual(self._b(cmd), [], cmd)

    def test_heredoc_body_is_not_a_read(self):
        cmd = "cat > /tmp/notes.md <<'EOF'\nread .claude/skills/delta/SKILL.md first\ncat /s/.claude/skills/omega/SKILL.md\nEOF"
        self.assertEqual(self._b(cmd), [])
        # ...but a real read after the heredoc still counts
        cmd2 = "python3 - <<EOF\nprint('.claude/skills/delta/SKILL.md')\nEOF\ncat /s/.claude/skills/real/SKILL.md"
        self.assertEqual(self._b(cmd2), ["real"])

    def test_readers_count(self):
        self.assertEqual(self._b("tail -n 20 /s/.claude/skills/a/SKILL.md"), ["a"])
        self.assertEqual(self._b("awk 'NR<10' /s/.claude/skills/a/SKILL.md"), ["a"])
        self.assertEqual(self._b("grep -n Buktato /s/.claude/skills/a/SKILL.md"), ["a"])
        self.assertEqual(self._b('cat "$HOME/.claude/skills/eps/SKILL.md"'), ["eps"])
        self.assertEqual(self._b("LC_ALL=C /usr/bin/head -5 /s/.claude/skills/a/SKILL.md"), ["a"])
        self.assertEqual(self._b("cd /s && cat .claude/skills/a/SKILL.md 2>/dev/null"), ["a"])

    def test_mention_next_to_a_read_counts_only_the_read(self):
        cmd = "echo /s/.claude/skills/x/SKILL.md; cat /s/.claude/skills/y/SKILL.md"
        self.assertEqual(self._b(cmd), ["y"])

    def test_unparseable_line_is_skipped_not_raised(self):
        self.assertEqual(self._b("cat '/s/.claude/skills/a/SKILL.md"), [])

    def test_read_tool_sees_isolated_root(self):
        self.assertEqual(
            hook._classify("Read", {"file_path": "/srv/m/.channels-config/skills/b/SKILL.md"}),
            ("b", "skill_read"),
        )



if __name__ == "__main__":
    unittest.main(verbosity=2)
