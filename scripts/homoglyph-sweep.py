#!/usr/bin/env python3
"""Run the homoglyph rule over FILES, over the message table and over the memory
table, not just over one outgoing message.

WHY THIS EXISTS. Two gates already apply the rule to inter-agent messages:
scripts/agent-msg.sh BLOCKS (rc=3, nothing sent), and POST /api/messages only
WARNS (the row is created and `homoglyph_warning` comes back in the 200). The
blocking one is the one an agent has to remember to call. Measured 2026-10-06:
of 1187 rows in agent_messages, 14 carry a mixed-script word, every one of them
dated AFTER both gates existed -- they went through the warn-only door, and the
warning field in the reply was never read. The same sweep over 2487 files found
a Cyrillic IE in seed-scheduled-tasks/kanban-audit/SKILL.md, a seed, i.e. the
copy every NEW agent install would have received.

So the rule was never the problem. Its REACH was: it ran on one path, on demand,
and the files a fresh session reads as state were never measured at all.

NOTHING HERE BLOCKS ANYTHING. It reports, and exits 3 if it found something, so
it can be wired into a hook later if the owner decides to. That decision is not
this script's to make.

Usage:
    python3 -I scripts/homoglyph-sweep.py [--files] [--messages] [--memories] [--quiet]
Default: all three. FLAGS ONLY -- a path argument is rejected with rc=2 (see main);
to check ONE file, pipe it into the canonical gate instead:
    python3 -I scripts/lib/homoglyph.py < FILE
"""
import os
import sqlite3
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts", "lib"))
from mixed_script import mixed_script_words  # noqa: E402

ROOTS = [BASE, os.path.expanduser("~/.claude")]

# Directories that hold no state anyone later greps: dependencies, build output,
# and the transcript/history stores Claude Code writes for itself.
SKIP_DIRS = {
    "node_modules", ".git", "dist", "vendor", "__pycache__", ".cache",
    "plugins-cache", "shell-snapshots", "statsig", "file-history",
    "projects", "todos", "history",
}

# DELIBERATELY CONTAMINATED, AND MUST STAY THAT WAY. These are the fixtures that
# prove the gates work; "fixing" a word here silently disarms the test that
# guards every other file. Each was read and confirmed intentional on 2026-10-06
# (every one carries a comment naming the Cyrillic letter on the spot).
INTENTIONAL = {
    "scripts/__tests__/outgoing-copy-gate.test.py",
    "scripts/__tests__/kartya-leiras-mozgatas.test.py",
    "src/__tests__/federation-address.test.ts",
    "src/__tests__/federation-classify.test.ts",
    # Added 2026-10-07: the fixture of the kanban-comment gate.
    # Line 72 carries a Latin word whose "u" is U+0443, and the comment above it
    # names the letter -- same shape as the four above. Without this line the
    # sweep reported one live hit on EVERY run, which is exactly the always-noisy
    # checker the SKIP_FILES note below calls a failure. Measured before and
    # after: 3001 files, 1 live hit -> 0.
    "src/__tests__/kanban-comment-homoglyph-warning.test.ts",
}

# NOT OURS TO EDIT, and both would fire on every run forever. A checker whose
# output is always non-empty gets ignored, which is how the real hit hides.
#   history.jsonl -- Claude Code's own append-only prompt store. We never write
#     it and never grep it; it is the RECORD of the contaminated messages below,
#     not a second problem. Confirmed 2026-10-06: its 6 hits are the same words
#     as rows 36/351/385/636/714 of agent_messages.
#   verifier_patterns.md -- a vendored upstream plugin. Its hits are Greek in
#     maths (pi-m, n-theta, Sigma-k): legitimate notation, and a FALSE POSITIVE
#     class of the rule, which flags any word mixing Latin with another script.
SKIP_FILES = {
    os.path.expanduser("~/.claude/history.jsonl"),
    os.path.expanduser(
        "~/.claude/plugins/marketplaces/claude-plugins-official/plugins/"
        "math-olympiad/skills/math-olympiad/references/verifier_patterns.md"),
}

# Backups and frozen round-snapshots. Real contamination lives in them, but they
# are history: nobody reads them as current state, and rewriting them would edit
# a record of what was actually written. Reported under --quiet=off as a count.
ARCHIVE_MARKS = (".bak", "/mentes/", "-archiv-")


def is_archive(path, name):
    return name.endswith("~") or any(m in path or m in name for m in ARCHIVE_MARKS)


def rel(path):
    return os.path.relpath(path, BASE) if path.startswith(BASE) else path


