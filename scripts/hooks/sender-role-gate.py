#!/usr/bin/env python3
"""
sender-role-gate.py -- PreToolUse hook for "a risky tool must not run in a
turn that carries a message from someone who is not an owner".

Why this exists: an agent that sits in a shared chat (a Telegram group, a
Teams channel) takes requests from its owner AND from colleagues. To the
model a colleague's message looks like any other instruction, so a colleague
-- or a hidden instruction inside a colleague's message -- can make the agent
run the same risky tool the owner can (send mail, run shell). Permission
rules alone cannot tell the two apart: they see the tool, not WHO asked for
it. This gate adds the missing half. It denies every tool listed in the
agent's senderRoleGate.riskyTools whenever the CURRENT TURN carries an
envelope from a sender whose role is not "owner".

The rule in one sentence: risky tool + any non-owner envelope anywhere in
the current turn -> deny; everything else -> allow silently.

What it reads:
  --config <abs path to agents/<name>/agent-config.json>, key
  "senderRoleGate": {"riskyTools": [glob patterns], "roles":
  [{"channel","sender","role"}], "senderKeys": {channel: attribute}}.
  riskyTools patterns are fnmatch-case globs matched after replacing every
  "-" with "_" on BOTH sides, so "send_mail" and "send-mail" are the same
  tool. Sender ids come from the envelope attributes (telegram: user_id,
  teams: aad_object_id, overridable per channel via senderKeys).

What a "turn" is (see find_window): the window from the last batch of
turn-start records (type "user" with turnPosition.turnIndex) to the end of
the transcript. Inside the window three record shapes carry chat envelopes:
turn-start prompts themselves, queued_command attachments (a message handed
to the model mid-turn) and queue-operation enqueues (written the moment the
message arrives, before the attachment exists). An enqueue is never undone
by its later remove/dequeue. ALL envelopes in a carried text count,
including ones quoted inside the message body, so a forged owner envelope
typed by a colleague can only tighten the verdict, never loosen it.

Fail-closed: a missing/empty/unreadable transcript, no turn start within
the read cap, a half-written line inside the window, or a malformed config
make the turn "member" (every tool risky for a malformed config). An owner
typing at the terminal has NO envelope in the turn and is never blocked,
even by a broken config.

Output contract (PreToolUse): allow = print nothing, exit 0; deny = one
JSON object on stdout, exit 0. Never exit 2, never write to stderr on the
normal path.
"""
import argparse, fnmatch, json, os, re, sys

# Reading bounds for the backwards transcript scan (1.6(ii)). The defaults
# keep a multi-gigabyte session transcript from being pulled into a hook
# that runs on every tool call; both are overridable so the tests can force
# chunk boundaries and the cap.
DEFAULT_CHUNK_BYTES = 1024 * 1024
DEFAULT_MAX_BYTES = 64 * 1024 * 1024
ENV_CHUNK_BYTES = "SENDER_ROLE_GATE_CHUNK_BYTES"
ENV_MAX_BYTES = "SENDER_ROLE_GATE_MAX_BYTES"

# Which envelope attribute carries the sender id, per channel (1.3). These
# defaults always apply unless senderKeys overrides the channel.
DEFAULT_SENDER_KEYS = {"telegram": "user_id", "teams": "aad_object_id"}

# An opening <channel ...> tag and its attributes (1.6 iv). The tag must
# have at least one whitespace character before the attributes, so a word
# like "<channels" does not match.
CHANNEL_TAG_RE = re.compile(r"<channel\s+([^>]*)>")
ATTR_RE = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"')


def is_plain_object(value):
    return isinstance(value, dict)


