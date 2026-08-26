#!/usr/bin/env python3
"""
Unit tests for owner name/email/path replacement in skill-migrate-placeholders.py.

Each test documents the mutation that would break it (test-evidence-discipline).

Run: python3 scripts/test_skill_migrate_owner.py
"""
import re
import sys
import tempfile
import unittest
from pathlib import Path

import importlib.util

_script_dir = Path(__file__).parent
_spec = importlib.util.spec_from_file_location(
    "skill_migrate_placeholders",
    _script_dir / "skill-migrate-placeholders.py",
)
smp = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(smp)  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _setup(name: str = "Jónás Gergő", email: str = "owner@example.com") -> None:
    """Reset module globals and build patterns for the given owner."""
    smp.OWNER_NAME_RX = None
    smp.OWNER_EMAIL_RX = None
    smp._build_owner_patterns(name, email)


def _apply_pass4(line: str) -> str:
    """Apply Pass 4 (owner name replacement) to a single line."""
    if smp.OWNER_NAME_RX is None:
        return line

    def _replacer(m: re.Match) -> str:
        reason = smp._is_owner_name_exception(line, m)
        if reason:
            return m.group(0)
        suffix = m.group(2)
        return ("<OWNER>-" + suffix.lower()) if suffix else "<OWNER>"

    return smp.OWNER_NAME_RX.sub(_replacer, line)


def _apply_pass5(line: str) -> str:
    """Apply Pass 5 (email replacement) to a single line."""
    if smp.OWNER_EMAIL_RX is None:
        return line
    return smp.OWNER_EMAIL_RX.sub("<OWNER_EMAIL>", line)


# ---------------------------------------------------------------------------
# Tests: basic replacement
# ---------------------------------------------------------------------------

class TestBasicReplacement(unittest.TestCase):
    """Pass 4: owner name is replaced with <OWNER>.

    Mutation that breaks these: removing OWNER_NAME_RX or the sub() call.
    """

    def setUp(self):
        _setup()

    def test_accented_full_name(self):
        # Mutation: remove _build_owner_patterns → OWNER_NAME_RX is None → no replacement
        result = _apply_pass4("Jónás Gergő wrote this.")
        self.assertEqual(result, "<OWNER> wrote this.")

    def test_unaccented_variant(self):
        # Mutation: remove accent alternation in _accent_alts → Jonas Gergo not matched
        result = _apply_pass4("Jonas Gergo wrote this.")
        self.assertEqual(result, "<OWNER> wrote this.")

    def test_username_concatenated(self):
        # Mutation: remove username alternation from regex → jonasgergo not matched
        result = _apply_pass4("jonasgergo did this.")
        self.assertEqual(result, "<OWNER> did this.")

    def test_name_at_start_of_line(self):
        result = _apply_pass4("Jónás Gergő: see above.")
        self.assertEqual(result, "<OWNER>: see above.")

    def test_name_at_end_of_line(self):
        result = _apply_pass4("Written by Jónás Gergő")
        self.assertEqual(result, "Written by <OWNER>")

    def test_multiple_occurrences(self):
        # Both occurrences must be replaced
        result = _apply_pass4("Jónás Gergő and Jónás Gergő are the same.")
        self.assertEqual(result, "<OWNER> and <OWNER> are the same.")


# ---------------------------------------------------------------------------
# Tests: Hungarian suffix (ragozás)
# ---------------------------------------------------------------------------