def sweep_files(quiet):
    hits, archive_hits, scanned = [], 0, 0
    for root_dir in ROOTS:
        for root, dirs, files in os.walk(root_dir):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for name in files:
                path = os.path.join(root, name)
                if rel(path) in INTENTIONAL or path in SKIP_FILES:
                    continue
                try:
                    if os.path.getsize(path) > 8 * 1024 * 1024:
                        continue
                    with open(path, encoding="utf-8") as fh:
                        text = fh.read()
                except (OSError, UnicodeDecodeError):
                    continue
                scanned += 1
                bad = mixed_script_words(text)
                if not bad:
                    continue
                if is_archive(path, name):
                    archive_hits += 1
                    continue
                lines = text.split("\n")
                seen = set()
                for word, _ch, charname in bad:
                    if word in seen:
                        continue
                    seen.add(word)
                    lineno = next((i for i, l in enumerate(lines, 1) if word in l), 0)
                    hits.append((rel(path), lineno, word, charname))
    if not quiet:
        print(f"FAJLOK: {scanned} atvizsgalva, {len(hits)} elo talalat, "
              f"{archive_hits} archiv fajlban (nem jelentve, lasd ARCHIVE_MARKS)")
    for path, lineno, word, charname in hits:
        print(f"HIT {path}:{lineno}  szo={word!r}  karakter={charname}")
    return len(hits), scanned


def sweep_messages(quiet):
    db = os.path.join(BASE, "store", "claudeclaw.db")
    if not os.path.exists(db):
        print(f"UZENETEK: {db} nincs meg -- NEM MERES", file=sys.stderr)
        return 0, 0
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    # MINDKET szoveges oszlop. A `result` 2026-10-09-ig NEM volt benne, es ez
    # nem kozombos reszlet: a lezaro `PUT /api/messages/<id>` payloadja az az
    # EGY ut, amit az agensek inline `--data-binary '{"result":"..."}'` alakban
    # irnak, tehat sosem megy at fajl-alapu ellenorzesen. A kapu hat uton futott,
    # a hetediken nem -- es a sweep, ami ezt megmerte volna, ugyanabba az
    # oszlopba nem nezett bele. A fenti docstring 14 szennyezett sora ezert
    # CONTENT-only meres. A result-ra az elso meres (2026-10-09, 2179 sor / 403
    # nem-ures result) 1 talalatot adott.
    rows = list(con.execute(
        "SELECT id, from_agent, to_agent, created_at, content, result "
        "FROM agent_messages"))
    hits = []
    for mid, frm, to, _ts, content, result in rows:
        for col, text in (("content", content), ("result", result)):
            if not text:
                continue
            bad = mixed_script_words(text)
            if bad:
                hits.append((mid, frm, to, col, sorted({w for w, _, _ in bad})))
    if not quiet:
        print(f"UZENETEK: {len(rows)} sor (content+result), {len(hits)} szennyezett mezo")
    for mid, frm, to, col, words in hits:
        print(f"MSG id={mid} {frm} -> {to}  mezo={col}  szavak={words}")
    return len(hits), len(rows)


# Memory rows that are contaminated ON PURPOSE and must stay that way, exactly
# like INTENTIONAL above: 1075 is the live probe that proved the keywords gate
# fires (2026-10-09), and its own content says so. Without this
# set the sweep would report one hit on every run -- the always-noisy checker
# this file's SKIP_FILES note calls a failure.
INTENTIONAL_MEMORIES = {1075}


def scan_memory_rows(rows, intentional=INTENTIONAL_MEMORIES):
    """Pure row scanner for the memories table, so the contract is testable
    without a live database.

    rows: iterable of (id, agent_id, category, content, keywords).

    BOTH columns, and the second one is the reason this exists. In `content` a
    Cyrillic lookalike is cosmetic: the sentence still reads, and this sweep
    would find it. In `keywords` it is functional -- that column is the search
    surface, so the corrupted word removes the one query path that led through
    it while every other keyword on the row keeps matching. The loss reads as
    "no such memory", and nothing anywhere says otherwise.
    """
    hits = []
    for mid, agent, category, content, keywords in rows:
        if mid in intentional:
            continue
        for col, text in (("content", content), ("keywords", keywords)):
            if not text:
                continue
            bad = mixed_script_words(text)
            if bad:
                hits.append((mid, agent, category, col, sorted({w for w, _, _ in bad})))
    return hits


