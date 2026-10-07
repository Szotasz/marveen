#!/usr/bin/env python3
"""owner-question-lookup (card fc282e39): before a question goes to an owner, the
hook looks for the owner's own earlier inbound messages about it; with a hit it
holds the question back ONCE, with the hits as the reason (the second step).

What these cases pin, and why each one matters:
  - a question with an earlier owner message -> "deny", the hits in the reason
    (the model reads the reason instead of the tool result, BEFORE the send);
  - the same text again (whitespace aside) -> passes: held back once, never loops;
  - the memory is per chat, keeps no text, and expires;
  - the cap (a lead's decision): at most 2 denies per chat within 10 minutes,
    the third question with hits passes and says so;
  - a question with no earlier message -> passes, said out loud, never silence;
  - a non-owner chat, a text without a question, a "?" inside a link or code
    -> silence (silence means "not applicable", nothing else);
  - only the same chat's INBOUND rows of the last 30 days count;
  - the hit rule: 2+ shared stems with a rare one, or 1 long word only one row has;
    a single short or common word, or two common words, are not hits;
  - an unreadable principals file or ledger -> "the lookup did NOT run", out loud;
    an unusable deny memory (unreadable, malformed, locked, unwritable) -> the
    question passes with the hits, never an unremembered deny;
  - no principals file at all -> the install's single owner chat, else silence;
  - exit 0 on every path; the only permissionDecision ever returned is "deny",
    and its reason stays inside the binary's 20-line / 2000-character limit.

Hermetic: throwaway ledger, principals file and deny memory, HOME pointed at a
temp dir, the clock fixed with OWNER_QUESTION_NOW. Invented chat ids only.
Run: python3 scripts/__tests__/owner-question-lookup.test.py
"""
import fcntl
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(HERE, "..", "hooks")
HOOK = os.path.join(HOOKS, "owner-question-lookup.py")
sys.path.insert(0, HOOKS)
import ledger_lib  # noqa: E402

SPEC = importlib.util.spec_from_file_location("owner_question_lookup", HOOK)
oql = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(oql)

NOW = 1790600000
DAY = 86400
REPLY = "mcp__plugin_telegram_telegram__reply"
OWNER, SYSADMIN, STAFF, OTHER_OWNER = "1001", "1002", "3003", "1004"
PRINCIPALS = {"principals": {
    OWNER: {"name": "Owner A", "role": "owner"},
    SYSADMIN: {"name": "Owner B", "role": "sysadmin_owner"},
    STAFF: {"name": "Staff C", "role": "staff"},
    OTHER_OWNER: {"name": "Owner D", "role": "owner"},
}}


class Out:
    """The hook's answer: `denied`, and `text` = the deny reason or the context."""

    def __init__(self, raw):
        hso = raw["hookSpecificOutput"]
        self.denied = hso.get("permissionDecision") == "deny"
        self.text = hso["permissionDecisionReason"] if self.denied else hso["additionalContext"]
        self.summary = raw["systemMessage"]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="oql-")
        self.db = os.path.join(self.tmp, "ledger.db")
        self.principals = os.path.join(self.tmp, "principals.json")
        self.errlog = os.path.join(self.tmp, "hook-errors.log")
        self.state = os.path.join(self.tmp, "owner-question-denies.json")
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        with open(self.principals, "w", encoding="utf-8") as fh:
            json.dump(PRINCIPALS, fh)
        con = sqlite3.connect(self.db)
        con.execute(ledger_lib.SCHEMA)
        con.commit()
        con.close()
        self.next_id = 500

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def add(self, text, chat=OWNER, direction="in", age_days=1.0):
        self.next_id += 1
        created = int(NOW - age_days * DAY)
        con = sqlite3.connect(self.db)
        con.execute(
            "INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)"
            " VALUES ('main', ?, ?, ?, ?, ?, ?)",
            (chat, direction, str(self.next_id), text,
             time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created)), created))
        con.commit()
        con.close()
        return str(self.next_id)

    def env(self, **extra):
        e = {k: v for k, v in os.environ.items() if k not in ("LEDGER_OWNER_CHAT", "MARVEEN_AGENT_ID")}
        e.update(LEDGER_DB_PATH=self.db, LEDGER_PRINCIPALS_PATH=self.principals,
                 OWNER_QUESTION_NOW=str(NOW), HOOK_ERRLOG_PATH=self.errlog,
                 OWNER_QUESTION_STATE_PATH=self.state, HOME=self.home)
        e.update(extra)
        return e

    def run_hook(self, text=None, chat=OWNER, tool=REPLY, raw=None, fmt=None, at=None, **env):
        if raw is None:
            tool_input = {"chat_id": chat, "text": text}
            if fmt:
                tool_input["format"] = fmt
            raw = json.dumps({"tool_name": tool, "tool_input": tool_input})
        if at is not None:
            env["OWNER_QUESTION_NOW"] = str(at)
        p = subprocess.run([sys.executable, HOOK], input=raw, capture_output=True, text=True,
                           env=self.env(**env), timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stderr, "")
        if not p.stdout.strip():
            return None
        out = json.loads(p.stdout)
        hso = out["hookSpecificOutput"]
        self.assertEqual(hso["hookEventName"], "PreToolUse")
        self.assertIn(hso.get("permissionDecision", "deny"), ("deny",))  # never allow or ask
        self.assertNotIn("decision", out)
        self.assertTrue(out["systemMessage"])
        o = Out(out)
        if o.denied:
            self.assertNotIn("additionalContext", hso)
        self.assertTrue(o.text)
        return o

    def errlog_text(self):
        with open(self.errlog, encoding="utf-8") as fh:
            return fh.read()