class TestHungarianSuffix(unittest.TestCase):
    """Pass 4: suffixed forms produce <OWNER>-{suffix}.

    Mutation: removing group(2) capture → suffix dropped, result is bare <OWNER>.
    """

    def setUp(self):
        _setup()

    def test_suffix_nek_no_hyphen(self):
        # "Jónás Gergőnek" → "<OWNER>-nek"
        # Mutation: remove suffix capture group → bare <OWNER> (breaks "-nek" form)
        result = _apply_pass4("Jónás Gergőnek adtuk.")
        self.assertEqual(result, "<OWNER>-nek adtuk.")

    def test_suffix_nek_with_hyphen(self):
        # "Jónás Gergő-nek" → "<OWNER>-nek"
        # Hyphen is not consumed by the regex; it survives in the output.
        result = _apply_pass4("Jónás Gergő-nek adtuk.")
        self.assertEqual(result, "<OWNER>-nek adtuk.")

    def test_suffix_nak(self):
        result = _apply_pass4("Ezt Jónás Gergőnak küldtük.")
        self.assertEqual(result, "Ezt <OWNER>-nak küldtük.")

    def test_suffix_val(self):
        result = _apply_pass4("Jónás Gergővel dolgoztunk.")
        self.assertEqual(result, "<OWNER>-vel dolgoztunk.")

    def test_suffix_re(self):
        result = _apply_pass4("Jónás Gergőre vártunk.")
        self.assertEqual(result, "<OWNER>-re vártunk.")

    def test_suffix_t_accusative(self):
        # Shortest suffix: accusative -t
        result = _apply_pass4("Jónás Gergőt kerestük.")
        self.assertEqual(result, "<OWNER>-t kerestük.")


# ---------------------------------------------------------------------------
# Tests: exception list
# ---------------------------------------------------------------------------

class TestExceptions(unittest.TestCase):
    """_is_owner_name_exception must suppress replacement for these patterns.

    Mutation: removing the exception check → these lines would be wrongly altered.
    """

    def setUp(self):
        _setup()

    def test_domain_jonasgergo_hu(self):
        # Mutation: remove domain check → "jonasgergo" in URL replaced with "<OWNER>"
        result = _apply_pass4("Visit jonasgergo.hu for more info.")
        self.assertEqual(result, "Visit jonasgergo.hu for more info.")

    def test_domain_com(self):
        result = _apply_pass4("Email at jonasgergo.com")
        self.assertEqual(result, "Email at jonasgergo.com")

    def test_slug_with_hyphen(self):
        # Mutation: remove slug check → "jonasgergo" in slug name replaced
        result = _apply_pass4("skill: jonasgergo-hu-cikk")
        self.assertEqual(result, "skill: jonasgergo-hu-cikk")

    def test_slug_memory_reference(self):
        # "jonasgergo-hu" as part of a memory slug reference
        result = _apply_pass4("ref: jonasgergo-hu-cikk-skill")
        self.assertEqual(result, "ref: jonasgergo-hu-cikk-skill")

    def test_snake_case_before(self):
        # "warm_jonasgergo_prefs" — underscore before the name
        # Mutation: remove _SNAKE_BEFORE_RX check → name replaced inside slug
        result = _apply_pass4("- warm_jonasgergo_preferences.md")
        self.assertEqual(result, "- warm_jonasgergo_preferences.md")

    def test_snake_case_after(self):
        # "jonas_something" — underscore after (if owner is single-word "Jonas")
        _setup(name="Jonas")
        result = _apply_pass4("Memory: jonas_notes.md")
        self.assertEqual(result, "Memory: jonas_notes.md")

    def test_python_open_path(self):
        # Mutation: remove _PYTHON_OPEN_PREFIX_RX check → path replaced, breaking Python code
        result = _apply_pass4("f = open('/Users/jonasgergo/config.json')")
        self.assertIn("jonasgergo", result)

    def test_wiki_link_slug(self):
        # "[[warm_jonasgergo_prefs]]" — inside wiki link delimiters
        # (Also caught by snake_case, but wiki link guard is belt-and-suspenders)
        result = _apply_pass4("See [[warm_jonasgergo_infografika_preferenciak]] for details.")
        self.assertIn("jonasgergo", result)

    def test_grep_pattern(self):
        # Mutation: remove grep pattern check → the grep search term gets replaced
        result = _apply_pass4('grep "jonasgergo" ~/.claude/skills/**/*.md')
        self.assertIn("jonasgergo", result)

    def test_grep_pattern_single_quote(self):
        result = _apply_pass4("grep 'jonasgergo' file.md")
        self.assertIn("jonasgergo", result)


# ---------------------------------------------------------------------------
# Tests: idempotency
# ---------------------------------------------------------------------------

