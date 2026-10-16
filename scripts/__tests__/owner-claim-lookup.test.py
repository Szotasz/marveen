#!/usr/bin/env python3
"""owner-question-lookup, the negative-claim part (card b2a292b2): before a reply
that says "nincs", "nem volt", "senki nem" and the like goes to an owner, the
hook asks for a lookup in the same round; without one it holds the reply back
ONCE, through the question part's memory and cap.

What these cases pin, and why each one matters:
  - which clauses are claims: the card's markers and their inflections, a claim
    before a question in the same sentence; and which are not (the card's
    acceptance (3)): questions, thanks, affirmative sentences, conditions,
    someone else's claim, no-action idioms, labels, quotes, an attributive
    "lejárt", code and links;
  - which tool calls are lookups: the conversation log, the memory, the kanban,
    read; a write is not one, a -G query is a read;
  - the round: after the owner's latest message (its send time), within
    LOOKUP_WINDOW_S, the result already seen, not a sub-agent's;
  - a claim without a lookup -> "deny" once, the claims and the hook's own
    conversation_log hits in the reason; the same text again -> passes; a
    lookup lets an edited text pass;
  - a reply that asks AND claims -> one deny with both; the cap is shared;
  - no transcript, or an unreadable one -> passes, said out loud; an unusable
    deny memory -> passes, never an unremembered deny;
  - the reason stays inside the binary's 20-line / 2000-character limit;
  - the transcript is read from its end, and further back when the tail is
    too short for the round.
The question part's own suite (owner-question-lookup.test.py) is not touched:
the card's acceptance (4).

Hermetic: throwaway ledger, principals file, deny memory and transcript, HOME
pointed at a temp dir, the clock fixed with OWNER_QUESTION_NOW. Invented chat ids.
Run: python3 scripts/__tests__/owner-claim-lookup.test.py
"""
import importlib.util
import json
import os
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
MIN = 60
REPLY = "mcp__plugin_telegram_telegram__reply"
OWNER, STAFF, OTHER_OWNER = "1001", "3003", "1004"
PRINCIPALS = {"principals": {
    OWNER: {"name": "Owner A", "role": "owner"},
    STAFF: {"name": "Staff C", "role": "staff"},
    OTHER_OWNER: {"name": "Owner D", "role": "sysadmin_owner"},
}}
CONV = "python3 -c \"import sqlite3; print(sqlite3.connect('store/claudeclaw.db').execute('SELECT text FROM conversation_log').fetchall())\""
MEM_GET = "curl -s -H \"Authorization: Bearer $T\" 'http://localhost:3420/api/memories?agent=agent-a&q=kulcs'"
KANBAN_GET = "curl -s -H \"Authorization: Bearer $T\" http://localhost:3420/api/kanban"
KANBAN_POST = "curl -s -X POST http://localhost:3420/api/kanban/abc/comments --data-binary @c.json"


def iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(epoch)) + ".000Z"


def claims(text, md=False):
    return oql.claim_clauses(text, md)


