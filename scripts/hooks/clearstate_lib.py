"""Shared helpers for the /clear continuity record.

The /clear path used to be unprotected at BOTH ends: nothing wrote state before
the wipe (a /clear does NOT fire PreCompact, so the PreCompact agent-hook that
saves the task-state never runs), and nothing read state after it (the
SessionStart replay hooks were wired to compact|resume only). A session cleared
in a sub-agent's window therefore vanished without a trace -- including on the
context-restart gate's OWN path, which sends /clear deliberately and then tells
the fresh session to "read the restored blocks".

This module backs the two hooks that close that gap:
  clear-capture.py  SessionEnd(reason=clear) -> write the record
  clear-replay.py   SessionStart(source=clear) -> inject it, then drop it

Deterministic by construction: the record is extracted from the session
transcript with plain parsing (no model, no dashboard, no network), the same
way the conversation ledger works. Pure stdlib.

Records are returned as DICTS, never tuples: a widened return value can then
never break a caller's unpack (HOOKARITAS821).
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402  (main_agent_id / owner_name resolution)

# How many of the owner's most recent prompts to carry across the clear. The
# continuity failure mode is not a too-short window -- it is having nothing at
# all -- so a handful of turns plus the transcript pointer is enough.
MAX_PROMPTS = 5

# Per-prompt char cap. One runaway paste must not dominate the injected block.
MAX_PROMPT_CHARS = 400

# Char cap for the agent's own last message (what it was doing when cleared).
MAX_REPLY_CHARS = 600

# Orphan guard: a record older than this is ignored on replay. Matches the
# task-state TTL. In practice the gap between the SessionEnd and the
# SessionStart of a /clear is seconds; the TTL only catches a record whose
# replay never ran (hook error, dashboard down, session never restarted).
TTL_SECONDS = 12 * 60 * 60

# Transcript entries that are harness bookkeeping rather than something the
# owner typed. A <system-reminder> or a slash-command echo is not a prompt.
_NOISE_PREFIXES = (
    "<system-reminder>",
    "<local-command-stdout>",
    "<command-name>",
    "<command-message>",
    "Caveat: The messages below were generated",
)


def _install_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def store_dir():
    """Where the records live. Test override: CLEARSTATE_DIR."""
    override = os.environ.get("CLEARSTATE_DIR")
    if override:
        return override
    return os.path.join(_install_dir(), "store", "agent-clearstate")


def agent_id_from_cwd(cwd):
    """Which agent is this session, or None when it is not one of ours.

    STRICTER than the conversation ledger's resolver on purpose. The main
    agent's hooks live in the USER-GLOBAL ~/.claude/settings.json, so they also
    fire for the owner's own Claude Code sessions in unrelated repositories.
    The ledger falls back to the main agent for those; a clear-record must not,
    or an unrelated /clear elsewhere on the machine would write a record that
    the real main agent then reads back as its own cleared thread.

      <install>/agents/<id>[/...]  -> <id>
      <install> (or below it)      -> the main agent
      anywhere else                -> None (the hooks no-op)
    """
    if not cwd:
        return None
    install = os.path.normpath(_install_dir())
    norm = os.path.normpath(cwd)
    agents_root = os.path.join(install, "agents")
    if norm.startswith(agents_root + os.sep):
        rel = norm[len(agents_root) + 1:]
        first = rel.split(os.sep)[0]
        return first or None
    if norm == install or norm.startswith(install + os.sep):
        return ledger_lib.main_agent_id()
    return None


def _sanitize(agent):
    # The agent id becomes a filename; allow only the safe charset.
    return "".join(c for c in (agent or "") if c.isalnum() or c in "_-")


def record_path(agent):
    return os.path.join(store_dir(), _sanitize(agent) + ".json")


def _text_of(content):
    """The plain text of a transcript message's content field.

    A string is the message itself. A list is a block array -- only 'text'
    blocks count, so a tool_result turn (the harness's way of feeding tool
    output back as a 'user' message) yields nothing and is skipped by the
    caller.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
        return "\n".join(parts)
    return ""


def _clip(text, limit):
    s = " ".join((text or "").split())
    if limit > 0 and len(s) > limit:
        s = s[:limit].rstrip() + " [...]"
    return s