class TestIdempotency(unittest.TestCase):
    """Applying Pass 4 twice must produce the same output as applying once."""

    def setUp(self):
        _setup()

    def test_already_replaced_owner_token(self):
        # "<OWNER>" should not be matched by OWNER_NAME_RX (angle bracket not a word char)
        line = "<OWNER> wrote this."
        result = _apply_pass4(line)
        self.assertEqual(result, line)

    def test_owner_with_suffix_idempotent(self):
        line = "<OWNER>-nek adtuk."
        result = _apply_pass4(line)
        self.assertEqual(result, line)

    def test_double_application_idempotent(self):
        line = "Jónás Gergő wrote this."
        first = _apply_pass4(line)
        second = _apply_pass4(first)
        self.assertEqual(first, second)


# ---------------------------------------------------------------------------
# Tests: email replacement (Pass 5)
# ---------------------------------------------------------------------------

class TestEmailReplacement(unittest.TestCase):
    """Pass 5: owner email is replaced with <OWNER_EMAIL>.

    Mutation: removing OWNER_EMAIL_RX or the sub() call.
    """

    def setUp(self):
        _setup(email="owner@example.com")

    def test_email_replaced(self):
        result = _apply_pass5("Contact owner@example.com for help.")
        self.assertEqual(result, "Contact <OWNER_EMAIL> for help.")

    def test_email_not_replaced_when_unconfigured(self):
        _setup(email="")
        result = _apply_pass5("Contact nobody@example.com")
        self.assertEqual(result, "Contact nobody@example.com")

    def test_already_replaced_email_token(self):
        _setup(email="owner@example.com")
        line = "Contact <OWNER_EMAIL> for help."
        result = _apply_pass5(line)
        self.assertEqual(result, line)

    def test_empty_email_leaves_content_intact(self):
        # Critical: if OWNER_EMAIL is not configured, Pass 5 must be a no-op.
        # An empty OWNER_EMAIL_RX would silently replace every empty string match.
        # Mutation: change `if owner_email and "@" in owner_email` to just `if True`
        # → OWNER_EMAIL_RX built from "" → re.compile("") matches everywhere →
        # every character boundary replaced with <OWNER_EMAIL>.
        _setup(email="")
        line = "Contact boss@company.com for details."
        result = _apply_pass5(line)
        self.assertEqual(result, line,
            "Empty OWNER_EMAIL must skip Pass 5 entirely, not corrupt content")

    def test_resolve_owner_config_no_email_in_dotenv(self):
        # _resolve_owner_config returns ("", "") when OWNER_EMAIL absent from .env.
        # Confirm the full config-resolution path produces a None OWNER_EMAIL_RX.
        import os, tempfile
        with tempfile.TemporaryDirectory() as td:
            env_path = Path(td) / ".env"
            env_path.write_text('OWNER_NAME=Test Person\n', encoding="utf-8")
            # Temporarily remove OWNER_EMAIL from os.environ if set
            old = os.environ.pop("OWNER_EMAIL", None)
            try:
                name, email = smp._resolve_owner_config(Path(td))
                smp.OWNER_NAME_RX = None
                smp.OWNER_EMAIL_RX = None
                smp._build_owner_patterns(name, email)
                self.assertIsNone(smp.OWNER_EMAIL_RX,
                    "OWNER_EMAIL absent from .env must produce None OWNER_EMAIL_RX")
            finally:
                if old is not None:
                    os.environ["OWNER_EMAIL"] = old


# ---------------------------------------------------------------------------
# Tests: bash path normalization (Pass 6)
# ---------------------------------------------------------------------------

class TestBashPathNormalization(unittest.TestCase):
    """Pass 6: /Users/<username>/ becomes $HOME/ except inside Python open() calls.

    Mutation: removing the open() guard → Python source code gets $HOME which breaks it.
    """

    def _normalize(self, text: str) -> str:
        home_path = str(Path.home()) + "/"
        changes: list[str] = []
        return smp._normalize_bash_path(text, home_path, changes)

    def test_bash_path_replaced(self):
        # Mutation: remove path_rx.sub → $HOME/ not inserted
        home = str(Path.home())
        result = self._normalize(f"TOKEN=$(cat {home}/marveen/store/.dashboard-token)")
        self.assertIn("$HOME/", result)
        self.assertNotIn(home + "/", result)

    def test_python_open_path_preserved(self):
        # Mutation: remove _PYTHON_OPEN_PREFIX_RX guard → Python open() path mangled
        home = str(Path.home())
        line = f"f = open('{home}/config.json')"
        result = self._normalize(line)
        self.assertEqual(result, line)

    def test_no_change_when_home_absent(self):
        line = "echo 'no path here'"
        result = self._normalize(line)
        self.assertEqual(result, line)