class Transcript:
    """A session transcript in Claude Code's JSONL shape: a tool call is an
    assistant entry with a tool_use block, its result a user entry with a
    tool_result block."""

    def __init__(self, path):
        self.path = path
        self.entries = []
        self.n = 0

    def call(self, name, args, at, result=True, sidechain=False):
        self.n += 1
        tid = "toolu_%04d" % self.n
        self.entries.append({"type": "assistant", "timestamp": iso(at), "isSidechain": sidechain,
                             "message": {"role": "assistant",
                                         "content": [{"type": "tool_use", "id": tid, "name": name, "input": args}]}})
        if result:
            self.entries.append({"type": "user", "timestamp": iso(at + 2), "isSidechain": sidechain,
                                 "message": {"role": "user",
                                             "content": [{"type": "tool_result", "tool_use_id": tid, "content": "ok"}]}})
        return self

    def bash(self, command, at, **kw):
        return self.call("Bash", {"command": command}, at, **kw)

    def save(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            for entry in self.entries:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return self.path


class Out:
    def __init__(self, raw):
        hso = raw["hookSpecificOutput"]
        self.denied = hso.get("permissionDecision") == "deny"
        self.text = hso["permissionDecisionReason"] if self.denied else hso["additionalContext"]
        self.summary = raw["systemMessage"]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ocl-")
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
        self.next_id = 700
        self.tr = Transcript(os.path.join(self.tmp, "session.jsonl"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def owner_says(self, text, ago, chat=OWNER, written_later=0):
        """An inbound owner message sent `ago` seconds before NOW; the ledger
        writes its row `written_later` seconds after the send."""
        self.next_id += 1
        sent = NOW - ago
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)"
                    " VALUES ('main', ?, 'in', ?, ?, ?, ?)",
                    (chat, str(self.next_id), text, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(sent)),
                     sent + written_later))
        con.commit()
        con.close()
        return str(self.next_id)

    def env(self, **extra):
        e = {k: v for k, v in os.environ.items() if k not in ("LEDGER_OWNER_CHAT", "MARVEEN_AGENT_ID")}
        e.update(LEDGER_DB_PATH=self.db, LEDGER_PRINCIPALS_PATH=self.principals, OWNER_QUESTION_NOW=str(NOW),
                 HOOK_ERRLOG_PATH=self.errlog, OWNER_QUESTION_STATE_PATH=self.state, HOME=self.home)
        e.update(extra)
        return e

    def reply(self, text, chat=OWNER, at=None, transcript=True, **env):
        payload = {"tool_name": REPLY, "tool_input": {"chat_id": chat, "text": text}}
        if transcript is True:
            payload["transcript_path"] = self.tr.save()
        elif transcript:
            payload["transcript_path"] = transcript
        if at is not None:
            env["OWNER_QUESTION_NOW"] = str(at)
        p = subprocess.run([sys.executable, HOOK], input=json.dumps(payload), capture_output=True, text=True,
                           env=self.env(**env), timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stderr, "")
        if not p.stdout.strip():
            return None
        raw = json.loads(p.stdout)
        hso = raw["hookSpecificOutput"]
        self.assertEqual(hso["hookEventName"], "PreToolUse")
        self.assertIn(hso.get("permissionDecision", "deny"), ("deny",))  # never allow or ask
        o = Out(raw)
        if o.denied:
            self.assertNotIn("additionalContext", hso)
            self.assertLessEqual(len(o.text), oql.REASON_MAX_CHARS)
            self.assertLessEqual(len(o.text.splitlines()), oql.REASON_MAX_LINES)
        self.assertTrue(o.text and o.summary)
        return o

    def errlog_text(self):
        with open(self.errlog, encoding="utf-8") as fh:
            return fh.read()

    def denies(self):
        with open(self.state, encoding="utf-8") as fh:
            return json.load(fh)["chats"][OWNER]["denies"]


