#!/usr/bin/env python3
"""Unit tests for classify_pane() in scripts/telegram-live-progress.py.

classify_pane() is the whole decision the progress mirror makes: is this pane
running a turn, running only a background process, or idle. It is a pure
function of the captured pane text, so every case below is a real Claude Code
footer/status frame -- no tmux, no Telegram, no store writes.
"""
import importlib.util
import os
import unittest

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "telegram-live-progress.py",
)

_spec = importlib.util.spec_from_file_location("telegram_live_progress", _MODULE_PATH)
tlp = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(tlp)  # type: ignore[union-attr]


def pane(*lines):
    return "\n".join(lines) + "\n"


class TestLiveTurn(unittest.TestCase):
    """A turn in flight keeps winning, exactly as before."""

    def test_spinner_detail_line_is_mirrored_verbatim(self):
        out = pane(
            "> valami kérdés",
            "✽ Incubating… (55s · ↓ 2.6k tokens)",
            "  ⎿  esc to interrupt",
        )
        self.assertEqual(tlp.classify_pane(out), ("live", "Incubating… (55s · ↓ 2.6k tokens)"))

    def test_working_without_a_detail_frame_falls_back_to_the_counter(self):
        out = pane("> kérdés", "esc to interrupt · 2 shells")
        self.assertEqual(tlp.classify_pane(out), ("live", "dolgozom… (2 shells)"))

    def test_working_with_nothing_else_on_screen(self):
        self.assertEqual(tlp.classify_pane(pane("esc to interrupt")), ("live", "dolgozom…"))

    def test_a_live_turn_wins_over_a_background_footer(self):
        out = pane(
            "✽ Incubating… (55s · ↓ 2.6k tokens)",
            "  ⎿  esc to interrupt",
            "bypass permissions on · 2 shells · ctrl+t to hide tasks · ↓ to manage",
        )
        kind, _ = tlp.classify_pane(out)
        self.assertEqual(kind, "live")


class TestBackgroundWork(unittest.TestCase):
    """No turn in flight, but something is still running. This is the new part."""

    def test_background_shells_with_the_tasks_panel_visible(self):
        out = pane(
            "> kész, itt a válasz",
            "bypass permissions on · 2 shells · ctrl+t to hide tasks · ↓ to manage",
        )
        self.assertEqual(tlp.classify_pane(out), ("background", "háttérfolyamat fut (2 shells)"))

    def test_background_shells_with_the_tasks_panel_hidden(self):
        out = pane("bypass permissions on · 1 shell · ↓ to manage")
        self.assertEqual(tlp.classify_pane(out), ("background", "háttérfolyamat fut (1 shell)"))

    def test_monitor_and_subagents(self):
        out = pane("bypass permissions on · 1 monitor · ← for agents · ↓ to manage")
        self.assertEqual(tlp.classify_pane(out), ("background", "háttérfolyamat fut (1 monitor)"))

    def test_the_shape_this_machine_actually_renders(self):
        # Captured from a live pane: the mode glyphs lead, the shift+tab hint
        # is NOT substituted away, and the tail follows it.
        out = pane("  ⏵⏵ bypass permissions on (shift+tab to cycle) · 2 shells · ↓ to manage")
        self.assertEqual(tlp.classify_pane(out), ("background", "háttérfolyamat fut (2 shells)"))

    def test_a_footer_truncated_by_a_narrow_pane(self):
        # capture-pane cuts at pane width, so the tail action can be missing
        # entirely. The leading glyphs still identify it as the footer.
        out = pane("  ⏵⏵ bypass permissions on (shift+tab to cycle) · 3 shells · ctrl+t to hi…")
        self.assertEqual(tlp.classify_pane(out), ("background", "háttérfolyamat fut (3 shells)"))

    def test_several_counters_are_all_reported(self):
        out = pane("bypass permissions on · 3 shells · 1 monitor · ↓ to manage")
        self.assertEqual(
            tlp.classify_pane(out), ("background", "háttérfolyamat fut (3 shells, 1 monitor)"))


class TestIdle(unittest.TestCase):
    """Idle must stay idle: a false positive parks a message in the chat forever."""

    def test_plain_idle_footer_is_not_background_work(self):
        self.assertIsNone(tlp.classify_pane(pane("bypass permissions on (shift+tab to cycle)")))

    def test_the_idle_shape_this_machine_actually_renders(self):
        # Every idle agent pane on the host looks like this. No counter in it,
        # so nothing may be reported -- "← for agents" is a keyboard hint, not
        # a running sub-agent.
        out = pane("  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents")
        self.assertIsNone(tlp.classify_pane(out))

    def test_footer_with_a_tail_but_no_counter(self):
        self.assertIsNone(tlp.classify_pane(pane("bypass permissions on · ↓ to manage")))

    def test_scrollback_quoting_the_footer_without_a_tail_action(self):
        # An echoed log line or a pasted message. Without one of Claude Code's
        # real tail actions this is not a footer, and reading it as one would
        # leave a permanent "háttérfolyamat fut" in the owner's chat.
        out = pane("2026-07-29 log: bypass permissions on · 1 shell", "? for shortcuts")
        self.assertIsNone(tlp.classify_pane(out))

    def test_a_bare_shell_count_in_the_scrollback(self):
        self.assertIsNone(tlp.classify_pane(pane("npm run build spawned 3 shells", "? for shortcuts")))

    def test_empty_pane(self):
        self.assertIsNone(tlp.classify_pane(""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
