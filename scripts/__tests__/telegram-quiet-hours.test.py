#!/usr/bin/env python3
"""Quiet-hours brake: the module, the reply-guard wiring and the watchdog gate (card e6680b3c).

WHY THIS FILE EXISTS: until 2026-09-22 the whole quiet-hours mechanism lived in ~/.claude/hooks,
outside version control. On 2026-09-12 an update run (update.sh -> scripts/sync-hooks.sh ->
install-*-hook.sh) copied the repo's hooks over the locally patched ones and the brake vanished
for ten days without a single signal. These tests fail if any part of that arrangement returns.

Every assertion has its negative control inline: a check that cannot fail is not a check.

Usage: python3 scripts/__tests__/telegram-quiet-hours.test.py
"""
import datetime
import importlib.util
import io
import json
import os
import sys
import tempfile

HOOKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks")
sys.path.insert(0, HOOKS)
TZ = "Europe/Budapest"
CHAT = "1234567890"          # synthetic id on purpose: the origin is a public repo
E = []


def ok(cimke, allitas, reszlet=""):
    E.append(bool(allitas))
    print("  %s  %s%s" % ("OK    " if allitas else "BUKIK ", cimke,
                          ("  | " + str(reszlet)) if reszlet else ""))


def betolt(nev, fajl):
    spec = importlib.util.spec_from_file_location(nev, os.path.join(HOOKS, fajl))
    m = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(m)
    except SystemExit:
        pass
    return m


def config_ir(dir_, adat):
    with io.open(os.path.join(dir_, "quiet-hours.json"), "w", encoding="utf-8") as f:
        json.dump(adat, f)


q = betolt("telegram_quiet_hours", "telegram_quiet_hours.py")

print("=== A) A MODUL MEGKULONBOZTETI A HIANYZO ES AZ URES CONFIGOT")
with tempfile.TemporaryDirectory() as d:
    ok("nincs config -> STATE_MISSING", q.config_state(d) == q.STATE_MISSING, q.config_state(d))
    config_ir(d, {})
    ok("ures config -> STATE_EMPTY", q.config_state(d) == q.STATE_EMPTY, q.config_state(d))
    config_ir(d, {CHAT: {"start": "23:00", "end": "07:00", "tz": TZ}})
    ok("kitoltott config -> STATE_OK", q.config_state(d) == q.STATE_OK, q.config_state(d))
    with io.open(os.path.join(d, "quiet-hours.json"), "w", encoding="utf-8") as f:
        f.write("{ ez nem json")
    ok("romlott config -> STATE_UNREADABLE", q.config_state(d) == q.STATE_UNREADABLE, q.config_state(d))
    # NEGATIV KONTROLL: a negy allapot NEM eshet egybe -- ez a kulonbsegtetel a lenyeg.
    with tempfile.TemporaryDirectory() as d2:
        hianyzo = q.config_state(d2)
        config_ir(d2, {})
        ures = q.config_state(d2)
        ok("NEGATIV KONTROLL: a hianyzo es az ures NEM ugyanaz", hianyzo != ures,
           "%s vs %s" % (hianyzo, ures))

print("\n=== B) in_quiet: ablakon belul / kivul / ejfel-atfordulassal")
with tempfile.TemporaryDirectory() as d:
    config_ir(d, {CHAT: {"start": "23:00", "end": "07:00", "tz": TZ}})
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(TZ)
    except Exception:
        tz = None

    def t(ora, perc):
        return datetime.datetime(2026, 9, 12, ora, perc, tzinfo=tz)

    ok("23:30 -> csendes", q.in_quiet(d, CHAT, t(23, 30)) is True)
    ok("02:00 -> csendes (ejfel utan, atfordulo ablak)", q.in_quiet(d, CHAT, t(2, 0)) is True)
    ok("22:59 -> NEM csendes (a start zart)", q.in_quiet(d, CHAT, t(22, 59)) is False)
    ok("07:00 -> NEM csendes (a vege nyitott)", q.in_quiet(d, CHAT, t(7, 0)) is False)
    ok("ismeretlen chat -> NEM csendes", q.in_quiet(d, "999", t(23, 30)) is False)
    # NEGATIV KONTROLL: config nelkul MINDEN idopont nem-csendes (fail-open, szandekosan)
    with tempfile.TemporaryDirectory() as d2:
        ok("NEGATIV KONTROLL: config nelkul 23:30 sem csendes (fail-open)",
           q.in_quiet(d2, CHAT, t(23, 30)) is False)

