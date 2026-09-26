#!/usr/bin/env python3
"""The mixed-script word rule, in ONE place for every path that blocks on it.

THE RULE: a word that mixes LATIN with another script is a finding. A word
written entirely in another script is NOT -- a Russian quote, a Greek symbol
and a Hungarian word are all legitimate text; a Hungarian word with a Cyrillic
`о` inside it is not, because it reads correctly and matches nothing.

WHY IT LIVES HERE (2026-09-24 review of #1541). Two paths block on this rule:
the outgoing-copy hook (#1509) and the inter-agent send gate (scripts/lib/
homoglyph.py, wired into scripts/agent-msg.sh). The second one shipped with a
rule of its own -- "any Cyrillic or Greek letter" -- and it refused two
legitimate texts that the first one passed: a plain Russian sentence and a
standalone Greek symbol. Two gates that disagree about what is legitimate are
worse than one gate: the sender learns that the rule depends on which script
they happened to call. So the rule is imported, not re-implemented, and the
test suite measures the two paths against one corpus.

NO AUTOMATIC REPLACEMENT lives here either, and that is deliberate (see the
header of src/homoglyph.ts): the look-alike maps by SHAPE, but the intended
word often needs a different letter -- Cyrillic ER looks like `p`, while the
word wanted `r`. The fix is written by someone who read the word.
"""
import re
import unicodedata

# Unicode-aware tokenisation: a latin-only \w+ would CUT a contaminated word
# into pieces at the homoglyph and then find each piece single-script, i.e. the
# tokenizer itself would hide exactly what is being looked for.
UWORD = re.compile(r"[^\W\d_]+", re.UNICODE)


# HOMOGLYPHMICRO924 (#1548, measured 2026-09-24). "Script" here is the FIRST
# WORD of the Unicode name, and for a few characters that word is the name of
# the sign, not a script. "40 µs" (MICRO SIGN), "100 m²" and "5 cm³"
# (SUPERSCRIPT TWO/THREE) and "H₂O" (SUBSCRIPT TWO) all blocked as mixed-script
# words, because a super/subscript digit is not \d, so UWORD takes it into the
# word. These are unit and formula notation; none of them disguises a latin
# letter (the MICRO SIGN's only confusable is the Greek mu).
#
# THE LIST IS DELIBERATELY EXPLICIT. "Every non-letter is neutral" would be too
# wide: ROMAN NUMERAL ONE (U+2160) is a non-letter and looks like a latin I,
# while KELVIN SIGN (U+212A) and ANGSTROM SIGN (U+212B) are letters that look
# like latin K and A. Those stay caught.
#
# IT LIVES HERE, NOT IN THE HOOK, for the same reason as the rule itself: #1548
# fixed this on the hook path only, so the inter-agent send gate still blocked
# "40 µs". One source, one answer, on every path.
SCRIPT_NEUTRAL = frozenset(
    ["\u00b5", "\u00b2", "\u00b3", "\u00b9", "\u2070"]
    + [chr(cp) for cp in range(0x2074, 0x207A)]  # superscript 4..9
    + [chr(cp) for cp in range(0x2080, 0x208A)]  # subscript 0..9
)


def char_script(ch: str) -> str:
    """First word of the Unicode name: LATIN, CYRILLIC, GREEK, ...

    NEUTRAL for the unit/formula characters above: they are neither a script
    to mix nor a letter to disguise."""
    if ch in SCRIPT_NEUTRAL:
        return "NEUTRAL"
    try:
        return unicodedata.name(ch).split(" ")[0]
    except ValueError:
        return "UNKNOWN"


# Back-compat alias: the hook used this private name before the extraction.
_char_script = char_script


def mixed_script_words(text: str):
    """Return [(word, bad_char, "NAME (U+XXXX)"), ...] for words mixing LATIN
    with any other script. Pure non-Latin words (foreign quotes) pass."""
    out = []
    for word in UWORD.findall(text):
        scripts = {char_script(ch) for ch in word} - {"NEUTRAL"}
        if "LATIN" in scripts and len(scripts) > 1:
            bad = next(ch for ch in word if char_script(ch) not in ("LATIN", "NEUTRAL"))
            try:
                bad_name = unicodedata.name(bad)
            except ValueError:
                bad_name = "UNKNOWN"
            out.append((word, bad, f"{bad_name} (U+{ord(bad):04X})"))
    return out