class Detector(unittest.TestCase):
    """Which clauses are negative claims (NEGATIVE CLAIMS in the hook)."""

    def test_the_cards_markers_and_their_forms_are_claims(self):
        for text in ("A sárga esernyő nincs a fogason.", "Nincsenek új kották a polcon.", "Neki sincs esernyője.",
                     "Kedden nem volt kóruspróba.", "Nem voltak a teremben.", "Azóta senki nem hangolta.",
                     "Senkinek nem írtunk képeslapot.", "A vitrinbe semmi nem került.", "Sehol nem lóg a kabát.",
                     "Soha nem jött képeslap Izlandról.", "Ilyen dallam nem létezik.", "A gondnok nem elérhető.",
                     "A karnagy nem érhető el.", "A bérlet már lejárt, újat veszek.", "A jegyek lejártak.",
                     "Lejárt a jelentkezés.", "A bérlet lejárt.", "A jegy lejárt, újat veszek.",
                     "Az uszodai bérletünk tegnap lejárt, ezért újat veszünk."):
            self.assertEqual(claims(text), [text], text)
        # a spaced " - " ends a clause: the capital after it opens a clause, it is no label
        self.assertEqual(claims("Összefoglaló - Nincs új hiba."), ["Nincs új hiba."])

    def test_a_claim_before_a_question_in_the_same_sentence_counts(self):
        self.assertEqual(claims("A 2.18-as terembe még nincs kulcsunk: elhoznád a portáról?"),
                         ["A 2.18-as terembe még nincs kulcsunk"])
        self.assertEqual(claims("Pünkösd óta lejárt, vízilabdás nincs: ki szól a tagoknak?"),
                         ["Pünkösd óta lejárt, vízilabdás nincs"])

    def test_questions_thanks_and_affirmatives_are_not_claims(self):
        # the card's acceptance (3): a question, a thanks and an affirmative sentence never count
        for text in ("Nincs meg az esernyő?", "Miért nincs még kész a leves, és ki hozza a kenyeret?", "Nincs még csomag, vagy csak a portán hagyták?",
                     "Köszönöm!", "Köszi, szuper.", "Rendben, megvan.", "A kulcs megvan, a képeslap elment.",
                     "Van helyünk a buszon.", "A kóruspróba jól sikerült, a karnagy elégedett."):
            self.assertEqual(claims(text), [], text)

    def test_conditions_and_someone_elses_claims_are_not_claims(self):
        for text in ("Ha estig nincs eső, a kertet locsolni kell.", "Hozd el; ha nincs kéznél, kölcsönadom.",
                     "A gulyás (ha már van paprika, nincs bors) kész.", "Amíg nincs hó, a szánkó a pincében pihen.",
                     "Amennyiben nincs név a bögrén, a sajátodat írd rá.",
                     "A szomszéd kéri: locsold meg, mert szerinte a muskátlit eddig senki nem öntözte.",
                     "Szerintük nem volt ilyen vihar."):
            self.assertEqual(claims(text), [], text)
        # the condition reaches one comma segment back, not further
        text = "Ha megsült, szólok, a torta még nincs kész."
        self.assertEqual(claims(text), [text])

    def test_no_action_idioms_are_not_claims(self):
        for text in ("A papagájjal ma nincs teendőd.", "Esernyőre nincs szükség.", "A zokninak nincs köze az időjáráshoz.",
                     "Nincs mit.", "A sátornak nincs helye a csomagtartóban.", "A biciklivel nincs gond."):
            self.assertEqual(claims(text), [], text)

    def test_labels_and_quotes_are_not_claims(self):
        self.assertEqual(claims("A menü: Fájl, Nézet, Nincs előnézet, Mentés."), [])
        self.assertEqual(claims("Válaszd a \u201eNincs előnézet\u201d lehetőséget."), [])
        self.assertEqual(claims('Azt mondta: "nincs itthon", de azóta hazaért.'), [])
        # a capital at the clause's start is an ordinary sentence, a list marker before it is not a letter
        self.assertEqual(claims("Nincs érvényes bérleted."), ["Nincs érvényes bérleted."])
        self.assertEqual(claims("- Nincs tej a hűtőben."), ["- Nincs tej a hűtőben."])
        self.assertEqual(claims("3) Nincs tej a hűtőben."), ["3) Nincs tej a hűtőben."])

    def test_an_attributive_lejart_is_not_a_claim(self):
        for text in ("Lejárt, kifizetetlen tagdíj 12 darab.", "Két lejárt könyvtári kölcsönzés maradt.",
                     "Az órarend lejártként mutatja.", "A lejárt bérletet érvényesnek mondja.",
                     "Elveszett, lejárt (3 db).", "Helyesen 3 lejárt, elveszett jegy van.",
                     "A már lejárt bérletet érvényesnek mondja.", "A lejárt, elveszett jegyek listája kész."):
            self.assertEqual(claims(text), [], text)

    def test_code_links_and_markdownv2(self):
        self.assertEqual(claims("A receptben: `grep nincs sutemeny.txt`, a többi rendben."), [])
        self.assertEqual(claims("A lista: https://example.invalid/nincs-meg lent."), [])
        self.assertEqual(claims("Futtasd:\n```\necho 'nincs meg'\n```\nKész."), [])
        self.assertEqual(claims("A kulcs nincs meg\\. Szólok\\.", md=True), ["A kulcs nincs meg."])

    def test_one_clause_per_claim_and_order(self):
        self.assertEqual(claims("A létra nincs meg; a kalapács sincs. A festék megjött. Visszajelzés még nincs."),
                         ["A létra nincs meg", "a kalapács sincs.", "Visszajelzés még nincs."])


