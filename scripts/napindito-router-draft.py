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


#: The model the `hungarian` class is supposed to reach. Kept here, next to the
#: caller, on purpose: this is the model the REVIEWER is expecting to have
#: reviewed. The routing table decides where the request goes; this constant
#: only decides when to speak up about the answer coming from somewhere else.
INTENDED_MODEL = "gemma4:31b-magyar"


def degradation_note(result):
    """One line of Hungarian if the draft came from anything but the intended model.

    Returns None when there is nothing to say. A refusal returns None too --
    the caller already handles refusals as data and composes in-session.

    The 2026-08-12 case this guards: air903max went away overnight, the request
    fell back, and a perfectly successful response from qwen3:14b was
    indistinguishable from a correct one.
    """
    if not result.get("ok"):
        return None
    model = result.get("model")
    if model == INTENDED_MODEL:
        return None
    host = result.get("host") or "ismeretlen hoszt"
    if not model:
        return (
            "FIGYELEM: a router nem mondta meg, melyik modell keszitette a draftot "
            f"(hoszt: {host}). Ne feltetelezd, hogy a {INTENDED_MODEL} volt."
        )
    return (
        f"FIGYELEM: a draftot NEM a {INTENDED_MODEL} keszitette, hanem a {model} "
        f"({host}). A magyar szoveg minosege ezen a uton gyengebb lehet -- "
        "olvasd at szigorubban, es nezd meg, miert nem a fo modell szolgalt ki."
    )


def annotate(result):
    """The result the caller prints, with the deviation made loud."""
    note = degradation_note(result)
    if note is None:
        return result
    # Copied rather than mutated: the caller may want the raw router answer.
    return {**result, "degraded": True, "degraded_note": note}


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
    # 2026-08-12 (#335): host/model were already in the answer and were still
    # missed, because a successful call looks the same whichever model served
    # it. The deviation now announces itself in the printed result AND on
    # stderr, so a run that only reads the log still sees it.
    annotated = annotate(result)
    if annotated.get("degraded"):
        print(annotated["degraded_note"], file=sys.stderr)
    print(json.dumps(annotated, ensure_ascii=False, indent=2))
    return 0 if is_ok(result) else 3


if __name__ == "__main__":
    sys.exit(main())
