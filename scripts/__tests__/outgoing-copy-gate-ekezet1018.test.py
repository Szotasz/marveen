#!/usr/bin/env python3
"""Test the EKEZET1018 accent-dictionary extension of scripts/hooks/outgoing-copy-gate.py.

What it pins down:
  S1  every ACCENTLESS entry is internally consistent: the key is exactly its value (each '/'-separated alternative)
      with the accents and spaces stripped (a two-word standard form like 'új építésű' is allowed), and the key
      itself carries no accent;
  S2  none of the deliberately EXCLUDED homonyms is in the dictionary (KIZART below: the accentless form is another
      real Hungarian word, a frequent English word, or a name), nor the short forms the 2026-08-13 list left out;
  B1  a Hungarian message that contains EVERY new accentless entry is blocked (exit 2), and the reported count of
      missing-accent words is exactly the number of new entries -- so no entry is silently masked or skipped;
  B2  the same message with the correct accents passes (exit 0);
  B3  the five forms measured going through the gate before this change are each blocked on their own, in a short
      message;
  B4  correct Hungarian sentences that USE the excluded homonyms as the real words they are pass (exit 0): no false
      alarm from 'mert', 'teli', 'termek', ...
  B5  an English text with the foreign-looking forms added to AMBIGUOUS_TRIGGER (privat, zart, molo, seta, mutans,
      kanape) passes: on their own they do not pull a non-Hungarian text into the audit; B5b the same for the
      sentence-start names (Keri, Iger, Soran), B5c for the second group (Hany, Korben, Kozel, Barki,
      Levo).
  B6  the NAME-class trigger words (AMBIGUOUS_NAME_TRIGGER) exempt only in their capitalised, sentence-start form: the
      same word in LOWERCASE in a short accentless message is evidence and the message is blocked, with the word named
      KONTROLL-N: each B6 message is re-run on a copy whose name list exempts case-insensitively (the
      s2 behaviour); the copy must let it through, otherwise the message has other evidence and B6 is blind.
      Every pass-expected check also requires that the output carries no FAIL-OPEN / internal-error marker (the
      Telegram path lets a message through with exit 0 on an internal error).
KONTROLL-T: for EACH word this branch added to AMBIGUOUS_TRIGGER, its B5 case is re-run against a copy of the hook
whose trigger list lacks only that word; the copy must block it (exit 2) for missing accents AND name the word. A word
whose removal changes nothing is untested ('Soran' mid-sentence was skipped by the capitalisation
rule before the trigger list mattered, and the earlier all-lines-at-once control hid it behind Keri and Iger).
KONTROLL: B1 is re-run against a copy of the hook with the EKEZET1018 block removed, in a TEMPORARY directory that
mirrors scripts/hooks + scripts/lib by symlink (so its imports resolve -- a copy without them fails closed and would
look like a block). The copy must NOT report the full count; if it does, B1 is blind. The directory is removed.
Run: python3 scripts/__tests__/outgoing-copy-gate-ekezet1018.test.py   (exit 0 = all pass, 1 = a failure)
"""
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")
JEL = "# EKEZET1018 (2026-10-18): +476 entries"
TR = str.maketrans("áéíóöőúüű", "aeiooouuu")

KIZART = ["mert", "mertek", "mertem", "merve", "merne", "merni", "meri", "akar", "kapna", "kapcsolhatok", "agyak",
          "aggyal", "varja", "fele", "teli", "termek", "hajra", "deli", "dont", "fore", "datum", "foto",
          "helyen", "panorama", "tora", "hatter",
          # the accentless form is a frequent real word in correctly accented prose
          "futott", "mentes", "tartalmat", "tartsatok",
          # a real verb
          "tarolunk",
          # deliberate omissions of the 2026-08-13 list (per the gate source), so this extension does not bring them back
          "mar", "meg", "kor", "fonok", "var", "kod", "hozza", "meres", "lepes", "szamlazz", "jon", "tovabbra"]