class Lookups(unittest.TestCase):
    """Which tool calls read the conversation log, the memory or the kanban."""

    def src(self, command=None, name="Bash", **args):
        if command is not None:
            args["command"] = command
        return oql.lookup_sources({"type": "tool_use", "name": name, "input": args})

    def test_conversation_log_is_always_a_read(self):
        self.assertEqual(self.src(CONV), ["beszélgetésnapló"])
        # a script that reads the ledger and then posts a comment still read it
        self.assertEqual(self.src(CONV + " && " + KANBAN_POST), ["beszélgetésnapló"])

    def test_memory_and_kanban_reads(self):
        self.assertEqual(self.src(MEM_GET), ["memória"])
        self.assertEqual(self.src("curl -s -G --data-urlencode 'q=kulcs' http://localhost:3420/api/memories"), ["memória"])
        self.assertEqual(self.src("curl -s -D /tmp/h.txt 'http://localhost:3420/api/memories?q=x'"), ["memória"])
        self.assertEqual(self.src("curl -s http://localhost:3420/api/daily-log?agent=agent-a"), ["memória"])
        self.assertEqual(self.src("cat /home/x/.channels-config/projects/p/memory/owner.md"), ["memória"])
        self.assertEqual(self.src(KANBAN_GET), ["kanban"])
        self.assertEqual(self.src("curl -s http://localhost:3420/api/kanban/abc/comments"), ["kanban"])
        self.assertEqual(self.src("python3 q.py \"SELECT title FROM kanban_cards WHERE status='done'\""), ["kanban"])
        self.assertEqual(self.src(KANBAN_GET + " | grep kulcs; " + MEM_GET), ["memória", "kanban"])

    def test_writes_are_not_lookups(self):
        for command in (KANBAN_POST,
                        "curl -s -X PUT http://localhost:3420/api/kanban/abc -d @d.json",
                        "curl -s -X POST http://localhost:3420/api/memories -H 'Content-Type: application/json' -d '{}'",
                        "curl -s http://localhost:3420/api/kanban/abc/move --data-binary @m.json",
                        "python3 - <<'PY'\nurllib.request.Request('http://localhost:3420/api/kanban/abc/move', data=b, "
                        "method='POST')\nPY",
                        "cat > /home/x/.claude/projects/p/memory/uj.md <<'EOF'\nszoveg\nEOF",
                        "echo x >> /home/x/memory/MEMORY.md"):
            self.assertEqual(self.src(command), [], command)

    def test_file_tools_on_memory(self):
        self.assertEqual(self.src(name="Read", file_path="/home/x/.claude/projects/p/memory/MEMORY.md"), ["memória"])
        self.assertEqual(self.src(name="Grep", pattern="kulcs", path="/home/x/.claude/projects/p/memory"), ["memória"])
        self.assertEqual(self.src(name="Glob", pattern="/home/x/memory/*.md"), ["memória"])
        self.assertEqual(self.src(name="Write", file_path="/home/x/memory/x.md", content="y"), [])
        self.assertEqual(self.src(name="Read", file_path="/home/x/HANDOFF.md"), [])

    def test_other_calls_are_not_lookups(self):
        self.assertEqual(self.src("ls -la /home/x"), [])
        self.assertEqual(self.src("curl -s http://localhost:3420/api/messages?agent=x"), [])
        self.assertEqual(self.src(name="Agent", prompt="nézd meg a conversation_log-ot"), [])
        self.assertEqual(oql.lookup_sources({"type": "tool_use", "name": "Bash", "input": "x"}), [])


