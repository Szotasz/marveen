#!/usr/bin/env python3
"""PreToolUse gate (matcher "REPL"): refuse Code Mode REPL code that names a
module loader, the network or the host process (CODEMODEFLAG1119).

WHY THIS EXISTS. In Claude Code's Code Mode the REPL tool runs JavaScript in a
sealed vm: require, import, fetch and process are not available there
(measured on a live probe, 2026-11-19: "import and require aren't available
here", typeof require is undefined). The model reaches the outside only
through the tool helpers, and every one of those calls goes through the fleet's
own PreToolUse gates as an ordinary tool call. If a later Claude Code version
opens the vm, that would happen silently: the same code would start to load
modules, open sockets or read the environment, with no gate in between. This
gate makes that change loud instead: code that NAMES one of these four is
refused before it runs, sealed vm or not.

THE WORD RULE. A REPL call is denied when tool_input.code contains require,
import, fetch or process as a WHOLE word: regex \\b on both sides, case
sensitive (JavaScript is; "Process the rows" in a comment passes).
  denied:  require(  import(  await import  import x from  import.meta
           fetch(  process.env  globalThis.process  globalThis['process']
           a comment or string that says the bare word (a false positive the
           message explains; reword it)
  allowed: processed  imported  prefetch  fetched  requirement  process_list
           importScripts (one identifier, a Worker global, not a Node loader)
KNOWN LIMITS, so a green run is not read as coverage: a name assembled at run
time (globalThis['pro' + 'cess']), an identifier escape (\\u0070rocess) or an
indirect eval is not seen. This is a tripwire for ordinary code reaching for
the host, not a sandbox: the sealing is Claude Code's, the gate only notices
when code asks for what the seal is meant to withhold.

FAIL CLOSED. Unparseable input, a non-object payload, a payload without a
string tool_name, or a REPL call whose
tool_input is not an object or has no string "code": deny (exit 2). Any
internal error: deny. A call that is not REPL is allowed (exit 0): the matcher
keeps other tools away, and this keeps a wider matcher from blocking them.
The settings entry runs this through the shared fail-closed wrapper
(pythonHookCommand), so a crash, a missing file or a timeout also blocks.
"""
import json
import re
import sys

FORBIDDEN = re.compile(r"\b(require|import|fetch|process)\b")

TAG = "CODEMODEFLAG1119"


def deny(reason):
    sys.stderr.write(
        "REPL kod TILTVA (%s, repl-code-gate): %s A Code Mode REPL-ben a require, import, fetch es process "
        "szo (onallo szokent, kommentben vagy szovegben is) nem szerepelhet: a kulvilagot a tool-segedeken "
        "at erd el (pl. $`...`, tools.<nev>(...)). Ha csak szovegben vagy kommentben irtad, fogalmazd at.\n"
        % (TAG, reason)
    )
    sys.exit(2)


def main():
    try:
        payload = json.loads(sys.stdin.read())
    except Exception:
        deny("a hook bemenete nem ertelmezheto JSON.")
    if not isinstance(payload, dict):
        deny("a hook bemenete nem JSON objektum.")
    tool_name = payload.get("tool_name")
    if not isinstance(tool_name, str):
        deny("a hook bemenetebol hianyzik a tool_name.")
    if tool_name != "REPL":
        sys.exit(0)
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        deny("a REPL hivas tool_input mezoje nem objektum.")
    code = tool_input.get("code")
    if not isinstance(code, str):
        deny("a REPL hivasnak nincs szoveges code mezoje.")
    found = sorted(set(FORBIDDEN.findall(code)))
    if found:
        deny("a kod tartalmazza: %s." % ", ".join(found))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # fail closed on anything unexpected
        deny("belso hiba a kapuban (%s)." % type(exc).__name__)