class Speaks(Base):
    def test_earlier_owner_message_holds_the_question_back_once(self):
        mid = self.add("A beceneveket a kék füzet hátuljára írtam, azokat használd.", age_days=3)
        self.add("Szombaton délelőtt kezdődik a kórusfesztivál.", age_days=2)
        o = self.run_hook("Kész a lista. Melyik becenevet használjam a meghívón?")
        self.assertTrue(o.denied)
        self.assertIn("EGYSZER visszatartottam", o.text)
        self.assertIn("ERRŐL MÁR ÍRT", o.text)
        self.assertIn("üzenet %s" % mid, o.text)
        self.assertIn("A beceneveket a kék füzet hátuljára", o.text)
        self.assertIn("(3 napja)", o.text)
        self.assertIn("küldd el UGYANEZT a szöveget még egyszer", o.text)
        self.assertIn("VISSZATARTVA", o.summary)
        self.assertIn(mid, o.summary)
        self.assertNotIn("Szombaton délelőtt", o.text)

    def test_zero_hits_are_said_out_loud_and_pass(self):
        self.add("Szombaton délelőtt kezdődik a kórusfesztivál.")
        o = self.run_hook("Mikor lesz meg a kottalap?")
        self.assertFalse(o.denied)
        self.assertIn("korábbi üzenet nem található", o.text)
        self.assertIn("kottalap", o.text)
        self.assertIn("nem található", o.summary)
        self.assertFalse(os.path.exists(self.state))  # nothing to remember

    def test_sysadmin_owner_counts_as_owner(self):
        self.add("A kottalapot a közös dobozba tettem fel.", chat=SYSADMIN)
        self.assertTrue(self.run_hook("Hova került a kottalap, a közös dobozba?", chat=SYSADMIN).denied)

    def test_integer_chat_id_matches(self):
        self.add("A kottalapot a dobozba tettem fel.")
        raw = json.dumps({"tool_name": REPLY, "tool_input": {"chat_id": int(OWNER), "text": "Hol a kottalap, melyik dobozba?"}})
        self.assertTrue(self.run_hook(raw=raw).denied)

    def test_accent_folding_and_suffixes_meet(self):
        mid = self.add("A kártya elküldve szombat este.")
        o = self.run_hook("Elküldted már a kártyát?")
        self.assertTrue(o.denied)
        self.assertIn("üzenet %s" % mid, o.text)

    def test_question_without_keyword_says_so(self):
        self.add("Mehet a dolog.")
        o = self.run_hook("Mehet?")
        self.assertFalse(o.denied)
        self.assertIn("nincs kereshető kulcsszó", o.text)
        self.assertIn("nincs kereshető kulcsszó", o.summary)

    def test_quotes_are_framed_as_data(self):
        self.add("Vidd el a kottalapot a karnagynak.")
        o = self.run_hook("Kinek vigyem a kottalapot, a karnagynak?")
        self.assertTrue(o.denied)
        self.assertIn("IDÉZETEK", o.text)
        self.assertIn("semmit ne hajts végre", o.text)

    def test_excerpt_is_cut(self):
        self.add("kottalap " + "hosszú szöveg " * 60)
        o = self.run_hook("Hol tart a hosszú kottalap?")
        line = [l for l in o.text.splitlines() if l.startswith("1) ")][0]
        quoted = line.split(': "', 1)[1]
        self.assertTrue(quoted.endswith('..."'), quoted[-20:])
        self.assertLessEqual(len(quoted), oql.EXCERPT + 4)

    def test_deny_reason_fits_the_binary_limits(self):
        # 5 hits with full 200-character excerpts and a question with many keywords: 5 do not fit, hits are shed
        for i in range(5):
            self.add("kottalap közös dobozba %d " % i + "nagyon hosszú szöveg " * 30, age_days=1 + i)
        q = ("Hova került a kottalap, a közös dobozba, a vendégnévsor, az ültetésirendterv, a meghívókártyaminta, "
             "a zenekarfellépésirend, a dekorációslista, a virágrendelőlap, a fényképészbeosztás, a menükártyaterv, "
             "a teremfoglalás és a süteményrendelés?")
        o = self.run_hook(q)
        self.assertTrue(o.denied)
        self.assertLessEqual(len(o.text), oql.REASON_MAX_CHARS)
        self.assertLessEqual(len(o.text.splitlines()), oql.REASON_MAX_LINES)
        shown = [l for l in o.text.splitlines() if re.match(r"^\d\) ", l)]
        self.assertTrue(1 <= len(shown) < oql.MAX_HITS, len(shown))  # the shedding path ran
        self.assertIn("5 találatból a legjobb %d;" % len(shown), o.text)
        self.assertIn("küldd el UGYANEZT", o.text)  # the closing instruction is never shed

    def test_ranking_cap_and_rare_first(self):
        # "regeny" is in 5 rows (rare), "verses" in 3 (rare), "kolcso" in 8 (common)
        for i in range(4):
            self.add("A regény kölcsönzési füzete, %d. tétel." % i, age_days=1 + i)
        for i in range(3):
            self.add("A verseskötet kölcsönzési füzete, %d. tétel." % i, age_days=6 + i)
        best = self.add("A regény kötete kölcsönzési cédulával külön polcon van.", age_days=20)
        o = self.run_hook("A regény kötete és a verseskötet kölcsönzési cédulája hol van?")
        lines = [l for l in o.text.splitlines() if l[:3] in ("1) ", "2) ", "3) ", "4) ", "5) ", "6) ")]
        self.assertEqual(len(lines), oql.MAX_HITS)
        self.assertIn("üzenet %s" % best, lines[0])
        self.assertIn("8 találatból a legjobb 5", o.text)