class Round(Base):
    """A claim reply and the lookups of its round."""

    CLAIM = "A vendéglista nincs meg nálunk, se a laptopon, se a dobozban."

    def setUp(self):
        super().setUp()
        self.owner_says("Szombaton délelőtt kezdődik a kórusfesztivál.", ago=5 * MIN)

    def test_claim_without_lookup_is_held_back_once(self):
        self.tr.bash("ls -la /home/x", NOW - 2 * MIN)  # a tool call, not a lookup
        o = self.reply(self.CLAIM)
        self.assertTrue(o.denied)
        self.assertIn(oql.CLAIM_TAG, o.text)
        self.assertIn("EGYSZER visszatartottam", o.text)
        self.assertIn('1) "%s"' % self.CLAIM, o.text)
        self.assertIn("ablak: %s óta, a tulajdonos utolsó üzenete" % oql._iso_min(NOW - 5 * MIN), o.text)
        self.assertIn("nevezd meg, honnan tudod", o.text)
        self.assertIn("UGYANEZ a szöveg másodszorra is átmegy", o.text)
        self.assertIn("VISSZATARTVA", o.summary)
        self.assertEqual(self.denies(), [NOW])
        again = self.reply(self.CLAIM, at=NOW + 30)
        self.assertFalse(again.denied)
        self.assertIn("ugyanez a szöveg másodszor", again.text)
        self.assertIn("visszakeresés nélkül ment ki", again.text)
        self.assertIn(oql._iso_min(NOW), again.text)
        self.assertEqual(self.denies(), [NOW])

    def test_the_same_text_in_another_unicode_form_is_the_same_text(self):
        # the memory keys the NFC form (text_key): the same claim resent decomposed (NFD), with other
        # whitespace, is a resend, not a new text -- a tester's LOW observation on fc282e39, here
        # for the claim part, which holds a reply back through the same key
        import unicodedata
        self.assertTrue(self.reply(self.CLAIM).denied)
        nfd = unicodedata.normalize("NFD", "  " + self.CLAIM.replace(" ", "\n ", 1))
        self.assertNotEqual(nfd.strip(), self.CLAIM)
        o = self.reply(nfd, at=NOW + 30)
        self.assertFalse(o.denied)
        self.assertIn("ugyanez a szöveg másodszor", o.text)
        self.assertEqual(self.denies(), [NOW])

    def test_a_lookup_after_the_owner_message_lets_it_pass(self):
        self.tr.bash(CONV, NOW - 1 * MIN)
        o = self.reply(self.CLAIM)
        self.assertFalse(o.denied)
        self.assertIn("volt visszakeresés: beszélgetésnapló %s" % oql._iso_min(NOW - 1 * MIN), o.text)
        self.assertIn("beszélgetésnapló", o.summary)
        self.assertFalse(os.path.exists(self.state))  # nothing held back, nothing remembered

    def test_each_source_counts(self):
        for name, args in (("Bash", {"command": MEM_GET}), ("Bash", {"command": KANBAN_GET}),
                           ("Read", {"file_path": "/home/x/.claude/projects/p/memory/MEMORY.md"})):
            self.tr.entries = []
            self.tr.call(name, args, NOW - 2 * MIN)
            o = self.reply(self.CLAIM)
            self.assertFalse(o.denied, args)
            self.assertIn("volt visszakeresés", o.text)

    def test_a_write_is_not_a_lookup(self):
        self.tr.bash(KANBAN_POST, NOW - 2 * MIN)
        self.tr.bash("curl -s -X POST http://localhost:3420/api/memories -d @m.json", NOW - 1 * MIN)
        self.assertTrue(self.reply(self.CLAIM).denied)

    def test_a_lookup_before_the_owner_message_does_not_count(self):
        self.tr.bash(CONV, NOW - 7 * MIN)  # the owner wrote 5 minutes ago, after it
        o = self.reply(self.CLAIM)
        self.assertTrue(o.denied)
        self.assertIn("a tulajdonos utolsó üzenete", o.text)

    def test_a_lookup_older_than_the_window_does_not_count(self):
        # the owner's latest message is older than the window: the window's own floor applies
        self.owner_says("A kulcsot átküldtem.", ago=2 * 3600, chat=OTHER_OWNER)
        con = sqlite3.connect(self.db)
        con.execute("DELETE FROM conversation_log WHERE chat_id = ?", (OWNER,))
        con.commit()
        con.close()
        self.owner_says("Szombaton délelőtt kezdődik a kórusfesztivál.", ago=2 * 3600)
        self.tr.bash(CONV, NOW - oql.LOOKUP_WINDOW_S - 60)
        o = self.reply(self.CLAIM)
        self.assertTrue(o.denied)
        self.assertIn("az utolsó %d perc" % (oql.LOOKUP_WINDOW_S // 60), o.text)
        self.tr.bash(CONV, NOW - oql.LOOKUP_WINDOW_S + 60)
        self.assertFalse(self.reply("A vendéglista nincs meg nálunk.").denied)

    def test_a_lookup_without_its_result_does_not_count(self):
        # sent in the same message as the reply, or still running: its result was not read before the reply
        self.tr.bash(CONV, NOW - 10, result=False)
        self.assertTrue(self.reply(self.CLAIM).denied)

    def test_a_sub_agents_lookup_does_not_count(self):
        self.tr.bash(CONV, NOW - 1 * MIN, sidechain=True)
        self.assertTrue(self.reply(self.CLAIM).denied)

    def test_the_owner_message_counts_from_its_send_time(self):
        # sent 5 minutes ago, written into the ledger 4 minutes later; the lookup 3 minutes ago is after the send
        con = sqlite3.connect(self.db)
        con.execute("DELETE FROM conversation_log")
        con.commit()
        con.close()
        self.owner_says("Szombaton délelőtt kezdődik a kórusfesztivál.", ago=5 * MIN, written_later=4 * MIN)
        self.tr.bash(CONV, NOW - 3 * MIN)
        self.assertFalse(self.reply(self.CLAIM).denied)

    def test_a_lookup_lets_an_edited_text_pass(self):
        self.assertTrue(self.reply(self.CLAIM).denied)
        self.tr.bash(KANBAN_GET + " | grep vendeg", NOW + 20)
        o = self.reply("A vendéglista nincs meg nálunk (a lapon és a naplóban néztem).", at=NOW + 60)
        self.assertFalse(o.denied)
        self.assertIn("volt visszakeresés: kanban", o.text)
        self.assertEqual(self.denies(), [NOW])

    def test_the_hooks_own_hits_are_in_the_reason(self):
        mid = self.owner_says("A vendéglistát a piros dossziéhoz a közös szekrénybe tettem.", ago=3 * 86400)
        o = self.reply("A piros dosszié vendéglistája nincs meg a közös szekrényben.")
        self.assertTrue(o.denied)
        self.assertIn("A tulajdonos ERRŐL MÁR ÍRT", o.text)
        self.assertIn("illenek az állításhoz", o.text)
        self.assertIn("üzenet %s" % mid, o.text)
        self.assertIn("IDÉZETEK", o.text)
        self.assertNotIn("Szombaton délelőtt", o.text)

    def test_no_earlier_message_is_said_out_loud(self):
        o = self.reply(self.CLAIM)
        self.assertTrue(o.denied)
        self.assertIn("a saját keresésem nem talált az állításhoz illőt", o.text)

    def test_silence_where_the_part_does_not_apply(self):
        self.tr.bash("ls", NOW - 1 * MIN)
        self.assertIsNone(self.reply(self.CLAIM, chat=STAFF))  # not an owner
        self.assertIsNone(self.reply("Köszönöm, minden megvan."))  # no claim, no question
        self.assertIsNone(self.reply("Ha estig nincs eső, a kerti grillezés marad."))  # a condition
        self.assertFalse(os.path.exists(self.state))


class Together(Base):
    """A reply that asks and claims; the shared memory and cap."""

    Q = "Hova került a kottalap, a közös dobozba?"
    CLAIM = "A vendéglista nincs meg."

    def setUp(self):
        super().setUp()
        self.qmid = self.owner_says("A kottalapot a közös dobozba tettem fel.", ago=1 * 86400)
        self.owner_says("Szombaton délelőtt kezdődik a kórusfesztivál.", ago=5 * MIN)

    def test_ask_and_claim_are_held_back_once_together(self):
        text = self.CLAIM + " " + self.Q
        o = self.reply(text)
        self.assertTrue(o.denied)
        self.assertIn("kérdést EGYSZER visszatartottam", o.text)  # the question part's reason ...
        self.assertIn("üzenet %s" % self.qmid, o.text)
        self.assertIn("tagadó állítást is tesz", o.text)  # ... with the claim in it
        self.assertIn('"%s"' % self.CLAIM, o.text)
        self.assertIn("küldd el UGYANEZT", o.text)
        self.assertIn("tagadó állítás is", o.summary)
        self.assertEqual(self.denies(), [NOW])  # one text, one deny
        again = self.reply(text, at=NOW + 30)
        self.assertFalse(again.denied)
        self.assertIn(oql.TAG, again.text)
        self.assertIn(oql.CLAIM_TAG, again.text)
        self.assertEqual(again.text.count("ugyanez a szöveg másodszor"), 2)
        self.assertEqual(self.denies(), [NOW])

    def test_a_covered_claim_leaves_the_question_reason_as_it_was(self):
        self.tr.bash(CONV, NOW - 1 * MIN)
        o = self.reply(self.CLAIM + " " + self.Q)
        self.assertTrue(o.denied)
        self.assertNotIn(oql.CLAIM_TAG, o.text)
        self.assertNotIn("tagadó állítás", o.summary)

    def test_the_cap_is_shared(self):
        self.assertTrue(self.reply("A vendéglista nincs meg.").denied)
        self.assertTrue(self.reply("A kulcs sincs meg.", at=NOW + 60).denied)
        o = self.reply(self.Q, at=NOW + 120)  # a question with hits: the chat is at its cap
        self.assertFalse(o.denied)
        self.assertIn("a kapu a korlát miatt átengedte", o.text)
        self.assertIn("már 2 üzenetet visszatartottam", o.text)
        c = self.reply("A jelszó sincs meg.", at=NOW + 180)
        self.assertFalse(c.denied)
        self.assertIn(oql.CLAIM_TAG + ": a kapu a korlát miatt átengedte", c.text)
        self.assertIn("visszakeresés nélkül megy ki", c.text)


class Failures(Base):
    CLAIM = "A vendéglista nincs meg nálunk."

    def setUp(self):
        super().setUp()
        self.owner_says("Szombaton délelőtt kezdődik a kórusfesztivál.", ago=5 * MIN)

    def test_no_transcript_passes_out_loud(self):
        o = self.reply(self.CLAIM, transcript=None)
        self.assertFalse(o.denied)
        self.assertIn("NEM tudtam ellenőrizni (a hook nem kapott átiratot)", o.text)
        self.assertIn("[owner-question-lookup]", self.errlog_text())
        o = self.reply(self.CLAIM, transcript=os.path.join(self.tmp, "missing", "s.jsonl"))
        self.assertFalse(o.denied)
        self.assertIn("NEM tudtam ellenőrizni (az átirat nem olvasható)", o.text)
        self.assertFalse(os.path.exists(self.state))

    def test_unusable_memory_passes_with_the_claim(self):
        o = self.reply(self.CLAIM, OWNER_QUESTION_STATE_PATH=os.path.join(self.tmp, "no-such-dir", "d.json"))
        self.assertFalse(o.denied)
        self.assertIn("a tiltás-emlékezet nem használható (FileNotFoundError)", o.text)
        self.assertIn('"%s"' % self.CLAIM, o.text)

    def test_unreadable_principals_says_the_check_did_not_run(self):
        with open(self.principals, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        o = self.reply(self.CLAIM)
        self.assertFalse(o.denied)
        self.assertIn(oql.CLAIM_TAG, o.text)
        self.assertIn("NEM futott le", o.text)

    def test_unreadable_ledger_still_asks_for_the_lookup(self):
        o = self.reply(self.CLAIM, LEDGER_DB_PATH=os.path.join(self.tmp, "missing", "x.db"))
        self.assertTrue(o.denied)
        self.assertIn("az utolsó %d perc" % (oql.LOOKUP_WINDOW_S // 60), o.text)
        self.assertIn("a saját keresésem nem futott le", o.text)

    def test_the_reason_fits_the_binary_limits(self):
        # 4 earlier owner messages share rare stems with the claims (4 rows <= RARE_DF): 4 hits with full
        # 200-character excerpts, and 6 long claims -- 3 claims and 3 hits do not fit, so the reason sheds
        for i in range(4):
            self.owner_says("A piros dosszié vendéglistáját a közös szekrénybe tettem, %d. " % i
                            + "nagyon hosszú szöveg " * 30, ago=(i + 1) * 86400)
        text = " ".join("Ez a %d. tétel: a piros dosszié vendéglistája nincs meg a közös szekrényben, és a " % i
                        + "hozzá tartozó névsor sem került elő sehonnan, pedig a teljes szekrényt végignéztük." for i in range(6))
        o = self.reply(text)
        self.assertTrue(o.denied)  # Base.reply asserts the line and character limits
        claim_lines, hit_lines = self.lines(o)
        self.assertEqual(len(claim_lines), 1)  # the claims are shed first: the model wrote them ...
        self.assertEqual(len(hit_lines), oql.MAX_CLAIM_HITS)  # ... the owner's own messages stay
        self.assertIn("(és még 5 tagadó mondat)", o.text)
        self.assertIn("4 találatból a legjobb 3;", o.text)
        self.assertIn("UGYANEZ a szöveg másodszorra is átmegy", o.text)  # the instruction is never shed

    def test_the_hits_are_shed_when_one_claim_is_not_enough(self):
        # a long keyword list (every claim names other parts): even one claim and 3 hits do not fit
        for i in range(4):
            self.owner_says("A piros dosszié vendéglistáját a közös szekrénybe tettem, %d. " % i
                            + "nagyon hosszú szöveg " * 30, ago=(i + 1) * 86400)
        parts = ("porcelánbögre teáskannatartó", "gyertyatartó asztalterítő", "szalvétagyűrű kenyérkosár",
                 "süteményestál tortalapát", "üvegpoharak borosüvegek", "virágtartóállvány kerámiaváza")
        text = " ".join("Ez a %d. tétel: a piros dosszié vendéglistája nincs meg a közös szekrényben, és a %s "
                        "papírjai sem." % (i, part) for i, part in enumerate(parts))
        o = self.reply(text)
        self.assertTrue(o.denied)
        claim_lines, hit_lines = self.lines(o)
        self.assertTrue(1 <= len(hit_lines) < oql.MAX_CLAIM_HITS, len(hit_lines))
        self.assertTrue(1 <= len(claim_lines) <= oql.MAX_CLAIMS_SHOWN, len(claim_lines))
        self.assertIn("4 találatból a legjobb %d;" % len(hit_lines), o.text)
        self.assertIn("UGYANEZ a szöveg másodszorra is átmegy", o.text)

    @staticmethod
    def lines(o):
        rows = o.text.splitlines()
        return ([l for l in rows if l[:4] in ('1) "', '2) "', '3) "')],
                [l for l in rows if l[:3] in ("1) ", "2) ", "3) ") and "üzenet" in l])


class TranscriptTail(unittest.TestCase):
    def test_the_tail_grows_until_it_reaches_the_round(self):
        tmp = tempfile.mkdtemp(prefix="ocl-tail-")
        try:
            path = os.path.join(tmp, "s.jsonl")
            tr = Transcript(path)
            for i in range(400):  # old filler, ~200 KB
                tr.bash("echo %d %s" % (i, "x" * 400), NOW - 3 * 3600 + i)
            tr.bash(CONV, NOW - 10 * MIN)
            tr.bash("ls", NOW - 1 * MIN)
            tr.save()
            saved = oql.TRANSCRIPT_TAILS
            try:
                oql.TRANSCRIPT_TAILS = (1024, 64 * 1024)
                # a 1 KB tail holds only the last call; the round reaches back 20 minutes, so it grows
                entries = oql.read_transcript(path, NOW - 20 * MIN)
                self.assertIn("beszélgetésnapló", oql.find_lookups(entries, NOW - 20 * MIN, NOW))
                self.assertLess(len(entries), len(tr.entries))  # 64 KB was enough: not the whole file
                # older than the whole file: the whole file
                self.assertEqual(len(oql.read_transcript(path, NOW - 4 * 3600)), len(tr.entries))
            finally:
                oql.TRANSCRIPT_TAILS = saved
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
