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
check("missing dictionary never raises", v.apply_pronunciation("Monday", path="/nonexistent.json"), "Monday")

os.environ.pop("MARVEEN_WHISPER_MODEL", None)
check("whisper model default", v._whisper_model_name(), "small")
os.environ["MARVEEN_WHISPER_MODEL"] = "medium"
check("whisper model override", v._whisper_model_name(), "medium")

print("All tests passed." if not fails else f"{fails} failed")
sys.exit(1 if fails else 0)
