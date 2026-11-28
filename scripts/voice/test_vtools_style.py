#!/usr/bin/env python3
"""Per-agent voice style: _voice_style_filters accepts exactly the chains the
dashboard builds (src/web/voice-style.ts) and refuses anything else, falling
back to the legacy VOICE_PITCH behaviour.

Run: python3 scripts/voice/test_vtools_style.py
"""

from __future__ import annotations

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("_vtools_under_test", os.path.join(HERE, "_vtools.py"))
vt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vt)

FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print("ok   - %s" % name)
    else:
        FAILS.append(name)
        print("FAIL - %s%s" % (name, ("  :: " + detail) if detail else ""))


def run() -> None:
    f = vt._voice_style_filters
    check("[1] nothing set: no style filter", f({}) == [], repr(f({})))
    chain = "asetrate=24750,aresample=22050,atempo=0.935455"
    check("[2] pitch+tempo chain passes through", f({"MARVEEN_VOICE_STYLE_AF": chain}) == [chain])
    check("[3] tempo-only chain passes through",
          f({"MARVEEN_VOICE_STYLE_AF": "atempo=1.05"}) == ["atempo=1.05"])
    check("[4] chained atempo passes through",
          f({"MARVEEN_VOICE_STYLE_AF": "atempo=2,atempo=1.1"}) == ["atempo=2,atempo=1.1"])
    for bad in ("volume=10", "atempo=1.05,volume=10", "asetrate=24750", "aresample=22050atempo=1",
                "atempo=1.05\natempo=2", "atempo=1.05;rm", ",atempo=1.05", "atempo=-1"):
        got = f({"MARVEEN_VOICE_STYLE_AF": bad})
        check("[5] refused: %r" % bad, got == [], repr(got))
    check("[6] a refused chain falls back to legacy VOICE_PITCH",
          f({"MARVEEN_VOICE_STYLE_AF": "volume=10", "VOICE_PITCH": "0.9"})
          == ["asetrate=22050*0.9,aresample=22050"])
    check("[7] the per-agent chain wins over VOICE_PITCH",
          f({"MARVEEN_VOICE_STYLE_AF": "atempo=1.05", "VOICE_PITCH": "0.9"}) == ["atempo=1.05"])

    if FAILS:
        print("FAILED: %s" % ", ".join(FAILS))
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    run()