MEASURED_PASSES = ["unnepek", "lakas", "haloszoba", "padlofutes", "kulcsszef"]
HELYES_HOMONIMA = [
    "Azért írom, mert a vendég akar jönni, és a fele csapat már itt van.",
    "A pohár teli van, a termek nagyok, és ő is kapna egyet, ha meri kérni.",
    "A seb varja lassan leesett, a deli legény a hajra tett egy szép csatot.",
    "A teszt tegnap futott, a tartalmat átnéztem, tartsatok velünk, a hétvége gondoktól mentes, a halotti tora után.",
    # a capitalised sentence-start homonym (the gate looks at a capitalised word only there)
    "Mertek nagyot álmodni. Mindent tarolunk, ha a csapat jól játszik.",
    # page paths that are dictionary words; the path mask (EKEZETMASZK1018) covers them
    "Szia! Így az /adatvedelem/ és a /kornyek/ lap is ezt kapja, köszönöm szépen.",
    "A számot nem mertem leírni, de ők mertek, és merve kérdezték.",
]

B5_ESETEK = [
    ("B5", "The privat molo session was zart early, so the seta and the kanape demo moved to Monday, mutans aside."),
    # 'Soran' mid-sentence ('and Soran') never became a token because of the capitalisation rule, so it starts a sentence
    ("B5b", "Keri said the deploy is fine. Iger agreed. Soran will ship the build on Monday."),
    # the second group of five sentence-start names
    ("B5c", "Hany said the build is green. Korben agreed. Kozel will ship it on Monday. Barki checks the logs. "
            "Levo signs off."),
]
# B6: kisbetus nev-osztalyu szo rovid, ekezet nelkuli uzenetben (kevesebb mint 3 HU-marker, mas szotar-szo nelkul)
B6_ESETEK = {
    "keri": "anna keri holnapra",
    "iger": "iger egy jo hetet",
    "soran": "holnap soran megyunk",
    "hany": "hany fo jon",
    "korben": "korben jarunk",
    "kozel": "kozel a strand, oke",
    "barki": "barki johet",
    "levo": "a bent levo kulcs",
}
# a KONTROLL-N mutansa: a nev-lista betumerettol fuggetlenul mentesit (az s2 viselkedese)
NEV_UJ = "and not (w in AMBIGUOUS_NAME_TRIGGER and text[p:p + 1].isupper())"
NEV_REGI = "and w not in AMBIGUOUS_NAME_TRIGGER"

# a branch altal az AMBIGUOUS_TRIGGER-be tett sorok (a KONTROLL-T ezekbol egyszerre EGY szot vesz ki a mutansban)
TRIGGER_SOROK = ['    "privat", "zart", "molo", "seta", "mutans", "kanape",\n',
                 '    "keri", "iger", "soran",\n',
                 '    "hany", "korben", "kozel", "barki", "levo",\n']

FAILS = []


def check(nev, ok, reszlet=""):
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", nev, "" if ok or not reszlet else " (%s)" % reszlet[:300]))
    if not ok:
        FAILS.append(nev)


def szotar(src):
    m = re.search(r"^ACCENTLESS = (\{.*?^\})", src, re.S | re.M)
    return ast.literal_eval(m.group(1))


def uj_blokk_kulcsok(src):
    i = src.index(JEL)
    j = src.index("\n}\n", i)
    return re.findall(r'"([a-z]+)": "', src[i:j])


def run(hook, text):
    p = subprocess.run([sys.executable, hook], input=json.dumps(
        {"tool_name": "mcp__plugin_telegram_telegram__reply", "tool_input": {"text": text}}),
        capture_output=True, text=True, timeout=30)
    return p.returncode, p.stdout + p.stderr


def atment(kod, kimenet):
    """0-s kilepes, ES nem a FAIL-OPEN ag engedte at (a Telegram-ag belso hibanal 0-val atenged)."""
    return kod == 0 and "FAIL-OPEN" not in kimenet and "belso hiba" not in kimenet


def hianyzo_db(kimenet):
    m = re.search(r"HIANYZO EKEZETEK, (\d+) szo", kimenet)
    return int(m.group(1)) if m else 0


