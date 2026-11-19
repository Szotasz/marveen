#!/usr/bin/env python3
"""PreToolUse gate (matcher "REPL"): allow Code Mode's REPL tool only on a
Claude Code version whose REPL seal was measured (CODEMODEFLAG1119).

WHY THIS EXISTS. In Claude Code's Code Mode the REPL tool runs JavaScript in a
sealed vm. Measured on live probes, 2026-11-19 (card CODEMODEFLAG1119,
comment 33384, Claude Code 2.1.326): code that uses require or import is
refused by Claude Code as a whole block before any of it runs ("Nothing ran:
import and require aren't available here"); fetch and process are undefined.
typeof require is NOT a proof of the seal: on Marveen's run it returned
"function", a decoy, while a call through it still did not run. The model
reaches the outside only through the tool helpers, and each of those calls
passes the fleet's own PreToolUse gates as an ordinary tool call.

That seal is Claude Code's, not ours, and a later version can change it with
nothing saying so. So this gate is a VERSION CANARY: a REPL call is allowed
only when the running session's Claude Code version is in MEASURED_VERSIONS.
On any other version every REPL call is denied until someone re-runs the seal
measurement on it and adds it to the set in a PR. Other tools are untouched.

THE LIMIT, so a green run is not read as coverage: this gate trusts the
measurement of the pinned version. It does not inspect the code (an earlier
word check did; it denied everyday developer work such as editing an import
line or writing a TS file, Dani's review of #2906), and it cannot tell
whether the pinned version's seal still holds in a configuration the
measurement did not cover. It reads the running version from the session's
own transcript, which the agent can also write, so it is a tripwire for a
silently changing seal, NOT a defence against a deliberate bypass.

VERSION SOURCE. The hook payload carries transcript_path; every message row
Claude Code writes there carries "version" (measured on Dani's probe
transcript), but bookkeeping rows (mode, last-prompt, ai-title,
api-request-blob, file-history-snapshot, ...) do not, and one versionless run
reached 1.27 MB in a fleet transcript (205 KB in ordinary sessions). The gate
reads the file BACKWARDS in 64 KB chunks, up to TAIL_CAP bytes (never the
whole file), and takes the version of the last complete row that has one. The
user prompt row is written before the first tool call of a turn (Dani's
probe: the prompt row 3.4 s before the first REPL tool_use row), so a fresh
session's first REPL call already finds a version.

FAIL CLOSED, two distinct reasons with different fixes:
  READ ERROR: unparseable input, no string tool_name, no transcript_path, a
    transcript that cannot be read, no version row within TAIL_CAP, or a
    version value that is not a dotted number. The version could not be
    determined; this is not a version mismatch.
  VERSION NOT MEASURED: a well-formed version outside MEASURED_VERSIONS. The
    message names the running version and the measured set.
Any internal error denies. A call that is not REPL is allowed (exit 0): the
matcher keeps other tools away, and this keeps a wider matcher from blocking
them. The settings entry runs this through the shared fail-closed wrapper
(pythonHookCommand), so a crash, a missing file or a timeout also blocks.
"""
import json
import os
import re
import sys

# The seal measurement: card CODEMODEFLAG1119, comment 33384, 2026-11-19 (Dani's
# probe A block). Add a version here only after re-running that measurement on it.
MEASURED_VERSIONS = {"2.1.326"}

TAG = "CODEMODEFLAG1119"
CHUNK = 64 * 1024
TAIL_CAP = 4 * 1024 * 1024
VERSION_SHAPE = re.compile(r"\A[0-9]+\.[0-9]+\.[0-9]+\Z")


class ReadError(Exception):
    pass


def deny_read(reason):
    sys.stderr.write(
        "REPL TILTVA (%s, repl-code-gate): OLVASASI HIBA, nem verzio-elteres: %s A kapu nem tudta "
        "megallapitani a futo Claude Code verziojat, ezert zar. Teendo: nezd meg, hogy a hook bemenete "
        "hordoz-e transcript_path-t, es hogy a fajl olvashato-e es van-e benne \"version\" mezos sor.\n"
        % (TAG, reason)
    )
    sys.exit(2)


def deny_version(running):
    sys.stderr.write(
        "REPL TILTVA (%s, repl-code-gate): a futo Claude Code verzio %s, a REPL zarasa csak ezeken van "
        "merve: %s. Teendo: futtasd ujra a Code Mode zar-merest ezen a verzion (Dani A-proba blokkja, "
        "%s kartya, 33384-es komment), es PR-ben vedd fel a verziot a repl-code-gate.py "
        "MEASURED_VERSIONS halmazaba. Addig Code Mode-ban ez az ugynok nem tud dolgozni (a REPL es a Poll "
        "az egyetlen eszkoze): jelezd a vezetodnek, vagy kapcsoljak ki rajta a Code Mode-ot.\n"
        % (TAG, running, ", ".join(sorted(MEASURED_VERSIONS)), TAG)
    )
    sys.exit(2)


def last_version(path):
    """Version of the last complete transcript row that has one, read backwards
    in CHUNK steps up to TAIL_CAP bytes. Raises ReadError."""
    try:
        f = open(path, "rb")
    except OSError as exc:
        raise ReadError("a transcript nem nyithato meg (%s)." % type(exc).__name__)
    with f:
        try:
            pos = f.seek(0, os.SEEK_END)
        except OSError as exc:
            raise ReadError("a transcript nem olvashato (%s)." % type(exc).__name__)
        carry = b""
        read = 0
        while pos > 0 and read < TAIL_CAP:
            step = min(CHUNK, pos, TAIL_CAP - read)
            pos -= step
            read += step
            try:
                f.seek(pos)
                chunk = f.read(step)
            except OSError as exc:
                raise ReadError("a transcript nem olvashato (%s)." % type(exc).__name__)
            lines = (chunk + carry).split(b"\n")
            # the first piece may be the tail of a row that starts before pos
            carry = lines.pop(0) if pos > 0 else b""
            for line in reversed(lines):
                if b'"version"' not in line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue  # a half-written last row, or not JSON: no evidence either way
                if not isinstance(row, dict) or "version" not in row:
                    continue
                value = row["version"]
                if not isinstance(value, str) or not VERSION_SHAPE.match(value):
                    raise ReadError("hibas verzio-ertek a transcriptben: %s." % repr(value)[:40])
                return value
    raise ReadError("a transcript utolso %d bajtjaban nincs \"version\" mezos sor." % min(read, TAIL_CAP))


def main():
    try:
        payload = json.loads(sys.stdin.read())
    except Exception:
        deny_read("a hook bemenete nem ertelmezheto JSON.")
    if not isinstance(payload, dict):
        deny_read("a hook bemenete nem JSON objektum.")
    tool_name = payload.get("tool_name")
    if not isinstance(tool_name, str):
        deny_read("a hook bemenetebol hianyzik a tool_name.")
    if tool_name != "REPL":
        sys.exit(0)
    path = payload.get("transcript_path")
    if not isinstance(path, str) or not path:
        deny_read("a hook bemenetebol hianyzik a transcript_path.")
    try:
        running = last_version(path)
    except ReadError as exc:
        deny_read(str(exc))
    if running not in MEASURED_VERSIONS:
        deny_version(running)
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # fail closed on anything unexpected
        deny_read("belso hiba a kapuban (%s)." % type(exc).__name__)