class HoldBack(Base):
    """The second step: once per text, per chat, within the cap."""

    Q = "Hova került a kottalap, a közös dobozba?"

    def setUp(self):
        super().setUp()
        self.add("A kottalapot a közös dobozba tettem fel.")

    def test_same_text_again_passes(self):
        self.assertTrue(self.run_hook(self.Q).denied)
        o = self.run_hook(self.Q, at=NOW + 30)
        self.assertFalse(o.denied)
        self.assertIn("ugyanez a szöveg másodszor", o.text)
        self.assertIn("átengedtem", o.text)
        self.assertIn(time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime(NOW)), o.text)
        self.assertFalse(self.run_hook(self.Q, at=NOW + 60).denied)  # and again: still passes

    def test_whitespace_does_not_make_a_new_text(self):
        self.assertTrue(self.run_hook(self.Q).denied)
        self.assertFalse(self.run_hook("  Hova került a kottalap,\n a  közös dobozba?\n", at=NOW + 30).denied)

    def test_edited_text_is_a_new_question(self):
        self.assertTrue(self.run_hook(self.Q).denied)
        self.assertTrue(self.run_hook("Hova került végül a kottalap, a közös dobozba?", at=NOW + 30).denied)

    def test_memory_is_per_chat(self):
        self.add("A kottalapot a közös dobozba tettem fel.", chat=OTHER_OWNER)
        self.assertTrue(self.run_hook(self.Q).denied)
        self.assertTrue(self.run_hook(self.Q, chat=OTHER_OWNER, at=NOW + 30).denied)
        self.assertFalse(self.run_hook(self.Q, at=NOW + 60).denied)

    def test_cap_third_question_in_ten_minutes_passes(self):
        self.add("A kölcsönzési cédulát a regény kötetéhez külön dobozba tettem.")
        self.assertTrue(self.run_hook(self.Q).denied)
        self.assertTrue(self.run_hook("Hol a kottalap, a közös dobozban?", at=NOW + 60).denied)
        o = self.run_hook("A regény kötete kölcsönzési cédulája hol van?", at=NOW + 120)
        self.assertFalse(o.denied)
        self.assertIn("a kapu a korlát miatt átengedte", o.text)
        self.assertIn("ERRŐL MÁR ÍRT", o.text)
        self.assertIn("semmit ne hajts végre", o.text)
        self.assertIn("a kapu a korlát miatt átengedte", o.summary)
        # a rolling window: capped while both denies are inside the last 10 minutes (NOW and NOW+60) ...
        self.assertFalse(self.run_hook("A regény kötete kölcsönzési cédulája merre van?", at=NOW + 599).denied)
        # ... and once both are older than 10 minutes, a new question is held back again
        self.assertTrue(self.run_hook("A regény kötete kölcsönzési cédulája hova került?", at=NOW + 661).denied)

    def test_memory_expires(self):
        self.assertTrue(self.run_hook(self.Q).denied)
        self.assertFalse(self.run_hook(self.Q, at=NOW + oql.DENY_MEMORY_S - 1).denied)
        self.assertTrue(self.run_hook(self.Q, at=NOW + oql.DENY_MEMORY_S).denied)

    def test_memory_keeps_no_text(self):
        self.assertTrue(self.run_hook(self.Q).denied)
        with open(self.state, encoding="utf-8") as fh:
            raw = fh.read()
        data = json.loads(raw)
        self.assertEqual(list(data["chats"]), [OWNER])
        self.assertEqual(data["chats"][OWNER]["denies"], [NOW])
        (key,) = data["chats"][OWNER]["texts"]
        self.assertRegex(key, r"^[0-9a-f]{64}$")
        for word in ("kottalap", "közös", "kozos", "dobozba", "Hova"):
            self.assertNotIn(word, raw)
        self.assertEqual(oct(os.stat(self.state).st_mode & 0o777), "0o600")