def mutans_futtat(mutans_src, szovegek):
    """A mutans kaput IDEIGLENES mappaban futtatja (ne irjunk az elo scripts/hooks/-ba), a kapu ket
    importjaval (scripts/lib -> mixed_script, a hook melletti email_extract.py) symlinkkel, kulonben fail-closed
    2-vel allna le, ami blokkolasnak latszana. Szovegenkent (kilepes, kimenet); a mappat torli."""
    tmp = tempfile.mkdtemp(prefix="ekezet1018-mutans-")
    try:
        hooks = os.path.join(tmp, "scripts", "hooks")
        os.makedirs(hooks)
        os.symlink(os.path.join(os.path.dirname(os.path.dirname(HOOK)), "lib"), os.path.join(tmp, "scripts", "lib"))
        os.symlink(os.path.join(os.path.dirname(HOOK), "email_extract.py"), os.path.join(hooks, "email_extract.py"))
        mutans = os.path.join(hooks, "outgoing-copy-gate.py")
        with open(mutans, "w", encoding="utf-8") as fh:
            fh.write(mutans_src)
        return [run(mutans, t) for t in szovegek]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def uzenet(szavak):
    return "Szia! Kérlek, nézd át ezt a listát holnap reggel: " + ", ".join(szavak) + ". Köszönöm szépen."