# --- config (1.3 / 1.4 / 1.5) ------------------------------------------------
#
# load_config returns (state, settings, problem):
#   ("off", None, None)                     the gate is not configured -- 1.4
#   ("on", {...}, None)                     a valid gate -- 1.3
#   ("malformed", None, "what is wrong")    fail closed -- 1.5
def load_config(path):
    """Read the agent's agent-config.json and classify its senderRoleGate."""
    try:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
    except FileNotFoundError:
        return ("off", None, None)  # 1.4(a): no file, no gate
    except OSError as exc:
        return ("malformed", None,
                "the config file cannot be read (%s)" % type(exc).__name__)
    try:
        parsed = json.loads(raw)
    except ValueError:
        return ("malformed", None, "the config file is not valid JSON")
    if not is_plain_object(parsed):
        return ("malformed", None, "the config file is not a JSON object")
    if "senderRoleGate" not in parsed:
        return ("off", None, None)  # 1.4(b)
    gate = parsed["senderRoleGate"]
    if not is_plain_object(gate):
        return ("malformed", None, "senderRoleGate is not an object")
    # 1.4(c) beats 1.5: riskyTools missing or [] turns the gate off even when
    # other keys are garbage -- an explicitly empty list is a decision, not a
    # fault.
    if "riskyTools" not in gate or gate["riskyTools"] == []:
        return ("off", None, None)
    return validate_gate(gate)


def validate_gate(gate):
    """A gate that is neither off nor absent: check every key, or say why not."""
    risky = gate["riskyTools"]
    if not isinstance(risky, list) or not all(isinstance(p, str) for p in risky):
        return ("malformed", None, "riskyTools is not a list of strings")
    roles_raw = gate.get("roles", [])
    if not isinstance(roles_raw, list):
        return ("malformed", None, "roles is not a list")
    roles = {}
    for entry in roles_raw:
        if not is_plain_object(entry):
            return ("malformed", None, "roles contains a non-object entry")
        channel, sender, role = entry.get("channel"), entry.get("sender"), entry.get("role")
        if not (isinstance(channel, str) and isinstance(sender, str)
                and role in ("owner", "member")):
            return ("malformed", None,
                    "roles contains an entry without string channel/sender "
                    "and role owner|member")
        roles[(channel, sender)] = role
    keys_raw = gate.get("senderKeys", {})
    if not is_plain_object(keys_raw) or not all(isinstance(k, str) for k in keys_raw.values()):
        return ("malformed", None, "senderKeys is not an object of strings")
    sender_keys = dict(DEFAULT_SENDER_KEYS)
    sender_keys.update(keys_raw)
    return ("on", {"riskyTools": risky, "roles": roles, "senderKeys": sender_keys}, None)


def tool_is_risky(tool, patterns):
    """Glob match with '-'/'_' normalised on BOTH sides (fnmatchcase, so the
    match stays case-sensitive and locale-free)."""
    tool_norm = tool.replace("-", "_")
    for pattern in patterns:
        if fnmatch.fnmatchcase(tool_norm, pattern.replace("-", "_")):
            return True
    return False


# --- transcript window (1.6) -------------------------------------------------

def turn_index_of(record):
    """turnIndex if the record is a turn-start (type user + turnPosition with
    an integer turnIndex), else None."""
    if not is_plain_object(record) or record.get("type") != "user":
        return None
    position = record.get("turnPosition")
    if not is_plain_object(position):
        return None
    index = position.get("turnIndex")
    if isinstance(index, bool) or not isinstance(index, int):
        return None
    return index


class BackwardsLines:
    """Iterate a binary file's lines from the END backwards, one chunk at a
    time, so a turn start near the end of a long transcript does not pull in
    the whole file. Stops early at `max_bytes`; `capped` says whether it did.
    """

    def __init__(self, fh, chunk_bytes, max_bytes):
        self.fh = fh
        self.chunk = max(1, chunk_bytes)
        self.cap = max(1, max_bytes)
        self.capped = False
        self._pos = fh.seek(0, os.SEEK_END)
        self._spent = 0
        self._head = b""       # start of a line whose beginning is further back
        self._done = self._pos <= 0

    def __iter__(self):
        while not self._done:
            if self._pos <= 0:
                # File start reached: the pending head is the first line, so
                # in backwards order it comes LAST.
                self._done = True
                if self._head:
                    yield self._head
                return
            budget = self.cap - self._spent
            if budget <= 0:
                self.capped = True   # ran out of read budget, not of file
                self._done = True
                return
            step = min(self.chunk, budget, self._pos)
            self.fh.seek(self._pos - step)
            data = self.fh.read(step)
            self._pos -= step
            self._spent += len(data)
            parts = (data + self._head).split(b"\n")
            self._head = parts[0]
            complete = parts[1:]
            if complete and complete[-1] == b"":
                complete.pop()   # the bytes ended AT a newline: no line there
            yield from reversed(complete)


