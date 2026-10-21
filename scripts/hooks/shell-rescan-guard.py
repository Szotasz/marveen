#!/usr/bin/env python3
"""PreToolUse gate: refuse a Bash command whose own TEXT will be re-scanned by
the shell, because that is how prose becomes an executed command.

WHY THIS EXISTS. Prose pasted into a command -- a message body, a commit text, a
comment -- is scanned by the shell before any program sees it. A backtick in a
double-quoted string runs whatever is between the backticks and puts the OUTPUT in
the text: one such message body ran `git reset --hard origin/main` in a shared
checkout and destroyed uncommitted work. A written rule against it ("do not put
data in double quotes") did not hold. A rule is not a control until something
mechanical enforces it.

WHAT IT REFUSES (detector: shell_rescan_lib):
  E  a backtick inside a double-quoted string   -- always command substitution
  A  $( ) inside an inline interpreter payload  -- python3 -c "..." and friends
  B  an UNQUOTED heredoc whose body has ` or $( )
  C  eval
  D  ${v@P} and friends
The remedy is never "quote harder": keep the data OUT of the command text. Put it
in a quoted heredoc (<<'EOF') and let the program read the file, or pass it as an
argument, or on stdin.

MEASURED before shipping, on about 106 000 real Bash commands from one install's
agent transcripts: 0.21% would be refused. Two earlier detector versions scored
7.57% and 4.12%; both were instrument errors (scanning inert heredoc bodies as
syntax, and a flat scan of $( ) reading a nested quote as the closing one).

DELIBERATE ESCAPE, because a gate with no escape gets switched off: put
`# rescan-ok: <why>` in a COMMENT and the command passes, and the decision is
logged with that reason. This does not stop a determined caller and is not meant to.

SAFETY. Any internal error -> allow (exit 0): this gate must never be able to
wedge an agent. MAX_BLOCKS identical refusals for the same command, then it lets
it through ONCE and forgets the key, so a disagreement cannot trap a session in a
loop and a backstopped command does not become permanently exempt. State is per
session, BEST-EFFORT lock-serialised (an untakeable lock is skipped, never waited
on) and written by atomic replace; the counter survives a malformed line, because a
state read that silently returned 0 would disable the backstop and turn a refusal
into a permanent one.

FILES: the decision log (shell-rescan-guard.log) and the per-session state
(shell-rescan-state.d) live in the install's store directory;
SHELL_RESCAN_GUARD_LOG and SHELL_RESCAN_GUARD_STATE_DIR override them.

KNOWN LIMITS, so a green run is never mistaken for coverage:
  - If the state cannot be written at all, the gate stops enforcing rather than
    refuse forever: no backstop, no enforcement. That is deliberate.
  - A single-quoted payload to a SHELL (`bash -c '...'`, and the clustered form
    `bash -lc '...'`) is not inspected, even though the inner shell re-scans it.
    Measured: 0.16% of the same real commands are exactly that shape as ordinary
    work. An accepted blind spot, not an oversight.
  - It sees only the Bash tool -- a script already on disk, an MCP server or an
    agent's own subprocess is uncovered; and a construct outside those five rules
    passes unchecked, which is a FALSE GREEN, not proof the command was safe.
  - Per-session state files are not pruned; each holds at most 200 keys.
"""
import sys
import os
import json
import hashlib
import time
import fcntl

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))

MAX_BLOCKS = 3
STATE_DIR = os.environ.get("SHELL_RESCAN_GUARD_STATE_DIR") or os.path.join(REPO_ROOT, "store", "shell-rescan-state.d")
STATE = None          # set per session in main(); see _state_path
LOG = os.environ.get("SHELL_RESCAN_GUARD_LOG") or os.path.join(REPO_ROOT, "store", "shell-rescan-guard.log")

REMEDY = {
    "E_BACKTICK_IN_DQ": (
        "backtick egy DUPLA idezojeles szovegben (vagy egy $(( )) aritmetikai kifejezesben) "
        "-- ez MINDIG parancs-behelyettesites, a shell lefuttatja es a KIMENETET teszi "
        "a szoveg helyere"),
    "A_INLINE_INTERP_DQ": (
        "$( ) az inline interpreter dupla idezojeles payloadjaban -- a shell futtatja, "
        "mielott a python/node egyaltalan latna"),
    "B_UNQUOTED_HEREDOC": (
        "IDEZoJELEZETLEN heredoc, a torzsben ` vagy $( ) -- a shell kifejti a torzset"),
    "C_EVAL": "eval -- az argumentum definicio szerint ujra forraskent ertelmezodik",
    "D_PROMPT_EXPAND": "${v@P} -- kifejtes a valtozo ERTEKERE alkalmazva",
}