# ---------------------------------------------------------------------------
# Tests: config resolution
# ---------------------------------------------------------------------------

class TestOwnerConfig(unittest.TestCase):
    """_build_owner_patterns: generic 'Owner' default must NOT build a name regex."""

    def test_generic_owner_not_matched(self):
        # If OWNER_NAME is the default "Owner", we must not replace every occurrence
        # of the word "owner" in skill files.
        smp.OWNER_NAME_RX = None
        smp._build_owner_patterns("Owner", "")
        self.assertIsNone(smp.OWNER_NAME_RX)

    def test_empty_owner_not_matched(self):
        smp.OWNER_NAME_RX = None
        smp._build_owner_patterns("", "")
        self.assertIsNone(smp.OWNER_NAME_RX)

    def test_real_name_builds_regex(self):
        _setup("Test Person")
        self.assertIsNotNone(smp.OWNER_NAME_RX)

    def test_email_not_built_without_at(self):
        smp.OWNER_EMAIL_RX = None
        smp._build_owner_patterns("Test Person", "notanemail")
        self.assertIsNone(smp.OWNER_EMAIL_RX)


# ---------------------------------------------------------------------------
# Integration: migrate_file on a temp SKILL.md
# ---------------------------------------------------------------------------

class TestMigrateFileIntegration(unittest.TestCase):
    """End-to-end: migrate_file transforms owner refs and leaves exceptions untouched."""

    def setUp(self):
        _setup(name="Jónás Gergő", email="owner@example.com")

    def _run(self, content: str) -> str:
        with tempfile.TemporaryDirectory() as td:
            md = Path(td) / "SKILL.md"
            md.write_text(content, encoding="utf-8")
            smp.migrate_file(md, "global", dry_run=False)
            return md.read_text(encoding="utf-8")

    def test_name_replaced_in_body(self):
        out = self._run("# Some skill\n\nJónás Gergő maintains this.\n")
        self.assertIn("<OWNER>", out)
        self.assertNotIn("Jónás Gergő", out)

    def test_domain_preserved(self):
        out = self._run("# Skill\n\nSee jonasgergo.hu for info.\n")
        self.assertIn("jonasgergo.hu", out)

    def test_email_replaced_in_body(self):
        out = self._run("# Skill\n\nContact owner@example.com.\n")
        self.assertIn("<OWNER_EMAIL>", out)
        self.assertNotIn("owner@example.com", out)

    def test_idempotent_on_already_migrated(self):
        # File already fully migrated; applying again must produce zero changes.
        content = "# Skill\n\n<OWNER> manages this via <OWNER_EMAIL>.\n"
        out = self._run(content)
        self.assertEqual(out, content)

    def test_frontmatter_body_preserved(self):
        content = "---\nname: test-skill\ndescription: A test\n---\n\nJónás Gergő wrote this.\n"
        out = self._run(content)
        self.assertIn("name: test-skill", out)
        self.assertIn("<OWNER>", out)
        self.assertNotIn("Jónás Gergő", out)


# ---------------------------------------------------------------------------
# Tests: code-fence skip (Passes 3, 4, 5)
# ---------------------------------------------------------------------------