def parse_json_line(raw):
    try:
        return json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        return None


def find_window(fh, chunk_bytes, max_bytes):
    """-> (window_records_in_file_order, error_clause). The window starts at
    the earliest turn-start record of the LAST batch (same turnIndex, no
    other turnIndex after it) and runs to the end of the file (1.6 i)."""
    scanned = []          # parsed records, END -> start
    turn = None           # turnIndex of the last batch
    last_turn_start = -1  # index in `scanned` of its earliest member so far
    reader = BackwardsLines(fh, chunk_bytes, max_bytes)
    for raw in reader:
        record = parse_json_line(raw)
        index = turn_index_of(record)
        if index is not None and turn is not None and index != turn:
            break         # previous turn (or a restart's older index): outside
        scanned.append(record)
        if index is not None:
            if turn is None:
                turn = index
            last_turn_start = len(scanned) - 1
    if turn is None:
        if reader.capped:
            return None, "no turn-start record was found within the %d-byte read cap" % max_bytes
        return None, "no turn-start record was found in the transcript"
    # scanned is END->start, so [:last_turn_start+1] drops everything before
    # the window start; a line there being unparseable does not matter.
    window = scanned[:last_turn_start + 1]
    window.reverse()
    return window, None


def as_texts(content):
    """A carried payload is a string, or a content list whose text items carry
    strings (the transcript's two shapes for message content)."""
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        return [item.get("text") for item in content
                if is_plain_object(item) and item.get("type") == "text"
                and isinstance(item.get("text"), str)]
    return []


def carried_texts(record):
    """The texts that may carry envelopes, inside the window only (1.6 iii)."""
    if not is_plain_object(record):
        return []
    kind = record.get("type")
    if kind == "user":
        # Turn-start prompts only: a tool_result user record has no
        # turnPosition and must not count.
        if not is_plain_object(record.get("turnPosition")):
            return []
        message = record.get("message")
        content = message.get("content") if is_plain_object(message) else None
        return as_texts(content)
    if kind == "attachment":
        attachment = record.get("attachment")
        if is_plain_object(attachment) and attachment.get("type") == "queued_command":
            return as_texts(attachment.get("prompt"))
        return []
    if kind == "queue-operation":
        # Enqueue only: a message counts the moment it arrives. remove /
        # dequeue never undoes it inside the same turn.
        if record.get("operation") == "enqueue" and isinstance(record.get("content"), str):
            return [record["content"]]
        return []
    return []


def envelope_role(attrs, roles, sender_keys):
    """-> (role, clause) for one parsed envelope. Everything unusual -- no
    source, a channel without a sender key, a missing sender attribute -- is
    a member, never a pass."""
    source = attrs.get("source")
    if not isinstance(source, str) or not source:
        return ("member", "it carries a message envelope without a source attribute")
    channel = source.rsplit(":", 1)[-1]
    key = sender_keys.get(channel)
    if not key:
        return ("member",
                "it carries a message from channel %s, which has no sender key "
                "configured" % channel)
    sender = attrs.get(key)
    if not isinstance(sender, str) or not sender:
        return ("member",
                "it carries a message from channel %s whose %s attribute is "
                "missing" % (channel, key))
    role = roles.get((channel, sender), "member")
    if role != "owner":
        return ("member", "it carries a message from a sender who is not an "
                "owner (channel %s, sender %s)" % (channel, sender))
    return ("owner", None)


def window_role(window, roles, sender_keys):
    """-> (turn_role, clause): member if any counted envelope is a member or
    any line inside the window is not valid JSON; owner if at least one
    envelope was counted and all were owners; none if nothing was carried."""
    saw_envelope = False
    for record in window:
        if record is None:
            return ("member", "a transcript line inside this turn is not valid JSON")
        for text in carried_texts(record):
            for match in CHANNEL_TAG_RE.finditer(text):
                saw_envelope = True
                pairs = ATTR_RE.findall(match.group(1))
                attrs = dict(pairs)
                # A repeated attribute is a member, never last-one-wins: a display
                # name carrying `" aad_object_id="<owner id>` would otherwise
                # replace the real sender id that the plugin wrote before it.
                if len(attrs) != len(pairs):
                    return ("member", "it carries a message envelope with a repeated attribute")
                role, clause = envelope_role(attrs, roles, sender_keys)
                if role != "owner":
                    return ("member", clause)
    return ("owner" if saw_envelope else "none", None)


