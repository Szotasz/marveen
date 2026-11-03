#!/usr/bin/env python3
"""Test the outbound-copy QA gate (scripts/hooks/outgoing-copy-gate.py).

Focus: the name-rule-file state distinction. Two owner decisions meet here,
and the 2026-09-04 upstream merge combined them (see the RULES_* block in the
hook for the full reasoning):
  - GATEPERSIST816/3 (PDB, 2026-08-19): a file that explicitly declares
    no_name_rule=true is a SANCTIONED state, silent everywhere -- and an
    ordinary empty list that merely forgot to say so must never be mistaken
    for it.
  - CLCOPYGATEHIANY902 (upstream, 2026-09-02): a MISSING or empty file is not
    the same as a BROKEN one. Missing/empty now fail-OPEN with a loud,
    user-visible warning, because the file is deliberately not shipped and the
    old fail-closed path left a fresh install unable to send mail at all.
    A file that EXISTS but is unusable (invalid) still fails CLOSED.
So the states are: ok / sanctioned (silent) / missing / empty (open + loud) /
invalid (closed). What this file guards above all is the pair that looks alike
and must not behave alike: sanctioned passes SILENTLY, empty-without-flag
passes LOUDLY.

Also carries a regression pass over the checks this task must NOT touch:
accents, em dash, double-hyphen, mixed-script (homoglyph). Drives the hook as
a subprocess against an isolated OUTGOING_COPY_GATE_RULES file so the real
store/outgoing-copy-gate-rules.json is never touched. Run:
  python3 scripts/__tests__/outgoing-copy-gate.test.py
Exit 0 = all pass; non-zero = a failure (message on stderr).
"""
import json
import os
import sys
import tempfile
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")

CLEAN_HU = "Szia! Koszonom szepen, holnap kuldom at a szamlat es a reszleteket."
# proper accents, no dash, no homoglyph, no bad name -- a payload that should
# sail through every check except whatever the test deliberately breaks.
CLEAN_HU_OK = "Szia! Köszönöm szépen, holnap küldöm át a számlát és a részleteket."


def rules_path(tmpdir, name="rules.json"):
    return os.path.join(tmpdir, name)


def write_rules(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh)


def run_hook(payload, rules_file=None, cwd=None, extra_env=None):
    env = dict(os.environ)
    env.update(extra_env or {})
    if rules_file is not None:
        env["OUTGOING_COPY_GATE_RULES"] = rules_file
    else:
        env.pop("OUTGOING_COPY_GATE_RULES", None)
    p = subprocess.run(
        [sys.executable, HOOK],
        input=json.dumps(payload),
        capture_output=True, text=True, env=env, timeout=20, cwd=cwd,
    )
    return p.returncode, p.stdout, p.stderr


def email_payload(body):
    return {"tool_name": "send_email", "tool_input": {"body": body}}


def telegram_payload(text):
    return {"tool_name": "mcp__plugin_telegram_telegram__reply", "tool_input": {"text": text}}


FAILS = []


