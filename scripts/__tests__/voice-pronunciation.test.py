#!/usr/bin/env python3
"""apply_pronunciation (Hungarian phonetic rewrite before TTS) and the
configurable whisper model name. Pure functions, no audio, no network."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "voice"))
import _vtools as v  # noqa: E402

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" -- got {got!r}, want {want!r}"))
    if not ok:
        fails += 1


check("suffix is kept", v.apply_pronunciation("A Mondayben van a meeting."), "A mandéjben van a míting.")
check("case-insensitive, suffix kept", v.apply_pronunciation("Nézd meg az emailt!"), "Nézd meg az ímélt!")
check("hyphenated suffix", v.apply_pronunciation("GitHub-on"), "githab-on")
check("plain Hungarian untouched", v.apply_pronunciation("Nincs angol szó."), "Nincs angol szó.")
# Positive cases: plain word, hyphenated suffix, glued ending, end of sentence.
check("plain word", v.apply_pronunciation("Nyisd meg a Google oldalt"), "Nyisd meg a gugli oldalt")
check("hyphenated suffix kept", v.apply_pronunciation("Az Opus-szal beszéltem"), "Az ópusz-szal beszéltem")
check("end of sentence", v.apply_pronunciation("Ez az Opus."), "Ez az ópusz.")
check("doubled-consonant instrumental", v.apply_pronunciation("emaillel"), "íméllel")
check("plural + case chain", v.apply_pronunciation("a meetingeken"), "a mítingeken")

# Over-match counterexamples: a longer word that merely STARTS with a key is a
# different word, and a key inside a domain/path/address is not a word at all.
check("Hungarian word starting with a key", v.apply_pronunciation("Az opusz végleges"), "Az opusz végleges")
check("longer English word starting with a key", v.apply_pronunciation("A Driver frissítés"), "A Driver frissítés")
check("inside a domain", v.apply_pronunciation("docs.google.com"), "docs.google.com")
check("domain at start", v.apply_pronunciation("google.com/search"), "google.com/search")
check("inside a URL path", v.apply_pronunciation("https://github.com/org/repo"), "https://github.com/org/repo")
check("inside an e-mail address", v.apply_pronunciation("írj a name@example.com címre"), "írj a name@example.com címre")
check("handle after @", v.apply_pronunciation("kövesd a @GitHub fiókot"), "kövesd a @GitHub fiókot")
check("last path segment", v.apply_pronunciation("example.com/github"), "example.com/github")
check("unknown glued ending is not a suffix", v.apply_pronunciation("Notional"), "Notional")

check("missing dictionary never raises", v.apply_pronunciation("Monday", path="/nonexistent.json"), "Monday")

os.environ.pop("MARVEEN_WHISPER_MODEL", None)
check("whisper model default", v._whisper_model_name(), "small")
os.environ["MARVEEN_WHISPER_MODEL"] = "medium"
check("whisper model override", v._whisper_model_name(), "medium")

print("All tests passed." if not fails else f"{fails} failed")
sys.exit(1 if fails else 0)