def compute_turn_role(transcript_path, roles, sender_keys, chunk_bytes, max_bytes):
    """-> (turn_role, clause). Every fail-closed condition of 1.6(vi) maps to
    ("member", clause naming the condition)."""
    if not isinstance(transcript_path, str) or not transcript_path:
        return ("member", "the transcript path is missing from the hook input")
    try:
        fh = open(transcript_path, "rb")
    except OSError:
        return ("member", "the transcript cannot be read")
    with fh:
        if fh.seek(0, os.SEEK_END) == 0:
            return ("member", "the transcript is empty")
        fh.seek(0)
        window, error = find_window(fh, chunk_bytes, max_bytes)
        if error:
            return ("member", error)
        return window_role(window, roles, sender_keys)


# --- decision and output (1.2 / 1.7) -----------------------------------------

def deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        },
    }))
    return 0


def env_positive_int(name, default):
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


def run(raw_stdin, state, settings, problem):
    """Everything after the OFF check. Raises on unexpected input so the
    caller can turn it into the internal-error deny of 1.7."""
    payload = json.loads(raw_stdin)
    if not is_plain_object(payload):
        raise ValueError("hook input is not a JSON object")
    tool = payload.get("tool_name")
    tool = tool if isinstance(tool, str) else ""
    if state == "malformed":
        # 1.5: every tool is risky, every enveloped sender a member.
        risky, roles, sender_keys = True, {}, dict(DEFAULT_SENDER_KEYS)
    else:
        risky = tool_is_risky(tool, settings["riskyTools"])
        roles, sender_keys = settings["roles"], settings["senderKeys"]
    if not risky:
        return 0
    role, clause = compute_turn_role(
        payload.get("transcript_path"), roles, sender_keys,
        env_positive_int(ENV_CHUNK_BYTES, DEFAULT_CHUNK_BYTES),
        env_positive_int(ENV_MAX_BYTES, DEFAULT_MAX_BYTES))
    if role != "member":
        return 0
    if state == "malformed":
        reason = ("sender-role-gate: %s is not allowed in this turn: %s. The "
                  "senderRoleGate config is malformed (%s), so every tool is "
                  "treated as risky and every sender as a non-owner; fix the "
                  "agent's agent-config.json."
                  % (tool or "(unknown tool)", clause, problem))
    else:
        reason = ("sender-role-gate: %s is not allowed in this turn: %s. Only "
                  "an owner's own turn can run it." % (tool, clause))
    return deny(reason)


def _install_dir():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# What sanitizeAgentName (src/web/sanitize.ts) can produce.
AGENT_NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]*")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    src = ap.add_mutually_exclusive_group(required=True)
    # The launcher wires --agent: a hook argument may not carry a path (the
    # scaffold refuses anything that would need quoting), and the agent's
    # config lives at <install>/agents/<name>/agent-config.json.
    src.add_argument("--agent", help="the agent's name")
    src.add_argument("--config", help="path to an agent-config.json (tests)")
    args = ap.parse_args(argv)
    if args.agent is not None:
        if not AGENT_NAME_RE.fullmatch(args.agent):
            state, settings, problem = ("malformed", None, "--agent is not a valid agent name")
        else:
            state, settings, problem = load_config(
                os.path.join(_install_dir(), "agents", args.agent, "agent-config.json"))
    else:
        state, settings, problem = load_config(args.config)
    if state == "off":
        # 1.4: not configured -- no opinion, and the transcript is not even
        # opened.
        return 0
    try:
        return run(sys.stdin.read(), state, settings, problem)
    except Exception as exc:  # 1.7: after ON, deny rather than guess
        return deny("sender-role-gate: internal error: %s" % type(exc).__name__)


if __name__ == "__main__":
    sys.exit(main())