class TestCodeFenceSkip(unittest.TestCase):
    """Passes 3-5 must not replace inside Markdown code fences.

    Rule: placeholders belong in prose, not in executable commands. A replacement
    inside a fence would silently break commands (grep finds nothing, tmux finds
    no session, curl hits a non-existent agent).

    Mutation that breaks these: removing the _is_fence_marker / in_fence guard
    from any of the three passes -> name/email inside fence is replaced -> test fails.
    """

    def setUp(self):
        _setup(name="Jónás Gergő", email="owner@example.com")

    def _run(self, content: str, agent_id: str = "global") -> str:
        with tempfile.TemporaryDirectory() as td:
            md = Path(td) / "SKILL.md"
            md.write_text(content, encoding="utf-8")
            smp.migrate_file(md, agent_id, dry_run=False)
            return md.read_text(encoding="utf-8")

    def test_owner_name_in_fence_not_replaced(self):
        # Inside ``` block: Jónás Gergő must survive unchanged
        content = "# Skill\n\n```bash\necho Jónás Gergő\n```\n"
        out = self._run(content)
        self.assertIn("Jónás Gergő", out,
            "Owner name inside code fence must not be replaced")
        self.assertNotIn("<OWNER>", out)

    def test_owner_name_outside_fence_replaced(self):
        content = "# Skill\n\nJónás Gergő manages this.\n\n```bash\necho hello\n```\n"
        out = self._run(content)
        self.assertIn("<OWNER>", out)
        self.assertNotIn("Jónás Gergő", out)

    def test_owner_email_in_fence_not_replaced(self):
        # Inside ``` block: email must survive unchanged
        content = "# Skill\n\n```bash\ncurl -u owner@example.com api\n```\n"
        out = self._run(content)
        self.assertIn("owner@example.com", out,
            "Owner email inside code fence must not be replaced")
        self.assertNotIn("<OWNER_EMAIL>", out)

    def test_agent_name_in_fence_not_replaced(self):
        # Inside ``` block: real agent id used in a grep pattern must survive
        content = "# Skill\n\n```bash\ntmux ls | grep jarvis-channels\n```\n"
        out = self._run(content)
        self.assertIn("jarvis-channels", out,
            "Agent name inside code fence must not be replaced")
        self.assertNotIn("<MAIN_AGENT>", out)

    def test_mixed_fence_and_prose(self):
        # Outside fence: replaced. Inside fence: preserved.
        content = (
            "# Skill\n\n"
            "Jónás Gergő manages this.\n\n"
            "```bash\n"
            "# Jónás Gergő ez egy parancsban\n"
            "curl owner@example.com\n"
            "```\n\n"
            "Contact owner@example.com for help.\n"
        )
        out = self._run(content)
        self.assertIn("<OWNER>", out)
        self.assertIn("<OWNER_EMAIL>", out)
        self.assertIn("Jónás Gergő ez egy parancsban", out)
        self.assertIn("curl owner@example.com", out)

    def test_multiple_fences(self):
        # Second fence block after a closed one must also be skipped
        content = (
            "# Skill\n\n"
            "```bash\necho Jónás Gergő\n```\n\n"
            "Prose Jónás Gergő here.\n\n"
            "```bash\nowner@example.com\n```\n"
        )
        out = self._run(content)
        self.assertIn("<OWNER>", out)
        self.assertIn("echo Jónás Gergő", out)
        self.assertIn("owner@example.com", out)
        self.assertNotIn("<OWNER_EMAIL>", out)

    def test_json_to_in_fence_not_replaced(self):
        # Pass 2: "to":"peter" inside a curl command must NOT become "to":"<HEALTH_AGENT>"
        # Mutation: remove Pass 2 fence skip -> curl command broken, API call fails silently
        content = (
            "# Skill\n\n"
            "```bash\n"
            'curl -d \'{"from":"<AGENT>","to":"peter","content":"task"}\'\n'
            "```\n"
        )
        out = self._run(content, agent_id="jarvis")
        self.assertIn('"to":"peter"', out,
            "JSON to field inside code fence must not be replaced")
        self.assertNotIn("<HEALTH_AGENT>", out)

    def test_json_from_in_fence_not_replaced(self):
        # Pass 1: "from":"zack" inside a fence must not become "from":"<BACKEND_AGENT>"
        # Mutation: remove Pass 1 fence skip -> API call sends wrong sender ID
        content = (
            "# Skill\n\n"
            "```bash\n"
            'curl -d \'{"from":"zack","to":"jarvis","content":"done"}\'\n'
            "```\n"
        )
        out = self._run(content, agent_id="zack")
        self.assertIn('"from":"zack"', out,
            "JSON from field inside code fence must not be replaced")
        self.assertNotIn("<BACKEND_AGENT>", out)


if __name__ == "__main__":
    result = unittest.main(verbosity=2, exit=False)
    sys.exit(0 if result.result.wasSuccessful() else 1)