def sweep_memories(quiet):
    """The memories table was not swept at all until 2026-10-09.

    The write-time gate on POST /api/memories read `content` and nothing else,
    so a Cyrillic letter could enter `keywords` with a plain 200 and no warning
    (fixed alongside). Measured that day on one memory row: a strict search for
    the clean spelling missed the row, while a clean co-keyword from the same
    row returned it -- the row was indexed and reachable, only the path through
    the corrupted word was gone. Rows written BEFORE that fix carry the same
    silence, and no sweep looked at this table, so nothing would ever find them.
    """
    db = os.path.join(BASE, "store", "claudeclaw.db")
    if not os.path.exists(db):
        print(f"EMLEKEK: {db} nincs meg -- NEM MERES", file=sys.stderr)
        return 0, 0
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = list(con.execute(
        "SELECT id, agent_id, category, content, keywords FROM memories"))
    hits = scan_memory_rows(rows)
    if not quiet:
        print(f"EMLEKEK: {len(rows)} sor (content+keywords), "
              f"{len(hits)} szennyezett mezo")
    for mid, agent, category, col, words in hits:
        print(f"MEM id={mid} {agent}/{category}  mezo={col}  szavak={words}")
    return len(hits), len(rows)


KNOWN_FLAGS = {"--files", "--messages", "--memories", "--quiet"}


def main():
    args = set(sys.argv[1:])

    # This script takes FLAGS, never paths. Measured 2026-10-07 by the support
    # agent, on its own round: `sweep <file>` ran NOTHING and exited 0, because
    # a positional argument made `args - {"--quiet"}` non-empty, so both
    # `do_files` and `do_msgs` fell to False. The caller had reported "gate ran,
    # exit 0" on a sweep that never looked at anything -- the false-zero class,
    # on the calling side this time. An unknown argument must therefore FAIL
    # loudly (rc=2) rather than scan nothing and look clean. rc 0 and 3 stay
    # reserved for clean / found.
    unknown = sorted(args - KNOWN_FLAGS)
    if unknown:
        print(f"homoglyph-sweep: ismeretlen argumentum: {' '.join(unknown)}",
              file=sys.stderr)
        print(f"ez a szkript FLAGEKET var, nem fajl-utakat: "
              f"{' '.join(sorted(KNOWN_FLAGS))} (alapertelmezes: mindketto)",
              file=sys.stderr)
        print("egy fajl ellenorzesere: python3 -I scripts/lib/homoglyph.py < FAJL",
              file=sys.stderr)
        return 2

    quiet = "--quiet" in args
    explicit = args - {"--quiet"}
    do_files = "--files" in args or not explicit
    do_msgs = "--messages" in args or not explicit
    do_mems = "--memories" in args or not explicit

    # A NULLA TALALAT ES A NULLA MERES KET KULONBOZO ALLAPOT, ES EDDIG UGYANAZ A
    # KILEPESI KOD JELOLTE MINDKETTOT (javitva 2026-10-09 06:4x). A hianyzo DB-nel
    # a sweep stderr-re irt egy sort es 0-val lepett ki -- vagyis "tiszta"-t mondott
    # egy futasra, ami SEMMIT nem nezett meg. Megmerve eldobhato masolaton, ures
    # repoban: `--messages` -> EXIT 0. Egy `sweep && echo KAPU OK` hivo ezt sikernek
    # olvassa. Ugyanaz a csalad, mint a 2026-10-07-es pozicionalis-argumentum eset
    # fent, csak ott a HIVAS nem futott le, itt a MERES nem talalt forrast.
    # Az alakot a support-agens eles esete elesitette (2026-10-09 06:3x): egy lejart
    # OAuth token miatt a watchlist-osszevetes ZOLD eredmenyt adott nulla mert
    # ticketbol. A javitas az ové: kulon kilepesi kod a NEM MERES allapotra, hogy a
    # hivo meg tudja kulonboztetni a harom esetet, es a LEFEDETTSEG mindig latszodjon.
    #   0 = tiszta, ES tenylegesen mertunk valamit
    #   2 = rossz argumentum
    #   3 = talalat
    #   4 = NEM MERES: a kert sweep egyetlen forrast sem nezett meg
    found = 0
    vizsgalt = 0
    futott = []
    if do_files:
        f, n = sweep_files(quiet)
        found += f; vizsgalt += n; futott.append(f"fajl={n}")
    if do_msgs:
        f, n = sweep_messages(quiet)
        found += f; vizsgalt += n; futott.append(f"uzenet-sor={n}")
    if do_mems:
        f, n = sweep_memories(quiet)
        found += f; vizsgalt += n; futott.append(f"emlek-sor={n}")
    if not quiet:
        print(f"LEFEDETTSEG: {', '.join(futott)}")
    if vizsgalt == 0:
        print("NEM MERES: a kert sweep egyetlen forrast sem nezett meg. "
              "Tipikus ok: hianyzo store/claudeclaw.db, vagy nem letezo gyoker. "
              "EZ NEM TISZTA EREDMENY.", file=sys.stderr)
        return 4
    return 3 if found else 0


if __name__ == "__main__":
    sys.exit(main())