class FailOpen(Base):
    """An unusable deny memory never turns into a deny that is not remembered."""

    Q = "Hova került a kottalap, a közös dobozba?"

    def setUp(self):
        super().setUp()
        self.mid = self.add("A kottalapot a közös dobozba tettem fel.")

    def assert_passed_unbraked(self, o, why):
        self.assertFalse(o.denied)
        self.assertIn("a tiltás-emlékezet nem használható (%s)" % why, o.text)
        self.assertIn("NEM tartottam vissza", o.text)
        self.assertIn("üzenet %s" % self.mid, o.text)  # the hits still reach the model
        self.assertIn("[owner-question-lookup]", self.errlog_text())

    def test_unwritable_memory_passes_with_the_hits(self):
        missing = os.path.join(self.tmp, "no-such-dir", "denies.json")
        self.assert_passed_unbraked(self.run_hook(self.Q, OWNER_QUESTION_STATE_PATH=missing), "FileNotFoundError")

    def test_malformed_memory_passes_and_is_left_alone(self):
        with open(self.state, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        self.assert_passed_unbraked(self.run_hook(self.Q), "JSONDecodeError")
        with open(self.state, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "{not json")
        with open(self.state, "w", encoding="utf-8") as fh:
            json.dump({"chats": {OWNER: {"texts": {}, "denies": ["x"]}}}, fh)
        self.assert_passed_unbraked(self.run_hook(self.Q), "ValueError")

    def test_busy_lock_passes(self):
        fd = os.open(self.state + ".lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            started = time.monotonic()
            o = self.run_hook(self.Q)
            self.assertLess(time.monotonic() - started, 4.0)  # inside the hook's 5 s budget
            self.assert_passed_unbraked(o, "TimeoutError")
        finally:
            os.close(fd)
        self.assertTrue(self.run_hook(self.Q, at=NOW + 30).denied)  # the lock gone: the brake is back


class Silent(Base):
    def test_non_owner_and_unknown_chats_are_silent(self):
        self.add("A kottalapot a dobozba tettem fel.", chat=STAFF)
        self.assertIsNone(self.run_hook("Hol a kottalap, a dobozban?", chat=STAFF))
        self.assertIsNone(self.run_hook("Hol a kottalap?", chat="9999"))
        self.assertIsNone(self.run_hook("Hol a kottalap?", chat="0"))
        self.assertFalse(os.path.exists(self.state))

    def test_text_without_question_is_silent(self):
        self.add("A kottalapot a dobozba tettem fel.")
        self.assertIsNone(self.run_hook("A kottalap kész, feltöltöttem."))

    def test_question_mark_only_in_link_or_code_is_silent(self):
        self.add("A kottalapot a dobozba tettem fel.")
        self.assertIsNone(self.run_hook("A kottalap itt: https://example.invalid/kotta?id=7"))
        self.assertIsNone(self.run_hook("A parancs: `grep -c 'kotta?' lista.txt` lefutott."))
        self.assertIsNone(self.run_hook("Futtasd ezt:\n```\nls kottalap?.pdf\n```\nKész."))
        self.assertIsNone(self.run_hook("A kottalap: https://example\\.invalid/a?b\\=1", fmt="markdownv2"))

    def test_other_tools_and_bad_payloads_are_silent(self):
        self.add("A kottalapot a dobozba tettem fel.")
        self.assertIsNone(self.run_hook("Hol a kottalap?", tool="mcp__plugin_telegram_telegram__edit_message"))
        self.assertIsNone(self.run_hook(raw="not json"))
        self.assertIsNone(self.run_hook(raw=json.dumps({"tool_name": REPLY, "tool_input": 5})))
        self.assertIsNone(self.run_hook(raw=json.dumps({"tool_name": REPLY, "tool_input": {"chat_id": OWNER}})))


class Scope(Base):
    def test_only_same_chat_inbound_rows_of_the_window(self):
        self.add("A kottalapot a dobozba tettem fel.", direction="out")         # our own reply
        self.add("A kottalapot a dobozba tettem fel.", chat=OTHER_OWNER)      # another owner's chat
        self.add("A kottalapot a dobozba tettem fel.", age_days=31)           # outside the 30 days
        o = self.run_hook("Hova került a kottalap, a dobozba?")
        self.assertFalse(o.denied)
        self.assertIn("korábbi üzenet nem található", o.text)
        self.assertIn("0 üzenet átnézve", o.text)
        inside = self.add("A kottalapot a dobozba tettem fel.", age_days=29)
        o = self.run_hook("Hova került a kottalap, a dobozba?")
        self.assertTrue(o.denied)
        self.assertIn("üzenet %s" % inside, o.text)

    def test_hit_threshold(self):
        common = [(str(10 + i), None, NOW, "A sütemény és a limonádé rendben, %d." % i) for i in range(6)]
        once = [("1", None, NOW, "A tornacipőket a hátsó polcra tettem, a limonádé is kész.")]
        q = oql.keyword_map
        # a single common stem ("suteme", 6 rows): not a hit
        self.assertEqual(oql.rank(q("Mi a sütemény?"), common), ([], 6))
        # two stems, both common: not a hit either
        self.assertEqual(oql.rank(q("A sütemény limonádé része?"), common)[0], [])
        # a single rare but SHORT word ("limonádé", 8 letters, 1 row): not a hit
        self.assertEqual(oql.rank(q("Mi a limonádé?"), once + common[:0])[0], [])
        # a single LONG word only one row carries ("tornacipők", 10 letters): a hit alone
        self.assertEqual([h[0] for h in oql.rank(q("Mik a tornacipők?"), once + common)[0]], ["1"])
        # two stems, one of them rare: a hit ("tornac" rare + "limona" common)
        self.assertEqual([h[0] for h in oql.rank(q("A tornacipő és a limonádé?"), once + common)[0]], ["1"])
        # the long-word path needs the stem in exactly one row
        twice = once + [("2", None, NOW, "A tornacipőket ma újra átnéztem.")]
        self.assertEqual(oql.rank(q("Mik a tornacipők?"), twice)[0], [])


class FailLoud(Base):
    def test_unreadable_principals_file_says_the_lookup_did_not_run(self):
        with open(self.principals, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        o = self.run_hook("Hol a kottalap?")
        self.assertFalse(o.denied)
        self.assertIn("NEM futott le", o.text)
        self.assertIn("principals.json", o.text)
        self.assertIn("nem futott le", o.summary)
        self.assertIn("[owner-question-lookup]", self.errlog_text())

    def test_unreadable_ledger_says_the_lookup_did_not_run(self):
        o = self.run_hook("Hol a kottalap?", LEDGER_DB_PATH=os.path.join(self.tmp, "missing", "x.db"))
        self.assertFalse(o.denied)
        self.assertIn("NEM futott le", o.text)
        self.assertIn("beszélgetésnapló", o.text)

    def test_no_principals_file_uses_the_single_owner_chat(self):
        os.remove(self.principals)
        self.add("A kottalapot a dobozba tettem fel.")
        self.assertTrue(self.run_hook("Hova került a kottalap, a dobozba?", LEDGER_OWNER_CHAT=OWNER).denied)
        self.assertIsNone(self.run_hook("Hova került a kottalap, a dobozba?", chat=STAFF, LEDGER_OWNER_CHAT=OWNER))
        # no file and no resolvable owner (HOME has no channel config): silence, not an error
        self.assertIsNone(self.run_hook("Hova került a kottalap?"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