def extract_turns(transcript_path, max_prompts=MAX_PROMPTS):
    """Read a session transcript (JSONL) and return
    {'prompts': [...oldest-first...], 'lastReply': str}.

    Fail-soft: an unreadable or malformed file yields empty lists rather than
    raising -- a SessionEnd hook must never be the reason a session hangs.
    """
    prompts = []
    last_reply = ""
    try:
        with open(transcript_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                if not isinstance(entry, dict):
                    continue
                kind = entry.get("type")
                message = entry.get("message")
                if not isinstance(message, dict):
                    continue
                text = _text_of(message.get("content"))
                if not text.strip():
                    continue
                if kind == "user":
                    # isMeta marks a harness-injected turn, not a typed prompt.
                    if entry.get("isMeta"):
                        continue
                    stripped = text.lstrip()
                    if stripped.startswith(_NOISE_PREFIXES):
                        continue
                    prompts.append(_clip(text, MAX_PROMPT_CHARS))
                elif kind == "assistant":
                    last_reply = _clip(text, MAX_REPLY_CHARS)
    except Exception:
        return {"prompts": [], "lastReply": ""}
    if max_prompts > 0:
        prompts = prompts[-max_prompts:]
    return {"prompts": prompts, "lastReply": last_reply}


def write_record(agent, transcript_path, turns, now=None):
    """Persist the record for `agent`. One file per agent, overwritten, so the
    store stays bounded by the fleet size and needs no sweep."""
    now = int(now if now is not None else time.time())
    record = {
        "agent": _sanitize(agent),
        "ts": now,
        "transcriptPath": transcript_path or "",
        "prompts": list(turns.get("prompts") or []),
        "lastReply": turns.get("lastReply") or "",
    }
    directory = store_dir()
    os.makedirs(directory, exist_ok=True)
    path = record_path(agent)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return record


def read_record(agent):
    """The stored record, or None when there is none / it is unreadable."""
    try:
        with open(record_path(agent), "r", encoding="utf-8") as f:
            record = json.load(f)
    except Exception:
        return None
    if not isinstance(record, dict):
        return None
    return record


def drop_record(agent):
    """Best-effort delete. Called AFTER a successful injection, so a crash
    before that leaves the record injectable on the next start."""
    try:
        os.unlink(record_path(agent))
    except Exception:
        pass


def is_replayable(record, now=None, ttl=TTL_SECONDS):
    """A record replays only when it exists, is within the TTL, and actually
    carries something. An empty record is not worth a block."""
    if not isinstance(record, dict):
        return False
    ts = record.get("ts")
    if not isinstance(ts, (int, float)) or ts <= 0:
        return False
    now = now if now is not None else time.time()
    if now - ts > ttl:
        return False
    return bool(record.get("prompts") or record.get("lastReply"))


def build_injection(record, owner="A felhasználó"):
    """The SessionStart additionalContext text for a cleared thread.

    Deliberately NON-directive: a /clear can be a deliberate fresh start as
    easily as a gate-driven restart, and the hook cannot tell the two apart. So
    the block states what the previous thread was and lets the next prompt (the
    owner's, or the context-restart gate's wake nudge) decide what to do with
    it. It must not order the agent to resume work nobody asked for.
    """
    lines = [
        "=== TOROLT SZAL (/clear elotti kontextus) ===",
        "Az elozo beszelgetes-szalat egy /clear torolte, ezert ez a session nem "
        "emlekszik ra. Az alabbi kivonat determinisztikusan az elozo szal "
        "atiratabol keszult. Ha a folytatasrol van szo, innen folytasd, es ne "
        "kezdd elolrol ami mar kesz. Ha viszont uj feladatot kapsz, ez csak "
        "hatter -- ne eleszd ujra a regi szalat magatol.",
    ]
    prompts = record.get("prompts") or []
    if prompts:
        lines.append(
            "%s UTOLSO KERESEI (idorendben):\n" % owner
            + "\n".join("  - %s" % p for p in prompts)
        )
    last_reply = record.get("lastReply") or ""
    if last_reply:
        lines.append("AMIT UTOLJARA MONDTAL: %s" % last_reply)
    transcript = record.get("transcriptPath") or ""
    if transcript:
        lines.append(
            "A TELJES ATIRAT megmaradt: %s -- olvasd be, ha a folytatashoz "
            "tobb kell, mint a fenti kivonat." % transcript
        )
    return "\n\n".join(lines)