print("\n=== C) A WATCHDOG KAPUJA")
wd = betolt("telegram_progress_watchdog", "telegram_progress_watchdog.py")
ok("a _quiet_chats fuggveny letezik", hasattr(wd, "_quiet_chats"))
with tempfile.TemporaryDirectory() as d:
    # A window around NOW, not "00:00-23:59": [start, end) leaves 23:59 out, so this check failed
    # one minute a day (measured 2026-10-01 21:59Z, 23:59 Budapest). The module handles a window
    # that wraps midnight, so two hours around the local time is quiet whatever the clock says.
    from zoneinfo import ZoneInfo
    _most = datetime.datetime.now(ZoneInfo(TZ))
    _kezd = (_most - datetime.timedelta(hours=1)).strftime("%H:%M")
    _vege = (_most + datetime.timedelta(hours=1)).strftime("%H:%M")
    config_ir(d, {CHAT: {"start": _kezd, "end": _vege, "tz": TZ}})
    pend = [{"chat_id": CHAT, "message_id": 1}, {"chat_id": "999", "message_id": 2}]
    csendes = wd._quiet_chats(d, pend)
    ok("a csendes chatet megtalalja", CHAT in [str(x) for x in csendes], str(csendes))
    ok("a nem csendeset nem", "999" not in [str(x) for x in csendes], str(csendes))
with tempfile.TemporaryDirectory() as d:
    # config NELKUL: fail-open (ures lista), de NEM nema -- a defektus stderr-re megy
    ok("config nelkul fail-open (ures lista)", wd._quiet_chats(d, [{"chat_id": CHAT}]) == [])

print("\n=== D) SZERKEZETI: a kapu a KULDES ELOTT all, es nincs tobbe ~/.claude/hooks import")
import ast
wd_src = io.open(os.path.join(HOOKS, "telegram_progress_watchdog.py"), encoding="utf-8").read()
fa = ast.parse(wd_src)
# A HIANY NEM DOBHAT KIVETELT, HANEM NEVESITETT PIROSAT KELL ADNIA: az elso alak
# `.index()`-szel dolgozott, es a kapu kivetelekor ValueError-traceback jott, nem bukas --
# egy crash a jelentesben nem ugyanaz, mint egy piros teszt (merve: 2026-09-22).
kapu_sor = wd_src.find("if _quiet_chats(state_dir, pend):")
kapu_lineno = (wd_src[:kapu_sor].count("\n") + 1) if kapu_sor >= 0 else -1
api_sorok = [n.lineno for n in ast.walk(fa)
             if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "api"]
handle_dir = [n for n in ast.walk(fa)
              if isinstance(n, (ast.FunctionDef,)) and n.name == "handle_dir"]
ok("a handle_dir megvan", bool(handle_dir))
ok("a csendes kapu LETEZIK a watchdogban", kapu_lineno > 0,
   "HIANYZIK -- a watchdog csendes ablakban is kezbesitene")
