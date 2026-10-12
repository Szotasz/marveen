#!/usr/bin/env python3
"""Refuse text whose WORDS mix Latin with another script.

Reads stdin, writes it back to stdout if clean. Exit code 3 and a report on
stderr if not. THE VERDICT IS THE EXIT CODE, not the stdout: a caller must
send its own original text, never this script's output (see agent-msg.sh).

WHAT COUNTS, AND WHAT DOES NOT (rule shared with the outgoing-copy hook, see
scripts/lib/mixed_script.py). A Hungarian word with a Cyrillic `о` inside it is
refused: it reads correctly and matches nothing. A Russian sentence, a Greek
symbol in a measurement and a Hungarian word with accents all pass -- they are
legitimate text. THIS FILE USED TO REFUSE ALL THREE, because its rule was "any
Cyrillic or Greek letter", while the hook on the other path passed them. Two
gates disagreeing about what is legitimate teach the sender that the rule
depends on which script they happened to call (measured in the 2026-09-24
review of #1541).

NO AUTOMATIC REPLACEMENT, and this is a decision, not a missing feature. An
earlier version had a --tisztit switch with a look-alike table. The look-alike
maps by SHAPE, and the intended word often needs a different letter: Cyrillic
ER looks like `p`, but the word wanted `r`. The table also mixed shape-based
(р->p) with sound-based (в->v) mappings, so the "cleaned" text could be a
different word that still reads right. Blocking with a clear message, and
letting the person who knows what they meant rewrite the word, is the
behaviour we keep (same reasoning as the header of src/homoglyph.ts).

WHY THIS EXISTS. Measured 2026-09-22: one agent sent a report with three
Cyrillic letters inside a Hungarian word, warned the recipient in the next
message, and the recipient quoted the contaminated word straight back. The
letters cannot be seen, and they break every later search for that word.

WHY IT IS HERE AND NOT IN ONE AGENT'S TOOLBOX (MSGGATE924). Two agents had
built this guard for themselves, independently, because both had been bitten;
a third had no guard at all, and nothing in the fleet told them to. Meanwhile
the route every CLAUDE.md prescribes -- scripts/agent-msg.sh -- had none. A
protection everyone has to remember to reach for is not a protection.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mixed_script import char_script, mixed_script_words  # noqa: E402


def mask(word):
    """The word with every non-Latin letter replaced by `?`.

    A report that carries the contaminated form is itself contaminated: it
    becomes the next scan's hit, and whoever "fixes" the report deletes the
    evidence. Same masking as src/homoglyph.ts does for its context snippet.
    """
    return "".join("?" if char_script(c) not in ("LATIN", "UNKNOWN") else c
                   for c in word)


def main():
    t = sys.stdin.read()
    bad = mixed_script_words(t)
    if bad:
        for word, _ch, name in bad[:10]:
            sys.stderr.write(f"  {mask(word)}  <- {name}\n")
        if len(bad) > 10:
            sys.stderr.write(f"  ... and {len(bad) - 10} more\n")
        sys.stderr.write(
            f"NEM KULDOM EL: {len(bad)} vegyes irasrendszeru szo a szovegben.\n")
        # The word is NAMED above with the offending codepoint, and masked, so
        # this instruction can be followed without copying the broken form.
        sys.stderr.write(
            "  Mit tegyel: ird UJRA a fenti szo(ka)t, ne masold at a\n"
            "  szennyezett alakot. Automatikus csere nincs es nem is lesz:\n"
            "  az alakra illeszkedo betu nem feltetlenul a szandekolt szo.\n")
        return 3
    sys.stdout.write(t)
    return 0


if __name__ == "__main__":
    sys.exit(main())