def main():
    src = open(HOOK, encoding="utf-8").read()
    d = szotar(src)
    uj = uj_blokk_kulcsok(src)
    print("ACCENTLESS: %d bejegyzes, ebbol az EKEZET1018-blokkban %d" % (len(d), len(uj)))

    rossz = [(k, v) for k, v in d.items()
             if k != k.translate(TR)
             or any(alt.strip().lower().translate(TR).replace(" ", "") != k for alt in v.split("/"))]
    check("S1 minden bejegyzes kulcsa = az erteke ekezet nelkul (%d)" % len(d), not rossz, repr(rossz[:10]))
    bent = [k for k in KIZART if k in d]
    check("S2 egyik kizart homonima sincs a szotarban", not bent, repr(bent))
    check("S2b a blokk nem ures, es minden kulcsa a szotarban van", uj and all(k in d for k in uj), str(len(uj)))

    kod, ki = run(HOOK, uzenet(uj))
    check("B1 az osszes uj ekezetlen alak egy magyar uzenetben: tiltva (2)", kod == 2, ki)
    check("B1 a jelentett hianyzo-ekezet darab = az uj bejegyzesek szama (%d)" % len(uj), hianyzo_db(ki) == len(uj),
          "jelentett: %d" % hianyzo_db(ki))

    helyes = [d[k].split(" / ")[0] for k in uj]
    kod, ki = run(HOOK, uzenet(helyes))
    check("B2 ugyanez helyes ekezettel: atmegy (0)", atment(kod, ki), ki)

    for w in MEASURED_PASSES:
        kod, ki = run(HOOK, "Szia! A %s ügyében holnap írok, köszönöm." % w)
        check("B3 '%s' egyedul: tiltva, es a kimenet megnevezi" % w, kod == 2 and w in ki, ki)

    for mondat in HELYES_HOMONIMA:
        kod, ki = run(HOOK, mondat)
        check("B4 helyes homonima-mondat atmegy: %s..." % mondat[:40], atment(kod, ki), ki)

    for nev, szoveg in B5_ESETEK:
        kod, ki = run(HOOK, szoveg)
        check("%s angol szoveg az AMBIGUOUS_TRIGGER-be tett alakokkal: atmegy (0)" % nev, atment(kod, ki), ki)

    nevlista = re.search(r"^AMBIGUOUS_NAME_TRIGGER = \{(.*?)^\}", src, re.S | re.M)
    nevek = set(re.findall(r'"([a-z]+)"', nevlista.group(1))) if nevlista else set()
    check("B6 minden nev-osztalyu szonak van esete", nevek and nevek == set(B6_ESETEK), repr(sorted(nevek)))
    for w, szoveg in B6_ESETEK.items():
        kod, ki = run(HOOK, szoveg)
        check("B6 kisbetus '%s' rovid ekezet nelkuli uzenetben: tiltva, a kimenet megnevezi" % w,
              kod == 2 and "HIANYZO EKEZETEK" in ki and w in ki, ki)

    # KONTROLL-N: betumerettol fuggetlen mentesitessel a B6-uzenetek atmennek -- kulonben mas bizonyitek tiltja oket
    if src.count(NEV_UJ) != 1:
        print("  [FAIL] A KONTROLL-N NEM MERHETO: a nev-feltetel nem talalhato pontosan egyszer")
        FAILS.append("kontroll-n-merhetetlen")
    else:
        for (w, _), (kod, ki) in zip(B6_ESETEK.items(),
                                     mutans_futtat(src.replace(NEV_UJ, NEV_REGI), list(B6_ESETEK.values()))):
            if "Traceback" in ki or kod not in (0, 2):
                print("  [FAIL] A KONTROLL-N NEM MERHETO (%s): a mutans kapu nem futott rendben (kilepes %d)" % (w, kod))
                FAILS.append("kontroll-n-merhetetlen-" + w)
            elif not atment(kod, ki):
                print("  [FAIL] A KONTROLL-N NEM BUKOTT (%s): a regi mentesitessel is tiltva -- a B6 vak (%s)"
                      % (w, ki[:200]))
                FAILS.append("kontroll-n-" + w)
            else:
                print("KONTROLL-N-BUKOTT: '%s' a betumerettol fuggetlen mentesitessel atmegy (0)" % w)

    # KONTROLL: a blokk nelkuli kapu a B1-uzenet teljes darabszamat NEM jelentheti
    i = src.index(JEL)
    j = src.index("\n}\n", i)
    (kod, ki), = mutans_futtat(src[:i] + src[j + 1:], [uzenet(uj)])
    jelentett = hianyzo_db(ki)
    # a kontroll csak akkor ervenyes, ha a mutans kapu TENYLEG lefutott: Traceback vagy nem-2 kilepes
    # egy osszeomlott kontroll, ami a 0-s darabszammal mukodonek latszana
    if "Traceback" in ki or kod != 2:
        print("  [FAIL] A KONTROLL NEM MERHETO: a mutans kapu nem futott rendben (kilepes %d)" % kod)
        FAILS.append("kontroll-merhetetlen")
    elif jelentett == len(uj):
        print("  [FAIL] A KONTROLL NEM BUKOTT: a blokk nelkuli kapu is %d szot jelentett -- a B1 vak" % jelentett)
        FAILS.append("kontroll")
    else:
        print("KONTROLL-BUKOTT: blokk-nelkuli-kapu (jelentett %d, nem %d; kilepes %d)" % (jelentett, len(uj), kod))

    # KONTROLL-T: szavankent -- a mutansbol EGY trigger-szo hianyzik, a sajat B5-esete
    # ekkor ekezet-hiany miatt tiltva, es a kimenet megnevezi a szot; kulonben az a szo teszt nelkul all
    for sor in TRIGGER_SOROK:
        if src.count(sor) != 1:
            print("  [FAIL] A KONTROLL-T NEM MERHETO: a trigger-sor nem talalhato pontosan egyszer: %r" % sor)
            FAILS.append("kontroll-t-merhetetlen")
            continue
        szavak = re.findall(r'"([a-z]+)"', sor)
        for w in szavak:
            eset = [(nev, t) for nev, t in B5_ESETEK if re.search(r"\b%s\b" % w, t, re.I)]
            if not eset:
                print("  [FAIL] A KONTROLL-T NEM MERHETO: '%s' egyik B5-esetben sincs benne" % w)
                FAILS.append("kontroll-t-nincs-eset-" + w)
                continue
            uj_sor = "    " + ", ".join('"%s"' % x for x in szavak if x != w) + ",\n"
            nev, szoveg = eset[0]
            (kod, ki), = mutans_futtat(src.replace(sor, uj_sor), [szoveg])
            if "Traceback" in ki or kod not in (0, 2):
                print("  [FAIL] A KONTROLL-T NEM MERHETO (%s, %s): a mutans kapu nem futott rendben (kilepes %d)"
                      % (w, nev, kod))
                FAILS.append("kontroll-t-merhetetlen-" + w)
            elif not (kod == 2 and "HIANYZO EKEZETEK" in ki and w in ki.lower()):
                print("  [FAIL] A KONTROLL-T NEM BUKOTT (%s, %s): '%s' nelkul sem tiltja ekezet-hiany miatt -- vak (%s)"
                      % (w, nev, w, ki[:200]))
                FAILS.append("kontroll-t-" + w)
            else:
                print("KONTROLL-T-BUKOTT: '%s' nelkul a(z) %s tiltva, a kimenet megnevezi" % (w, nev))

    print("ITELET: %s" % ("minden eset a vart" if not FAILS else "%d eset elter: %s" % (len(FAILS), FAILS)))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