if handle_dir and kapu_lineno > 0:
    hd = handle_dir[0]
    # A kapu minden TARTALMAT KULDO utat elozzon meg. A `deliver()` az EGYETLEN ilyen ut;
    # a delete-only agak nem kuldenek uzenetet. A 24 oras STALE ag torlese SZANDEKOSAN a kapu
    # ELOTT all (lasd a kod kommentjet) -- ezt a teszt KIMONDJA, nem hallgatolagosan turi.
    deliver_sorok = [n.lineno for n in ast.walk(hd)
                     if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                     and n.func.id == "deliver"]
    ok("a csendes kapu MEGELOZI a deliver()-t (az egyetlen tartalmat kuldo ut)",
       deliver_sorok and kapu_lineno < min(deliver_sorok),
       "kapu@%d < deliver@%s" % (kapu_lineno, min(deliver_sorok) if deliver_sorok else "-"))
    belso_api = [l for l in api_sorok if hd.lineno <= l <= (hd.end_lineno or hd.lineno)]
    kapu_elott = [l for l in belso_api if l < kapu_lineno]
    ok("a kapu ELOTT CSAK a STALE-ag torlese all (delete-only, nem kuld)",
       len(kapu_elott) == 1,
       "kapu elott %d api-hivas: %s" % (len(kapu_elott), kapu_elott))
    ok("es az tenyleg deleteMessage, nem sendMessage",
       all("deleteMessage" in wd_src.splitlines()[l - 1] for l in kapu_elott),
       [wd_src.splitlines()[l - 1].strip()[:44] for l in kapu_elott])
    # NEGATIV KONTROLL: a mero tudna-e sorrend-hibat jelezni?
    ok("NEGATIV KONTROLL: a mero lat api() hivast a handle_dir-ben", len(belso_api) >= 2,
       "%d db" % len(belso_api))

rg_src = io.open(os.path.join(HOOKS, "telegram-reply-guard.py"), encoding="utf-8").read()
ok("a reply-guard NEM importal a ~/.claude/hooks-bol",
   "expanduser(\"~/.claude/hooks\")" not in rg_src)
ok("a reply-guard jelzi a hianyzo modult (nem nema)", "_quiet_defect(" in rg_src)
ok("NEGATIV KONTROLL: a mero tuzelne a regi alakra",
   "expanduser" in 'sys.path.insert(0, os.path.expanduser("~/.claude/hooks"))')

pg_src = io.open(os.path.join(HOOKS, "telegram_progress.py"), encoding="utf-8").read()
ok("a submit-hook sajat konyvtarbol importal",
   "dirname(os.path.abspath(__file__))" in pg_src and "telegram_quiet_hours" in pg_src)
ok("a submit-hook jelzi a csendes-ellenorzes hibajat", "quiet check failed" in pg_src)

print("\n=== E) A STOP-FALLBACK AG (ez kuldte ki a mai uzenetet) NEM LEHET NEMA")
# Tesztelesi talalat, 2026-09-22: ebben a fajlban a csendes-ellenorzes hibaja
# TELJESEN nema volt -- meg a masik ketto altalanos logolasa sem volt meg. Ha PONTOSAN a
# 09-12-i regresszio ismetlodne, ez az egy fajl nyom nelkul maradt volna.
pc_src = io.open(os.path.join(HOOKS, "telegram_progress_clear.py"), encoding="utf-8").read()
ok("a Stop-fallback sajat konyvtarbol importal",
   "dirname(os.path.abspath(__file__))" in pc_src and "telegram_quiet_hours" in pc_src)
ok("a hianyzo MODULT jelzi", "import telegram_quiet_hours failed" in pc_src)
ok("a hianyzo/olvashatatlan CONFIGOT jelzi", "config_state" in pc_src and "NOT ENFORCED" in pc_src)
ok("a futasideju hibat is jelzi", "in_quiet raised" in pc_src)
# NEGATIV KONTROLL: a regi, NEMA alak nem allhat vissza. A mero arra a pontos alakra tuzel,
# ami 2026-09-22-ig ott allt: egy csupasz except, ami csak ures halmazt ad es nem naploz.
nema_alak = "    except Exception:\n        quiet = set()"
ok("NEGATIV KONTROLL: a regi NEMA alak nincs a fajlban", nema_alak not in pc_src)
ok("NEGATIV KONTROLL: a mero tuzelne ra (a mintat onmagara probalva)",
   nema_alak in ("x\n" + nema_alak))

print("\n=> OSSZESEN: %d/%d ZOLD" % (sum(E), len(E)))
sys.exit(0 if all(E) else 1)
