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


if __name__ == "__main__":
    unittest.main(verbosity=2)
