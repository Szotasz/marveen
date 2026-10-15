#!/usr/bin/env python3
"""Warn about characters in a message that cannot be seen.

Reads stdin. Exit 0 when clean; exit 5 and a report on stderr when it finds
any; any other exit is the checker failing, not a verdict on the text.

THIS IS A WARNING, NOT A REFUSAL (c4e47223, decided 2026-09-30): the caller
sends the text either way. The mixed-script word -- a Cyrillic letter inside a
Latin word -- is a different class and is REFUSED by scripts/lib/homoglyph.py
before this runs; that gate is not changed here.

WHAT COUNTS. Every character a reader cannot see and a search does not match:
  - format characters (Unicode category Cf): zero-width space/joiners, the
    byte-order mark, the soft hyphen, the bidirectional controls;
  - space separators other than the ASCII space (Zs): no-break space, narrow
    no-break space, the typographic spaces;
  - the line and paragraph separators (Zl, Zp: U+2028, U+2029);
  - control characters (Cc) other than tab, newline and carriage return, so
    the C1 range (NEXT LINE, U+0085) too.
The categories are the rule, not a list of code points: a list is one new
character behind (the fleet's own sweeps missed U+2028/U+2029 that way).

ONE EXCEPTION: a ZERO WIDTH JOINER between two pictographic characters joins
an emoji sequence; that is what it is for, and it is not reported.

THE REPORT CARRIES CODE POINTS, NEVER THE MARK ITSELF: a report that quotes the
character is contaminated too, and becomes the next scan's hit.
"""
import sys
import unicodedata

MAX_LISTED = 10
CONTEXT = 12
VARIATION_SELECTORS = ("\ufe0e", "\ufe0f")


def _pictographic(ch):
    return ch is not None and unicodedata.category(ch) == "So"


def _neighbour(text, i, step):
    """The nearest character before (step=-1) or after (step=1) index i,
    skipping variation selectors, which sit between an emoji and its joiner."""
    j = i + step
    while 0 <= j < len(text) and text[j] in VARIATION_SELECTORS:
        j += step
    return text[j] if 0 <= j < len(text) else None


def is_hidden(text, i):
    ch = text[i]
    if ch in "\t\n\r":
        return False
    cat = unicodedata.category(ch)
    if cat == "Cc" or cat in ("Zl", "Zp"):
        return True
    if cat == "Zs":
        return ch != " "
    if cat == "Cf":
        if ch == "\u200d" and _pictographic(_neighbour(text, i, -1)) and _pictographic(_neighbour(text, i, 1)):
            return False
        return True
    return False


def _token(ch):
    return "<U+%04X>" % ord(ch)


def _visible(text, start, end, hidden_at):
    return "".join(_token(text[k]) if k in hidden_at else text[k] for k in range(start, end))


def find(text):
    """[(index, line, column), ...] for every hidden mark, 1-based line/column."""
    out = []
    line, col = 1, 0
    for i, ch in enumerate(text):
        col += 1
        if is_hidden(text, i):
            out.append((i, line, col))
        if ch == "\n":
            line, col = line + 1, 0
    return out


def main():
    text = sys.stdin.read()
    hits = find(text)
    if not hits:
        return 0
    hidden_at = {i for i, _, _ in hits}
    w = sys.stderr.write
    w("FIGYELEM: %d lathatatlan jel a szovegben (a kuldes MEGY, ez csak jelzes):\n" % len(hits))
    for i, line, col in hits[:MAX_LISTED]:
        name = unicodedata.name(text[i], "<nevtelen>")
        ctx = _visible(text, max(0, i - CONTEXT), min(len(text), i + CONTEXT + 1), hidden_at)
        ctx = ctx.replace("\n", "\\n")
        w("  %s %s -- %d. sor, %d. oszlop: ...%s...\n" % (_token(text[i]), name, line, col, ctx))
    if len(hits) > MAX_LISTED:
        w("  (+%d tovabbi)\n" % (len(hits) - MAX_LISTED))
    w("  Mit tegyel: ha nem szandekos, a kovetkezo szovegben ird ujra az erintett szot;\n"
      "  a jel olvasva nem latszik, de a keresest elrontja. A mar elkuldottet ez nem javitja.\n")
    return 5


if __name__ == "__main__":
    sys.exit(main())