def check(name, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: got={got!r} want={want!r}")
    if not ok:
        FAILS.append(name)


def check_true(name, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" ({detail})" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def main():
    with tempfile.TemporaryDirectory(prefix="copygate-") as tmp:

        # --- 1. MISSING file -----------------------------------------------
        missing = rules_path(tmp, "does-not-exist.json")
        # CLCOPYGATEHIANY902: the email goes OUT, but never silently -- the
        # sender has to see that the name check did not protect this letter.
        code, out, err = run_hook(email_payload(CLEAN_HU_OK), rules_file=missing)
        check("missing file: email fail-OPEN (exit 0)", code, 0)
        check_true("missing file: the pass is LOUD (systemMessage names the absent check)",
                   "systemMessage" in out and "HIANYZIK" in out, out)

        code, out, err = run_hook(telegram_payload(CLEAN_HU_OK), rules_file=missing)
        check("missing file: telegram fail-open (exit 0)", code, 0)
        check_true("missing file: telegram warns via systemMessage", "NEV-SZABALY" in out, out)

        # --- 2. CORRUPT file (unparseable JSON) -----------------------------
        corrupt = rules_path(tmp, "corrupt.json")
        with open(corrupt, "w", encoding="utf-8") as fh:
            fh.write("{ not valid json ]")
        code, out, err = run_hook(email_payload(CLEAN_HU_OK), rules_file=corrupt)
        check("corrupt file: email fail-closed (exit 2)", code, 2)
        check_true("corrupt file: email stderr names the rules file", "NEV-SZABALY" in err, err)

        code, out, err = run_hook(telegram_payload(CLEAN_HU_OK), rules_file=corrupt)
        check("corrupt file: telegram fail-open (exit 0)", code, 0)
        check_true("corrupt file: telegram warns via systemMessage", "NEV-SZABALY" in out, out)

        # --- 3. EXPLICIT no-rule (sanctioned, silent) -----------------------
        explicit_none = rules_path(tmp, "explicit-none.json")
        write_rules(explicit_none, {
            "no_name_rule": True,
            "no_name_rule_reason": "teszt: a regi szabaly-fajl elveszett, tudatosan nincs pótolva",
        })
        code, out, err = run_hook(email_payload(CLEAN_HU_OK), rules_file=explicit_none)
        check("explicit no-rule: email proceeds (exit 0)", code, 0)
        check_true("explicit no-rule: email stderr silent on name-rule", "NEV-SZABALY" not in err, err)

        code, out, err = run_hook(telegram_payload(CLEAN_HU_OK), rules_file=explicit_none)
        check("explicit no-rule: telegram proceeds (exit 0)", code, 0)
        check_true("explicit no-rule: telegram stays silent (no systemMessage)", out.strip() == "", out)

        # THE PAIR THAT MUST NOT BE CONFUSED. Since CLCOPYGATEHIANY902 both of
        # these let the letter out, so the exit code alone no longer separates
        # them -- the difference is now the NOISE, and that is what is asserted
        # here. A sanctioned file passes in silence; an ordinary empty list
        # that merely forgot the flag passes with a loud warning. If a future
        # change makes the empty list silent, the sanctioned state would have
        # become reachable by accident, which is what GATEPERSIST816/3 exists
        # to prevent.
        empty_no_flag = rules_path(tmp, "empty-no-flag.json")
        write_rules(empty_no_flag, {"bad_name_patterns": []})
        code, out, err = run_hook(email_payload(CLEAN_HU_OK), rules_file=empty_no_flag)
        check("empty patterns, no explicit flag: email fail-OPEN (exit 0)", code, 0)
        check_true("empty patterns, no explicit flag: the pass is LOUD",
                   "systemMessage" in out and "URES" in out, out)

        code, out, err = run_hook(telegram_payload(CLEAN_HU_OK), rules_file=empty_no_flag)
        check_true("empty patterns, no explicit flag: telegram also warns",
                   "systemMessage" in out, out)

        # --- 4. ACTIVE rule (unchanged matching behaviour) ------------------
        active = rules_path(tmp, "active.json")
        write_rules(active, {
            "bad_name_patterns": [r"\bTeszt[- ]?Elek\b"],
            "correction": "a helyes alak: Teszt Elemer",
        })
        code, out, err = run_hook(email_payload(CLEAN_HU_OK), rules_file=active)
        check("active rule, clean body: email proceeds (exit 0)", code, 0)

        bad_body = CLEAN_HU_OK + " Udvozlettel, Teszt Elek"
        code, out, err = run_hook(email_payload(bad_body), rules_file=active)
        check("active rule, bad name present: email blocks (exit 2)", code, 2)
        check_true("active rule, bad name present: stderr names the bad name", "HELYTELEN NEV" in err, err)
        check_true("active rule, bad name present: stderr carries the correction", "Teszt Elemer" in err, err)

        code, out, err = run_hook(telegram_payload(bad_body), rules_file=active)
        check("active rule, bad name present: telegram blocks (exit 2)", code, 2)

        # --- 5. Regression: checks this task must not touch -----------------
        # 5a. em dash
        code, out, err = run_hook(email_payload(CLEAN_HU_OK + " — mégis."), rules_file=active)
        check("em dash still blocks (exit 2)", code, 2)
        check_true("em dash: stderr names it", "GONDOLATJEL" in err, err)

        # 5b. missing accents (accent-insensitive Hungarian detector)
        code, out, err = run_hook(email_payload(CLEAN_HU), rules_file=active)
        check("missing accents still blocks (exit 2)", code, 2)
        check_true("missing accents: stderr names it", "HIANYZO EKEZETEK" in err, err)

        # 5c. double-hyphen em-dash substitute
        code, out, err = run_hook(
            email_payload(CLEAN_HU_OK + " ez most -- szerintem -- jo lesz."), rules_file=active,
        )
        check("double-hyphen still blocks (exit 2)", code, 2)
        check_true("double-hyphen: stderr names it", "DUPLA KOTOJEL" in err, err)

        # 5d. mixed-script (Cyrillic homoglyph 'о' U+043E inside a Latin word)
        homoglyph_word = "kоszonom"  # koszonom with a Cyrillic 'o'
        code, out, err = run_hook(
            email_payload(f"Szia! {homoglyph_word} szepen a segitseget majd irok reszletesen is."),
            rules_file=active,
        )
        check("mixed-script homoglyph still blocks (exit 2)", code, 2)
        check_true("homoglyph: stderr names it", "VEGYES IRASRENDSZERU" in err, err)

        # 5d2. HOMOGLYPHMICRO924: unit and formula notation is not a mixed-script
        # word (MICRO SIGN, superscript and subscript digits disguise no Latin letter).
        units = " A mért késés 40 \u00b5s, a ház 100 m\u00b2, a doboz 5 cm\u00b3, a víz H\u2082O."
        code, out, err = run_hook(email_payload(CLEAN_HU_OK + units), rules_file=active)
        check("unit notation (micro sign, super/subscript digits) passes (exit 0)", code, 0)

        # 5e. clean, correctly-accented text with an active (matching-nothing)
        # rule and no em dash/double-hyphen/homoglyph -> passes clean.
        code, out, err = run_hook(email_payload(CLEAN_HU_OK), rules_file=active)
        check("fully clean body passes (exit 0)", code, 0)

        # --- 6. #1184: manage_email dispatch + telegram codeblock gate ------
        # COPYGATEMATCHER904: the multiplexed manage_email must be classified
        # by OPERATION. Before the fix every letter fell through to exit 0.
        def manage_payload(op, **kw):
            return {"tool_name": "mcp__google-workspace__manage_email",
                    "tool_input": {"operation": op, **kw}}

        code, out, err = run_hook(manage_payload("send", body=CLEAN_HU_OK + " — mégis."),
                                  rules_file=active)
        check("manage_email send with em dash blocks (exit 2)", code, 2)
        code, out, err = run_hook(manage_payload("send", body=CLEAN_HU_OK), rules_file=active)
        check("manage_email send clean passes (exit 0)", code, 0)
        code, out, err = run_hook(manage_payload("search", query="— rossz — szoveg"),
                                  rules_file=active)
        check("manage_email search is not audited (exit 0)", code, 0)
        code, out, err = run_hook(manage_payload("forward", message_id="x"), rules_file=active)
        check("manage_email bare forward passes (exit 0)", code, 0)

        # GATECOPY827: a code block without format=markdownv2 has no copy
        # button on the phone -- machine gate, not memory.
        fenced = "Íme:\n```\nls -la\n```\nfuttasd le kérlek."
        code, out, err = run_hook(telegram_payload(fenced), rules_file=active)
        check("telegram codeblock without markdownv2 blocks (exit 2)", code, 2)
        payload = telegram_payload(fenced)
        payload["tool_input"]["format"] = "markdownv2"
        code, out, err = run_hook(payload, rules_file=active)
        check("telegram codeblock WITH markdownv2 passes (exit 0)", code, 0)

        # edit_message goes through the same telegram gate as reply: the
        # scaffold matcher (#1184) wires both, so both must actually audit.
        edit_bad = {"tool_name": "mcp__plugin_telegram_telegram__edit_message",
                    "tool_input": {"message_id": "1", "text": CLEAN_HU_OK + " — mégis."}}
        code, out, err = run_hook(edit_bad, rules_file=active)
        check("edit_message with em dash blocks (exit 2)", code, 2)
        edit_fence = {"tool_name": "mcp__plugin_telegram_telegram__edit_message",
                      "tool_input": {"message_id": "1", "text": "```\nls\n``` légy szíves."}}
        code, out, err = run_hook(edit_fence, rules_file=active)
        check("edit_message codeblock without markdownv2 blocks (exit 2)", code, 2)
        edit_ok = {"tool_name": "mcp__plugin_telegram_telegram__edit_message",
                   "tool_input": {"message_id": "1", "text": CLEAN_HU_OK}}
        code, out, err = run_hook(edit_ok, rules_file=active)
        check("edit_message clean passes (exit 0)", code, 0)

        # --- GATEDISCORD905: the Discord reply path is audited too ----------
        # Same audit as Telegram, with two deliberate differences: no MarkdownV2
        # unescaping (a backslash on Discord is a literal the author typed), and
        # the Telegram-only code-block rule must NOT fire there.
        discord_bad = {"tool_name": "mcp__plugin_discord_discord__reply",
                       "tool_input": {"text": CLEAN_HU_OK + " — mégis."}}
        code, out, err = run_hook(discord_bad, rules_file=active)
        check("discord reply with em dash blocks (exit 2)", code, 2)
        check_true("discord block names the DISCORD channel, not Telegram",
                   "(Discord)" in err and "(Telegram)" not in err, err)

        discord_ok = {"tool_name": "mcp__plugin_discord_discord__reply",
                      "tool_input": {"text": CLEAN_HU_OK}}
        code, out, err = run_hook(discord_ok, rules_file=active)
        check("discord reply clean passes (exit 0)", code, 0)

        discord_edit = {"tool_name": "mcp__plugin_discord_discord__edit_message",
                        "tool_input": {"message_id": "1", "text": CLEAN_HU_OK + " — mégis."}}
        code, out, err = run_hook(discord_edit, rules_file=active)
        check("discord edit_message with em dash blocks (exit 2)", code, 2)

        # The code-block rule is Telegram-only. Discord renders a fenced block
        # natively and its reply tool has no markdownv2 format value, so firing
        # here would block a problem that does not exist. Paired with the
        # telegram case above, which must stay red for the same input.
        discord_fence = {"tool_name": "mcp__plugin_discord_discord__reply",
                         "tool_input": {"text": fenced}}
        code, out, err = run_hook(discord_fence, rules_file=active)
        check("discord codeblock without markdownv2 passes (exit 0)", code, 0)

        # A name hit still blocks on Discord: the channel branch is a new door,
        # not a bypass.
        discord_name = {"tool_name": "mcp__plugin_discord_discord__reply",
                        "tool_input": {"text": CLEAN_HU_OK + " Üdvözlettel, Teszt Elek"}}
        code, out, err = run_hook(discord_name, rules_file=active)
        check("discord reply with a bad name blocks (exit 2)", code, 2)

        # --- COPYGATEENT914: HTML-ENTITAS NEM KERULHETI MEG A GONDOLATJEL-TILTAST ---
        # Marveen merese 2026-09-14, egy VALODI vevo-levelen: a hook a TAGEKET
        # szedte ki, de az entitast sehol nem dekodolta, igy a `&mdash;` atment
        # es a cimzettnel gondolatjelkent renderelt. A kapu zoldet mondott arra,
        # amit tilt. Merve MIND A HAROM alakon, nem csak a bejelentettre.
        #
        # A SZOVEG SZANDEKOSAN TELJESEN EKEZETES. Az elso valtozatom ekezet
        # nelkuli volt, ezert a HIANYZO-EKEZET szabaly is tuzelt, es az exit 2
        # AKKOR IS teljesult, amikor a dekodolast visszavettem -- a teszt jonak
        # latszott, kozben nem az entitas-utat merte. A mutans-kontroll fogta meg.
        for nev, alak in (("nevesitett &mdash;", "&mdash;"),
                          ("szamos &#8212;", "&#8212;"),
                          ("hex &#x2014;", "&#x2014;")):
            ent = {"tool_name": "mcp__plugin_telegram_telegram__reply",
                   "tool_input": {"text": f"Szia! A határidő {alak} péntek, köszönöm."}}
            code, out, err = run_hook(ent, rules_file=active)
            check(f"HTML-entitas gondolatjel blokkol ({nev})", code, 2)
            check_true(f"...es a GONDOLATJEL indokkal, nem masert ({nev})",
                       "GONDOLATJEL" in (err or ""), detail=(err or "")[:120])

        # NEGATIV KONTROLL: a dekodolas nem tehet minden `&`-t gyanussa.
        amp = {"tool_name": "mcp__plugin_telegram_telegram__reply",
               "tool_input": {"text": "Szia! Kovács &amp; Társa Kft. ajánlata megérkezett."}}
        code, out, err = run_hook(amp, rules_file=active)
        check("&amp; onmagaban NEM blokkol", code, 0)

        # A SORREND KONTROLLJA: tag-kiszedes ELOSZOR, dekodolas AZUTAN. Forditva
        # egy szovegkent mutatott, escape-elt jelolo valodi tagge dekodolodna, es
        # a TAG.sub kitorolne a szoveg egy darabjat -- a kapu nem hibat jelezne,
        # hanem CSENDBEN mast vizsgalna, mint amit kuldunk.
        esc = {"tool_name": "mcp__plugin_telegram_telegram__reply",
               "tool_input": {"text": "Szia! Írd ki: &lt;b&gt;vastag&lt;/b&gt; szöveggel, köszönöm."}}
        code, out, err = run_hook(esc, rules_file=active)
        check("escape-elt jelolo NEM blokkol es nem tunik el", code, 0)

        # A FENTI SOR ONMAGABAN NEM ELEG, ES EZT SAMU MERTE MEG (#1320 review):
        # csak exit 0-t asszertal, ezert MINDKET sorrenddel zold -- vagyis nem
        # bizonyitja azt, amit a kommentje allit. Ez a fog viszont diszkriminal
        # (fuggetlenul visszamerve, True/False):
        #   HELYES sorrend  -> a dekodolt spanban OTT a tiltott jel      -> exit 2
        #   CSERELT sorrend -> a span TAGGE dekodolodik, a TAG.sub a jellel
        #                      EGYUTT torli                             -> exit 0, CSENDES atengedes
        # Vagyis pontosan az a veszely, amit a hook kommentje leir: a kapu nem
        # hibat jelez, hanem mast vizsgal, mint amit kuldunk.
        span = {"tool_name": "mcp__plugin_telegram_telegram__reply",
                "tool_input": {"text": "Szia! A jelölés: &lt;határidő — péntek&gt; formában áll, köszönöm."}}
        code, out, err = run_hook(span, rules_file=active)
        check("escape-elt SPAN-ben rejtett gondolatjel blokkol (sorrend-fog)", code, 2)
        check("...es a GONDOLATJEL indokkal", "GONDOLATJEL" in (err or ""), True)

        # --- C67F5F34: A GOMBFELIRATOK IS KIMENO SZOVEG ----------------------
        # A Telegram reply eszkoz buttons mezoje (a plugin Marveen-foltja) egy
        # koppintassal valaszolhato gombokat tesz a kerdes ala; a felirat az, amit
        # a cimzett lat es visszakuld. A SZOVEG SZANDEKOSAN TISZTA (teljesen
        # ekezetes, gondolatjel nelkul), hogy a tiltas CSAK a feliratbol johessen
        # (a COPYGATEENT914 tanulsaga: egy mas okbol is tuzelo teszt nem mer).
        def gombos(buttons):
            return {"tool_name": "mcp__plugin_telegram_telegram__reply",
                    "tool_input": {"text": CLEAN_HU_OK, "buttons": buttons}}
        code, out, err = run_hook(gombos(["A. Elfogadom", "B. Már megoldva — köszönöm"]), rules_file=active)
        check("gondolatjel a gombfeliratban blokkol (exit 2)", code, 2)
        check_true("...es a GONDOLATJEL indokkal", "GONDOLATJEL" in (err or ""), detail=(err or "")[:120])
        code, out, err = run_hook(gombos("A — B"), rules_file=active)
        check("nem lista alaku buttons is vizsgalt (exit 2)", code, 2)
        # NEGATIV KONTROLL: tiszta feliratok atmennek, es a tiszta szoveg magaban is.
        code, out, err = run_hook(gombos(["A. Elfogadom", "B. Már megoldva", "C. Valami más lesz a megoldás"]),
                                  rules_file=active)
        check("tiszta gombfeliratok atmennek (exit 0)", code, 0)
        code, out, err = run_hook(gombos([]), rules_file=active)
        check("ures gomblista (a billentyuzet levetele) atmegy (exit 0)", code, 0)
        # DCBTN1023: a Discord reply tool gombjai objektumok ({label, style}); a
        # felirat ott is kimeno szoveg, az objektum sajat szavai (label, style) nem.
        def dc_gombos(buttons):
            return {"tool_name": "mcp__plugin_discord_discord__reply",
                    "tool_input": {"chat_id": "1", "text": CLEAN_HU_OK, "buttons": buttons}}
        code, out, err = run_hook(dc_gombos([{"label": "Igen", "style": "success"}, {"label": "Nem — később", "style": "danger"}]),
                                  rules_file=active)
        check("Discord: gondolatjel a gomb label-jeben blokkol (exit 2)", code, 2)
        code, out, err = run_hook(dc_gombos([{"label": "Igen", "style": "success"}, {"label": "Nem", "style": "danger"}]),
                                  rules_file=active)
        check("Discord: tiszta gomb-objektumok atmennek (exit 0)", code, 0)
        # Ami a kapuhoz jut: CSAK a feliratok, az objektum szavai (label, style,
        # success) nem -- azok ASCII-zajkent huznak le az ekezet-aranyon.
        probe = subprocess.run(
            [sys.executable, "-c",
             "import importlib.util,sys,json\n"
             "spec=importlib.util.spec_from_file_location('g',sys.argv[1]); g=importlib.util.module_from_spec(spec); spec.loader.exec_module(g)\n"
             "print(json.dumps(g.collect_channel_body(json.loads(sys.argv[2]), False)))",
             HOOK, json.dumps({"text": "Mehet?", "buttons": [{"label": "Igen", "style": "success"}, {"label": "Nem"}, {"style": "danger"}, "Talán"]})],
            capture_output=True, text=True, timeout=20)
        check("Discord: a kapu a gomb-objektumbol csak a feliratot olvassa",
              json.loads(probe.stdout or "null"), "Mehet?\nIgen\nNem\n{'style': 'danger'}\nTalán")

        # --- GMAILCONNECTOR914: the claude.ai Gmail connector ----------------
        # mcp__claude_ai_Gmail__send_message carries ONE underscore before Gmail,
        # so the old (^|__)gmail__ alternative never matched and the send fell
        # through to exit 0 with no audit (measured 2026-08-30, 2026-09-08).
        for tool in ("send_message", "reply", "forward"):
            bad = {"tool_name": f"mcp__claude_ai_Gmail__{tool}",
                   "tool_input": {"to": ["a@b.hu"], "messageId": "m1", "subject": "Teszt",
                                  "body": CLEAN_HU_OK + " — mégis."}}
            code, out, err = run_hook(bad, rules_file=active)
            check(f"connector {tool} with em dash blocks (exit 2)", code, 2)
            ok = {"tool_name": f"mcp__claude_ai_Gmail__{tool}",
                  "tool_input": {"to": ["a@b.hu"], "messageId": "m1", "subject": "Teszt", "body": CLEAN_HU_OK}}
            code, out, err = run_hook(ok, rules_file=active)
            check(f"connector {tool} clean passes (exit 0)", code, 0)
        fwd = {"tool_name": "mcp__claude_ai_Gmail__forward",
               "tool_input": {"to": ["a@b.hu"], "messageId": "m1", "forwardText": "Nézd meg — fontos."}}
        code, out, err = run_hook(fwd, rules_file=active)
        check("connector forward: forwardText is audited too (exit 2)", code, 2)
        draft_only = {"tool_name": "mcp__claude_ai_Gmail__send_message", "tool_input": {"draftId": "d1"}}
        code, out, err = run_hook(draft_only, rules_file=active)
        check("connector send of a draftId: body unreadable, fail-closed (exit 2)", code, 2)
        for tool in ("search_threads", "get_thread", "label_message"):
            code, out, err = run_hook({"tool_name": f"mcp__claude_ai_Gmail__{tool}", "tool_input": {"q": "x — y"}},
                                      rules_file=active)
            check(f"connector {tool} is a read: passes untouched (exit 0)", code, 0)

        # --- tool names are classified by SUFFIX ----------------------------
        # vendor/gmail-mcp-fork prepends its tool prefix verbatim, so
        # mcp__gmail__v2_reply_all / ...work-send_message must be audited
        # exactly like the bare name. EMAIL_TOOL_RE's `gmail__(reply|...)$`
        # missed every prefixed connector name, and reply_all on a server whose
        # segment is not exactly "gmail" too, so their text went out unaudited.
        dash = CLEAN_HU_OK + " — mégis."
        for pre in ("", "v2_", "v2", "work-", "shared_inbox_", "v-2_"):
            for base in ("send_email", "reply_all", "send_message", "reply", "forward",
                         "draft_email", "create_draft", "update_draft"):
                name = f"mcp__gmail__{pre}{base}"
                code, out, err = run_hook({"tool_name": name, "tool_input": {
                    "to": ["a@b.hu"], "messageId": "m1", "subject": "Teszt", "body": dash}},
                    rules_file=active)
                check(f"prefix {pre!r}: {base} with em dash is audited and blocks (exit 2)", code, 2)
                code, out, err = run_hook({"tool_name": name, "tool_input": {
                    "to": ["a@b.hu"], "messageId": "m1", "subject": "Teszt", "body": CLEAN_HU_OK}},
                    rules_file=active)
                check(f"prefix {pre!r}: {base} clean passes (exit 0)", code, 0)
            code, out, err = run_hook({"tool_name": f"mcp__google-workspace__{pre}manage_email",
                                       "tool_input": {"operation": "send", "to": "a@b.hu", "body": dash}},
                                      rules_file=active)
            check(f"prefix {pre!r}: manage_email send with em dash blocks (exit 2)", code, 2)
            # send_draft carries only a draftId: nothing of ours to audit, and
            # whether it may be SENT is the approval gate's level decision; the
            # copy gate must not turn the empty payload into a hard deny.
            code, out, err = run_hook({"tool_name": f"mcp__gmail__{pre}send_draft",
                                       "tool_input": {"draftId": "r-1"}}, rules_file=active)
            check(f"prefix {pre!r}: send_draft (draftId only) is not a copy-audit target (exit 0)", code, 0)
            for base in ("search_emails", "read_email", "delete_draft", "list_drafts", "get_thread"):
                code, out, err = run_hook({"tool_name": f"mcp__gmail__{pre}{base}",
                                           "tool_input": {"query": "x — y", "body": dash}},
                                          rules_file=active)
                check(f"prefix {pre!r}: {base} is a read: passes untouched (exit 0)", code, 0)
        for name in ("mcp__server-gmail-autoauth-mcp__reply_all", "mcp__workmail__v2_reply_all",
                     "mcp__google_workspace__send_gmail_message", "mcp__google_workspace__draft_gmail_message"):
            code, out, err = run_hook({"tool_name": name, "tool_input": {"messageId": "m1", "body": dash}},
                                      rules_file=active)
            check(f"{name} (no 'gmail__' before the base) is audited and blocks (exit 2)", code, 2)
        for name in ("mcp__gmail__v2_forwarding_settings", "mcp__gmail__v2_send_drafts_list",
                     "mcp__workmail__v2_forward", "mcp__plugin_discord_discord__v2_reply",
                     "mcp__google-workspace__manage_emails_bulk"):
            code, out, err = run_hook({"tool_name": name, "tool_input": {"operation": "send", "body": dash}},
                                      rules_file=active)
            check(f"look-alike {name} is not an outbound mail tool (exit 0)", code, 0)
        # A non-dict tool_input on a PREFIXED send is still fail-closed (the
        # non-dict net used the old regexes too).
        code, out, err = run_hook({"tool_name": "mcp__gmail__v2_reply_all", "tool_input": 42},
                                  rules_file=active)
        check("prefixed reply_all with a non-dict tool_input blocks (exit 2)", code, 2)

    # --- harder-mail (HARDERMAILGATES1019): the draft AND the send tools are audited ---
    with tempfile.TemporaryDirectory() as tmp:
        active = rules_path(tmp, "hm.json")
        write_rules(active, {"bad_name_patterns": [r"\bTeszt[- ]?Elek\b"], "correction": "x"})
        dash = CLEAN_HU_OK + " \u2014 gondolatjel"
        # The names come from the shared fixture (PR #2075 review), so a classifier
        # swap that drops one fails here; the name set itself is pinned too.
        with open(os.path.join(HERE, "fixtures", "harder-mail-tool-names.json"), encoding="utf-8") as fh:
            hm_names = json.load(fh)
        check("harder-mail fixture: the three letter tools", hm_names["names"],
              ["mcp__harder-mail__send_mail", "mcp__harder-mail__send_mail_auto",
               "mcp__harder-mail__create_draft"])
        for tool in hm_names["names"]:
            want = 2 if hm_names["cases"][tool]["copy_gate_em_dash"] == "deny" else 0
            reply = {"tool_name": tool, "tool_input": {"account": "ceges", "reply_to_uid": 7,
                                                       "reply_folder": "INBOX", "body": dash}}
            code, out, err = run_hook(reply, rules_file=active)
            check(f"{tool}: em dash in a reply body -> blocked (exit 2)", code, want)
            payload = {"tool_name": tool, "tool_input": {"account": "ceges", "to": ["a@b.hu"],
                                                         "subject": "Targy", "body": dash}}
            code, out, err = run_hook(payload, rules_file=active)
            check(f"{tool}: em dash in body -> blocked (exit 2)", code, want)
            payload["tool_input"]["body"] = CLEAN_HU_OK
            code, out, err = run_hook(payload, rules_file=active)
            check(f"{tool}: clean body -> proceeds (exit 0)", code, 0)
            payload["tool_input"]["subject"] = "Targy \u2014 gondolatjel"
            code, out, err = run_hook(payload, rules_file=active)
            check(f"{tool}: em dash in SUBJECT -> blocked (exit 2)", code, 2)
        code, out, err = run_hook({"tool_name": "mcp__harder-mail__search_mail",
                                   "tool_input": {"account": "ceges", "query": "x \u2014 y"}},
                                  rules_file=active)
        check("harder-mail search_mail is a read: passes untouched (exit 0)", code, 0)

    # --- harder-mail body_format (HARDERMAILGATES1019, design 6.3a): the RENDERED text is audited ---
    with tempfile.TemporaryDirectory() as tmp:
        active = rules_path(tmp, "hm2.json")
        write_rules(active, {"bad_name_patterns": [r"\bTeszt[- ]?Elek\b"], "correction": "x"})
        # A stand-in for the server venv's python: `-m harder_mail_mcp.render --format X`
        # -> {"text": ...} with tags stripped and entities decoded, like the real CLI.
        stub = os.path.join(tmp, "fake-python")
        with open(stub, "w", encoding="utf-8") as fh:
            fh.write("#!" + sys.executable + "\n"
                     "import html, json, re, sys\n"
                     "assert sys.argv[1:5] == ['-I', '-m', 'harder_mail_mcp.render', '--format'], sys.argv\n"
                     "body = sys.stdin.read()\n"
                     "if '<script' in body:\n"
                     "    sys.stderr.write('A levéltörzs HTML-je nem engedett szerkezetet tartalmaz: <script>')\n"
                     "    sys.exit(1)\n"
                     "print(json.dumps({'text': html.unescape(re.sub(r'<[^>]+>|[*_]', '', body)), 'html': ''}))\n")
        os.chmod(stub, 0o755)
        env_ok = {"HARDER_MAIL_PYTHON": stub}

        def hm(fmt, body, env=env_ok, tool="mcp__harder-mail__create_draft"):
            payload = {"tool_name": tool, "tool_input": {"account": "ceges", "to": ["a@b.hu"],
                                                         "subject": "Árajánlat", "body": body,
                                                         "body_format": fmt}}
            return run_hook(payload, rules_file=active, extra_env=env)

        hidden = "<p>Szia! K&ouml;sz&ouml;n&ouml;m sz&eacute;pen, holnap k&uuml;ld&ouml;m &aacute;t a sz&aacute;ml&aacute;t &mdash; &uuml;dv.</p>"
        code, out, err = hm("html", hidden)
        check("harder-mail html: an em dash hidden as &mdash; -> blocked (exit 2)", code, 2)
        code, out, err = hm("markdown", "**Szia!** Köszönöm szépen, holnap küldöm át a számlát \u2014 üdv.")
        check("harder-mail markdown: em dash in the rendered text -> blocked (exit 2)", code, 2)
        # The discriminating cases: markup splits a word, so the RAW audit sees "k" + "uldom"
        # and passes (measured: rc 0 without the render path); the rendered text says "kuldom".
        split_html = "<p>Köszönöm szépen a megkeresést, holnap k<b>uldom</b> a számlát és a részleteket is.</p>"
        split_md = "Köszönöm szépen a megkeresést, holnap **k**uldom a számlát és a részleteket is."
        code, out, err = hm("html", split_html)
        check_true("harder-mail html: accent error hidden by a tag -> blocked on the rendered text",
                   code == 2 and "kuldom" in err, f"exit={code} err={err[:200]!r}")
        code, out, err = hm("markdown", split_md)
        check_true("harder-mail markdown: accent error hidden by ** -> blocked on the rendered text",
                   code == 2 and "kuldom" in err, f"exit={code} err={err[:200]!r}")
        code, out, err = hm("html", "<p>" + CLEAN_HU_OK + "</p>")
        check("harder-mail html: clean rendered text -> proceeds (exit 0)", code, 0)
        code, out, err = hm("html", "<p>" + CLEAN_HU_OK + "</p>", tool="mcp__harder-mail__send_mail")
        check("harder-mail html send: clean rendered text -> proceeds (exit 0)", code, 0)
        code, out, err = hm("html", "<script>x</script>")
        check_true("harder-mail html: render rejects -> blocked with the render's reason",
                   code == 2 and "<script>" in err, f"exit={code} err={err[:200]!r}")
        code, out, err = hm("html", "<p>" + CLEAN_HU_OK + "</p>", env={"HARDER_MAIL_PYTHON": os.path.join(tmp, "nincs")})
        check_true("harder-mail html: render unavailable -> fail-closed (exit 2), raw markup not audited",
                   code == 2 and "render" in err, f"exit={code} err={err[:200]!r}")
        # Module-path hijack (security review): a harder_mail_mcp/render.py planted in the
        # agent's cwd must not answer for the real one. The system python has no real
        # package, so with -I and a fixed cwd the render is unavailable -> fail-closed;
        # without them the planted module would say "clean" and the letter would pass.
        plant = os.path.join(tmp, "plant", "harder_mail_mcp")
        os.makedirs(plant)
        open(os.path.join(plant, "__init__.py"), "w").close()
        with open(os.path.join(plant, "render.py"), "w", encoding="utf-8") as fh:
            fh.write("import json\nprint(json.dumps({'text': 'Szia!', 'html': ''}))\n")
        payload = {"tool_name": "mcp__harder-mail__send_mail",
                   "tool_input": {"account": "ceges", "to": ["a@b.hu"], "subject": "x",
                                  "body": "<p>a \u2014 b</p>", "body_format": "html"}}
        code, out, err = run_hook(payload, rules_file=active, cwd=os.path.dirname(plant),
                                  extra_env={"HARDER_MAIL_PYTHON": sys.executable})
        check("harder-mail render: a module planted in cwd is not used (fail-closed, exit 2)", code, 2)
        code, out, err = hm("html", "<p>" + CLEAN_HU_OK + "</p>", env={"HARDER_MAIL_PYTHON": "python3"})
        check_true("harder-mail render: a non-absolute interpreter path is refused",
                   code == 2 and "abszolut" in err, f"exit={code} err={err[:200]!r}")
        # The floor (security review): a stand-in render that answers "clean" cannot
        # hide what a local tag strip of the raw body shows.
        liar = os.path.join(tmp, "liar-python")
        with open(liar, "w", encoding="utf-8") as fh:
            fh.write("#!" + sys.executable + "\n"
                     "import json, sys\nsys.stdin.read()\n"
                     "print(json.dumps({'text': 'Szia! Köszönöm szépen.', 'html': ''}))\n")
        os.chmod(liar, 0o755)
        code, out, err = hm("html", "<p>" + CLEAN_HU_OK + " &mdash; x</p>", env={"HARDER_MAIL_PYTHON": liar})
        check("harder-mail render floor: a render that hides an &mdash; -> still blocked (exit 2)", code, 2)
        code, out, err = hm("html", split_html, env={"HARDER_MAIL_PYTHON": liar})
        check_true("harder-mail render floor: a render that hides k<b>uldom</b> -> still blocked",
                   code == 2 and "kuldom" in err, f"exit={code} err={err[:200]!r}")
        code, out, err = hm("rtf", CLEAN_HU_OK)
        check("harder-mail: unknown body_format -> fail-closed (exit 2)", code, 2)
        code, out, err = hm("plain", CLEAN_HU_OK, env={"HARDER_MAIL_PYTHON": os.path.join(tmp, "nincs")})
        check("harder-mail plain: no render needed (exit 0)", code, 0)
        # The render is the harder-mail server's: another server's body_format is
        # audited raw as before, and never fails closed for a missing harder-mail render.
        code, out, err = hm("html", "<p>" + CLEAN_HU_OK + "</p>", env={"HARDER_MAIL_PYTHON": os.path.join(tmp, "nincs")},
                            tool="mcp__google_workspace__draft_gmail_message")
        check("another server's body_format=html: audited raw, no harder-mail render (exit 0)", code, 0)

    if FAILS:
        print(f"\n{len(FAILS)} FAILED: {FAILS}", file=sys.stderr)
        sys.exit(1)
    print("\nAll outgoing-copy-gate tests passed.")


if __name__ == "__main__":
    main()
