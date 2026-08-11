#!/usr/bin/env python3
"""
Morning-brief draft via the LOCAL router -- the first real step wired through
fleet-helper->router (#132 P4a).

Reads the gathered raw material for the reggeli napindito on stdin (emails,
calendar, news -- whatever the run collected, as plain text) and asks the local
router for a compact Hungarian draft of the summary sections. The caller (the
napindito run itself) REVIEWS the draft before anything reaches Viktor: the
router output is never sent onward unread. That review step is what keeps this
within the #290 rule (Hungarian user-facing text locally only with review).

Refusal handling follows the local_router contract: a refusal is DATA. We exit
3 and print the refusal JSON; the napindito then composes the brief in-session
exactly as it did before this wiring existed. No retry loops here -- one
morning call a day is the measurement, not a delivery guarantee.

Exit codes: 0 = draft on stdout (JSON), 3 = router refused / unreachable
(refusal JSON on stdout), 2 = empty input.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "seed-skills", "fleet-helper", "scripts"))
from local_router import ask, is_ok  # noqa: E402

PROMPT = """Reggeli összefoglalót készítesz egy magyar nyelvű napindító üzenethez.
A nyers anyag lentebb: emailek, naptár-események, hírek vegyesen.

Feladat: tömörítsd szekciónként (ami üres, azt hagyd ki teljesen):
EMAIL: max 3 tétel, egy-egy sor (feladó: miről szól, kell-e reagálni)
NAPTÁR: a mai események időponttal
AI HÍREK: max 3 tétel, egy-egy mondat, felfújás nélkül

Csak a tényeket írd, ne találj ki semmit, ami nincs a nyers anyagban.
Magyarul válaszolj. Formázás nélkül, sima szöveg, szekciónként új sor.

NYERS ANYAG:
"""


def main():
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"ok": False, "refusal": "empty-input",
                          "detail": "no material on stdin"}))
        return 2
    # 2026-08-11 (Viktor, tg2815): magyar user-facing szoveg a gemma4-hez
    # tartozik, nem a qwen3-coderhez -- a "summary" osztaly qwen3-ra routolt,
    # es mindket eddigi draft-hiba (kitalalt feladok 08-10, "nem merheto ->
    # nincs esemeny" konverzio 08-11) azon szuletett. A "hungarian" osztaly a
    # routing-tabla szerint gemma4:31b-magyar; a review-kapu valtozatlanul
    # kotelezo, a #132 napi megfigyeles mostantol a gemma kimenetet meri.
    result = ask(PROMPT + raw, task_class="hungarian")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if is_ok(result) else 3


if __name__ == "__main__":
    sys.exit(main())