def _state_path(session_id):
    """One state file per session. The backstop exists to stop THIS session from
    being trapped, so a shared file bought nothing and cost a write race: two
    agents blocked at the same moment each read-modify-wrote the same file and
    one update was lost."""
    # A non-string session_id would otherwise end in a traceback (exit 1), and in
    # PreToolUse anything but exit 2 ALLOWS. Hash it instead of collapsing every
    # odd id into the shared "nosession" bucket: the backstop counts per command
    # inside one state file, so two sessions forced into one bucket would share
    # each other's counters. None keeps the "nosession" default.
    if not isinstance(session_id, str):
        session_id = "" if session_id is None else hashlib.sha256(
            repr(session_id).encode("utf-8")).hexdigest()[:32]
    safe = "".join(ch for ch in (session_id or "nosession") if ch.isalnum() or ch in "-_")[:64]
    return os.path.join(STATE_DIR, safe or "nosession")


def _log(rec):
    """One line, one write. A buffered append from two processes can interleave
    mid-line and produce invalid JSON; O_APPEND with a single write cannot."""
    try:
        line = (json.dumps(rec, ensure_ascii=False) + "\n").encode("utf-8", "replace")
        fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, line)
        finally:
            os.close(fd)
    except Exception:
        pass


class _Lock(object):
    """BEST-EFFORT serialisation of the read-modify-write. If the lock cannot be
    taken it proceeds UNLOCKED and the worst case is a miscounted backstop --
    never a wait. Per-session state removed the CROSS-agent race; this removes the
    same-session one when it can (hence "best-effort", not "serialised")."""

    def __init__(self, path):
        self.path, self.fh = path + ".lock", None

    def __enter__(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            self.fh = open(self.path, "a+")
            # NON-BLOCKING, and this is the whole point. A plain LOCK_EX waits
            # forever if any process holding the lock is stopped or wedged, and
            # this runs synchronously before EVERY Bash command -- so a blocking
            # lock here hangs the agent, permanently, with no error. Losing the
            # lock costs at most one miscounted backstop; a blocking one can
            # hang the agent. (A try/except alone does not prevent that: a hang
            # is not an exception.)
            fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            if self.fh is not None:
                try:
                    self.fh.close()
                except Exception:
                    pass
            self.fh = None                     # proceed unlocked rather than wait
        return self

    def __exit__(self, *exc):
        if self.fh is not None:
            try:
                fcntl.flock(self.fh, fcntl.LOCK_UN)
            except Exception:
                pass                           # closing the file releases it anyway
            finally:
                try:
                    self.fh.close()
                except Exception:
                    pass
        return False


def _count(key):
    """A malformed line must not hide the rest of the file. The old version let
    one bad line abort the whole read and return 0 for every key, which silently
    disabled the backstop -- the gate would then refuse the same command forever."""
    n = 0
    try:
        with open(STATE, encoding="utf-8") as fh:
            for line in fh:
                try:
                    k, v = line.strip().split(" ", 1)
                    if k == key:
                        n = int(v)
                except Exception:
                    continue
    except Exception:
        pass
    return n


def _record(key, n):
    """Atomic replace, so a concurrent reader never sees a truncated file.
    Returns True only if the state actually reached disk -- the caller needs to
    know, because a silently failed write means the backstop can never fire."""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        rows = {}
        try:
            with open(STATE, encoding="utf-8") as fh:
                for line in fh:
                    parts = line.strip().split(" ", 1)
                    if len(parts) == 2:
                        rows[parts[0]] = parts[1]
        except Exception:
            pass
        # Pop then re-add: an updated key moves to the END, so the cut below drops
        # the keys that have gone quiet longest, never one that is being retried.
        rows.pop(key, None)
        if n is not None:
            rows[key] = str(n)
        items = list(rows.items())[-200:]
        tmp = STATE + ".tmp" + str(os.getpid())
        with open(tmp, "w", encoding="utf-8") as fh:
            for k, v in items:
                fh.write(k + " " + v + "\n")
        os.replace(tmp, STATE)
        return True
    except Exception:
        return False


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    # A malformed payload must not crash the hook: an uncaught exception exits 1,
    # and in PreToolUse anything that is not 2 ALLOWS the call, so a crash would
    # silently disarm the gate. Fail open deliberately (exit 0), never by traceback.
    if not isinstance(payload, dict):
        sys.exit(0)

    global STATE
    STATE = _state_path(payload.get("session_id"))

    if payload.get("tool_name") != "Bash":
        sys.exit(0)
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        sys.exit(0)
    cmd = tool_input.get("command")
    if not isinstance(cmd, str) or not cmd:
        sys.exit(0)

    try:
        import shell_rescan_lib
        # The marker only counts inside a real shell COMMENT. Accepting it
        # anywhere in the text meant a command whose quoted DATA contained the
        # string disarmed the gate for itself -- and prose in quoted data is
        # exactly what this gate is here to police.
        escape = [c for c in shell_rescan_lib.comments(cmd) if "rescan-ok:" in c]
        if escape:
            _log({"t": time.time(), "decision": "allow-escape",
                  "reason": escape[0].split("rescan-ok:", 1)[1].strip()[:400], "cmd": cmd[:400]})
            sys.exit(0)
        found = shell_rescan_lib.findings(cmd)
    except Exception as exc:                      # fail-open, always
        _log({"t": time.time(), "decision": "error", "err": repr(exc)})
        sys.exit(0)

    if not found:
        sys.exit(0)

    rules = []
    for r, _d in found:
        if r not in rules:
            rules.append(r)

    # surrogatepass: a lone surrogate in the command (valid JSON, not valid UTF-8)
    # would otherwise raise here, exit 1, and in PreToolUse that ALLOWS.
    key = hashlib.sha256(cmd.encode("utf-8", "surrogatepass")).hexdigest()
    with _Lock(STATE):
        n = _count(key)
        stored = _record(key, None if n >= MAX_BLOCKS else n + 1)
    if not stored:
        # WITHOUT STATE THERE IS NO BACKSTOP, AND A GATE WITHOUT A BACKSTOP CAN
        # REFUSE THE SAME COMMAND FOREVER. A read-only directory or a full disk
        # would otherwise turn every refusal permanent -- failing CLOSED, which
        # is the one thing this gate must never do. So: no state, no enforcement.
        _log({"t": time.time(), "decision": "state-unavailable-allow",
              "rules": rules, "cmd": cmd[:400]})
        sys.exit(0)
    if n >= MAX_BLOCKS:
        # Let it through, then FORGET the key (done above, under the lock).
        # Leaving it at MAX_BLOCKS turned the backstop into a permanent allow-list
        # for that command: the next identical call passed unexamined.
        _log({"t": time.time(), "decision": "backstop-allow", "rules": rules, "cmd": cmd[:400]})
        sys.exit(0)
    _log({"t": time.time(), "decision": "deny", "rules": rules, "cmd": cmd[:400]})

    lines = ["⛔SHELL-UJRASCANNELES: a parancs SZOVEGE futna le, nem csak az adat."]
    for r in rules:
        lines.append("  - " + r + ": " + REMEDY.get(r, r))
    lines.append("")
    lines.append("Ez az osztaly mar okozott adatvesztest: egy uzenettorzsben maradt backtick "
                 "`git reset --hard`-ot futtatott egy kozos checkoutban.")
    lines.append("A GYOGYIR NEM az, hogy jobban idezojelezel, hanem hogy az adat KIKERUL "
                 "a parancs szovegebol:")
    lines.append("  - idezojelezett heredoc fajlba (<<'VEGE'), es a program a FAJLT olvassa;")
    lines.append("  - vagy argumentumkent / stdin-en add at;")
    lines.append("  - markdown backtick helyett a szovegben hasznalj mas jelolest.")
    lines.append("Ha SZANDEKOS es tudod mit teszel: tedd bele a parancsba, hogy "
                 "'# rescan-ok: <indok>' -- atengedi, es naplozza az indokot.")
    lines.append("")
    lines.append("⛔AMIRE EZ A KAPU NEM SZOL, ES AMI UGYANILYEN VESZELYES: ha az adatot "
                 "elobb VALTOZOBA teszed, majd inline interpreterbe adod -- pl. "
                 "python3 -c \"print('$V')\" -- az ATMEGY, pedig ugyanaz a masodik-scan "
                 "osztaly. Ha a valtozo erteke KIVULROL jon (fajlnev, uzenet-torzse, "
                 "kommentbol vett szoveg), es aposztrofot vagy sortorest tartalmaz, "
                 "kitor a stringbol es KODDA valik. A csendem NEM jelenti, hogy biztonsagos.")
    reason = "\n".join(lines)

    # Bytes, not print(): the reason carries non-ASCII markers, and under an ASCII
    # stdout encoding print() raises UnicodeEncodeError -- the hook would exit 1,
    # which in PreToolUse ALLOWS. Measured with PYTHONIOENCODING=ascii: rc=1, no
    # output. Writing UTF-8 bytes takes the ambient encoding out of the path.
    doc = json.dumps({
        "decision": "block",
        "reason": reason,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        },
    }, ensure_ascii=False)
    try:
        sys.stdout.buffer.write(doc.encode("utf-8") + b"\n")
        sys.stdout.buffer.flush()
    except Exception:
        # DECIDE FIRST, SPEAK AFTER. The block is already decided; if the JSON
        # channel is gone (closed pipe, full disk, an encoding we cannot write),
        # exiting 0 here would silently overturn it. Fall back to the other
        # protocol the harness honours: exit 2 = block. The refusal then arrives
        # without its explanation -- worse for the reader, correct for the gate.
        try:
            sys.stderr.write("shell-rescan-guard: BLOCKED (the explanation could not be written)\n")
            sys.stderr.flush()
        except Exception:
            pass
        # os._exit, not sys.exit(2): the interpreter still flushes stdout at
        # shutdown, that flush raises on the broken pipe, and CPython then exits
        # with 120 -- which, not being 2, ALLOWS. Measured: closed stdout -> the
        # stderr line printed and rc=120. os._exit skips the shutdown flush.
        os._exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
