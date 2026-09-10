#!/usr/bin/env python3
"""
slack_progress_watchdog.py -- the "őrszem" (sentry) for the Slack progress
indicator. Mirrors telegram_progress_watchdog.py exactly (same detection
logic, same thresholds, same TGORPHAN908 guards), adapted to the Slack API.
Runs independently of the agent sessions (via launchd/systemd), so it can
speak even when an agent is wedged or down.

Problem it solves: slack_progress.py posts a "✍️ Dolgozom rajta…"
placeholder; slack_progress_clear.py (Stop hook) deletes it when the turn
ends. If a turn never ends (agent crashed, session killed, or WEDGED on a
dropped MCP reply-tool call that never returns), the placeholder would sit
there forever.

Two delivery modes, best-effort per pending placeholder:
  - REAL ANSWER (preferred): if the agent's final answer is recoverable from
    the transcript, deliver it for real (chat.postMessage, in-thread if the
    placeholder had a thread_ts) and remove the placeholder (chat.delete).
  - GENERIC ERROR (fallback): if no answer is recoverable, rewrite the
    placeholder into a clear error via chat.update. Editing is intentionally
    only used here (a Slack edit does not push a notification, so it is
    wrong for a real answer, but fine for a backstop error the watchdog loop
    will keep surfacing on repeat checks anyway).

Detection (per pending placeholder, keyed by its session state file):
  - agent DOWN (its tmux `agent-<name>` session is gone) and the placeholder
    is older than DOWN_GRACE_SEC -> fire (crash / unreachable), or
  - agent UP but the transcript shows a HUNG reply -- the most recent tool
    call is the Slack `reply` and it has no result yet -- and the
    placeholder is older than WEDGED_UP_SEC -> fire FAST.
  - agent UP with no hung-reply signal but the placeholder is older than
    WEDGED_SEC -> fire (blunt backstop).
  - placeholder older than STALE_SEC (default 24h) -> DEAD round: deliver
    nothing, drop the marker and delete the placeholder message. TGORPHAN908:
    without this bound a post-outage scan walked 28-day orphans into the
    backstop and sent internal work logs to the owner.

The recovered answer is scoped to the round that posted the placeholder (see
read_transcript): the transcript keeps growing after that round, so its last
text may be a later internal turn's monologue -- never deliverable here.

Standalone: scans every agent's per-agent Slack state dir. No marveen src
dependency; only Python stdlib + the `tmux` binary. API base overridable via
SLACK_API_BASE (tests point it at a local stub).
"""
import datetime, os, glob, json, time, subprocess, urllib.request

# State dirs to scan: per-agent dirs under the fleet, plus the default dir.
# No hardcoded user paths -- derive from $HOME (override with MARVEEN_ROOT).
FLEET_ROOT = os.environ.get("MARVEEN_ROOT") or os.path.expanduser("~/marveen")
SCAN_GLOBS = [
    os.path.join(FLEET_ROOT, "agents", "*", ".claude", "channels", "slack", "progress"),
    # #915: the main agent's state dir is install-scoped once migrated; scan
    # both bases -- at most one holds live progress markers.
    os.path.join(FLEET_ROOT, ".claude", "channels", "slack", "progress"),
    os.path.expanduser("~/.claude/channels/slack/progress"),
]
DOWN_GRACE_SEC = 120        # agent down + placeholder older than this -> fire
WEDGED_SEC = 15 * 60        # agent up, no hung-reply signal, this old -> fire (backstop)
# UPPER age bound (TGORPHAN908): a marker older than this marks a DEAD round,
# not a stuck one -- there is no question behind it that needs an answer today.
# Deliver NOTHING; drop the marker. Unlike Telegram, Slack lets a bot delete
# its own message at any age, so the placeholder is always cleaned up.
DEFAULT_STALE_SEC = 24 * 3600
# A marker is written by the SAME submit hook that logs the user event into the
# transcript, so the round's opening user-prompt sits within seconds of the
# marker mtime. The slack absorbs clock/write-order jitter.
TURN_ANCHOR_SLACK_SEC = 120
# agent up + a HUNG reply detected + placeholder older than this -> fire FAST.
# Far below WEDGED_SEC because the hung-reply signal is precise. Env-tunable so
# a live install can adjust without a code change.
DEFAULT_WEDGED_UP_SEC = 180
ERROR_TEXT = ("⚠️ Valami elakadt, és erre nem érkezett válasz. "
              "Lehet, hogy újra kell indítani az ügynököt, vagy próbáld újra kicsit később.")


def _env_int(name, default):
    v = os.environ.get(name)
    if v:
        try:
            n = int(v)
            if n > 0:
                return n
        except ValueError:
            pass
    return default


def wedged_up_sec():
    return _env_int("SLACK_WATCHDOG_WEDGED_UP_SEC", DEFAULT_WEDGED_UP_SEC)


def stale_sec():
    return _env_int("SLACK_WATCHDOG_STALE_SEC", DEFAULT_STALE_SEC)


def api_base():
    return os.environ.get("SLACK_API_BASE", "https://slack.com/api").rstrip("/")


def token(state_dir):
    try:
        for line in open(os.path.join(state_dir, ".env"), encoding="utf-8"):
            line = line.strip()
            if line.startswith("SLACK_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    except Exception:
        return None
    return None


def api(tok, method, payload):
    url = f"{api_base()}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": f"Bearer {tok}",
    })
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def agent_name_from(progress_dir):
    parts = progress_dir.split(os.sep)
    if "agents" in parts:
        i = parts.index("agents")
        if i + 1 < len(parts):
            return parts[i + 1]
    return None


def tmux_session_alive(session):
    forced = os.environ.get("SLACK_WATCHDOG_FORCE_AGENT_UP")
    if forced in ("0", "1"):
        return forced == "1"
    try:
        return subprocess.run(["tmux", "has-session", "-t", session],
                              capture_output=True, timeout=5).returncode == 0
    except Exception:
        return True  # if tmux probe fails, assume alive (don't false-alarm)


def _iter_events(transcript_path):
    if not transcript_path:
        return
    try:
        f = open(transcript_path, encoding="utf-8")
    except Exception:
        return
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue


def _is_reply_tool(name):
    n = (name or "").lower()
    return "slack" in n and "reply" in n


def _ev_epoch(ev):
    ts = ev.get("timestamp")
    if not ts or not isinstance(ts, str):
        return None
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def _is_user_prompt(ev):
    """A real inbound prompt (starts a turn) -- NOT a tool_result carrier."""
    msg = ev.get("message") or {}
    role = msg.get("role") or ev.get("role")
    if not (ev.get("type") == "user" or role == "user"):
        return False
    content = msg.get("content", ev.get("content"))
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        return any(isinstance(b, dict) and b.get("type") != "tool_result"
                   for b in content)
    return False


class _Acc:
    """Accumulator for one scan window of the transcript."""
    def __init__(self):
        self.text = ""
        self.results = set()      # tool_use_ids that have a tool_result
        self.reply_ids = set()    # tool_use_ids of Slack reply calls
        self.last_tool_use = None  # (id, is_reply) of the most recent tool_use

    def feed(self, ev):
        msg = ev.get("message") or {}
        role = msg.get("role") or ev.get("role")
        content = msg.get("content", ev.get("content"))
        is_assistant = ev.get("type") == "assistant" or role == "assistant"
        if isinstance(content, list):
            for b in content:
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                if bt == "tool_use":
                    is_reply = _is_reply_tool(b.get("name"))
                    self.last_tool_use = (b.get("id"), is_reply)
                    if is_reply and b.get("id") is not None:
                        self.reply_ids.add(b.get("id"))
                elif bt == "tool_result":
                    tid = b.get("tool_use_id")
                    if tid is not None:
                        self.results.add(tid)
                elif bt == "text" and is_assistant:
                    t = (b.get("text") or "").strip()
                    if t:
                        self.text = t
        elif isinstance(content, str) and is_assistant:
            if content.strip():
                self.text = content.strip()

    def reply_hung(self):
        return bool(self.last_tool_use and self.last_tool_use[1]
                    and self.last_tool_use[0] not in self.results)

    def reply_delivered(self):
        return bool(self.reply_ids & self.results)


def read_transcript(transcript_path, turn_start=None):
    """Return (last_assistant_text, reply_is_hung, reply_delivered).

    last_assistant_text: the agent's final user-facing answer (last non-empty
    assistant text block) -- the same source the Stop hook's fallback uses.

    reply_is_hung: True iff the most recent tool call in scope is the Slack
    `reply` tool with no matching tool_result yet (dropped MCP).

    reply_delivered: True iff a Slack reply call in scope DID get a result
    -- the round's answer already reached the channel, so nothing may be resent.

    Scope (TGORPHAN908): a transcript outlives the round that posted the
    placeholder -- later scheduled/internal turns keep appending, so the LAST
    text of the whole file may be internal monologue that was never meant for
    the channel. When `turn_start` (the marker mtime) is given and the
    transcript carries timestamped user prompts, only the round active at
    turn_start is read: from the last user prompt at/before turn_start+slack
    to the next user prompt. A timestamped transcript with no prompt at/before
    the marker is unattributable -> no answer (generic-error path), never a
    foreign turn's text. Transcripts without timestamped prompts (older
    format) keep the whole-file behavior.
    """
    whole = _Acc()
    scoped = _Acc()
    have_ts_prompt = False
    anchor_seen = False
    in_window = False
    for ev in _iter_events(transcript_path):
        if _is_user_prompt(ev):
            e = _ev_epoch(ev)
            if e is not None:
                have_ts_prompt = True
                if turn_start is not None and e <= turn_start + TURN_ANCHOR_SLACK_SEC:
                    scoped = _Acc()  # a later prompt supersedes: window restarts
                    anchor_seen = True
                    in_window = True
                elif in_window:
                    in_window = False  # the marker's round ended here
        whole.feed(ev)
        if in_window:
            scoped.feed(ev)
    if turn_start is not None and have_ts_prompt:
        if not anchor_seen:
            return "", False, False
        return scoped.text, scoped.reply_hung(), scoped.reply_delivered()
    return whole.text, whole.reply_hung(), False


def log(progress_dir, msg):
    try:
        with open(os.path.join(progress_dir, "debug.log"), "a", encoding="utf-8") as f:
            f.write(f"[watchdog {time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def delete_placeholder(tok, p, progress_dir, label):
    try:
        api(tok, "chat.delete", {"channel": p.get("chat_id"), "ts": p.get("ts")})
    except Exception as e:
        log(progress_dir, f"{label} delete failed (ts={p.get('ts')}): {e}")


def deliver(tok, chat_id, ts, thread_ts, answer, progress_dir):
    """Deliver the real answer if we have one (chat.postMessage + drop the
    placeholder via chat.delete), else rewrite the placeholder into a
    generic error (chat.update). Returns a short label for logging."""
    if answer:
        payload = {"channel": chat_id, "text": answer[:4000]}
        if thread_ts:
            payload["thread_ts"] = thread_ts
        try:
            api(tok, "chat.postMessage", payload)
        except Exception as e:
            log(progress_dir, f"real-answer send failed (ts={ts}): {e}")
            return "send-failed"
        delete_placeholder(tok, {"chat_id": chat_id, "ts": ts}, progress_dir, "placeholder")
        return "real-answer"
    # No recoverable answer -> generic error, keep the (edited) placeholder.
    try:
        api(tok, "chat.update", {"channel": chat_id, "ts": ts, "text": ERROR_TEXT})
    except Exception as e:
        log(progress_dir, f"error edit failed (ts={ts}): {e}")
    return "generic-error"


def handle_dir(progress_dir):
    state_dir = os.path.dirname(progress_dir)           # .../slack
    name = agent_name_from(progress_dir)
    agent_up = tmux_session_alive(f"agent-{name}") if name else True
    now = time.time()
    # Sweep orphan dedup markers (normally removed by the Stop hook).
    for m in glob.glob(os.path.join(progress_dir, "seen-*.marker")):
        try:
            if now - os.path.getmtime(m) > 3600:
                os.remove(m)
        except Exception:
            pass
    tok = None
    up_sec = wedged_up_sec()
    max_age = stale_sec()
    for path in glob.glob(os.path.join(progress_dir, "*.json")):
        try:
            age = now - os.path.getmtime(path)
        except Exception:
            continue
        try:
            pend = json.load(open(path))
        except Exception:
            pend = []
        if not pend:
            continue

        # UPPER age bound (TGORPHAN908): a marker this old marks a DEAD round.
        # Whatever answer might be scraped from its transcript, nobody is
        # waiting for it today -- deliver NOTHING, drop the marker and the
        # placeholder message.
        if age > max_age:
            if tok is None:
                tok = token(state_dir)
            if tok:
                for p in pend:
                    delete_placeholder(tok, p, progress_dir, "stale placeholder")
            try:
                os.remove(path)
            except Exception:
                pass
            log(progress_dir, f"orphan dropped (stale): {os.path.basename(path)} "
                              f"age={int(age)}s delivered=none")
            continue

        # The transcript path is stamped onto the pending entries by the submit
        # hook (same for the whole turn); read the agent's answer + hung-reply
        # signal once, scoped to the round that posted this marker.
        transcript_path = ""
        for p in pend:
            if p.get("transcript_path"):
                transcript_path = p["transcript_path"]
                break
        answer, reply_hung, reply_delivered = read_transcript(
            transcript_path, turn_start=now - age)

        # Fire decision.
        if not agent_up:
            fire = age > DOWN_GRACE_SEC
            reason = "agent-down"
        elif reply_hung and age > up_sec:
            fire = True
            reason = "reply-hung"
        elif age > WEDGED_SEC:
            fire = True
            reason = "wedged-backstop"
        else:
            fire = False
            reason = ""
        if not fire:
            continue

        if tok is None:
            tok = token(state_dir)
        if not tok:
            continue

        # The round's own reply already reached the channel (a reply call in
        # this round's window has a result): the marker is leftover bookkeeping
        # from a missed Stop hook. Resending would duplicate the answer -- and
        # the transcript's LAST text may belong to a later, internal turn.
        # Clear silently.
        if reply_delivered and not reply_hung:
            for p in pend:
                delete_placeholder(tok, p, progress_dir, "placeholder")
            try:
                os.remove(path)
            except Exception:
                pass
            log(progress_dir, f"orphan cleared (reply-already-delivered): "
                              f"{os.path.basename(path)} agent_up={agent_up} "
                              f"age={int(age)}s delivered=none")
            continue

        modes = []
        for p in pend:
            modes.append(deliver(tok, p.get("chat_id"), p.get("ts"),
                                 p.get("thread_ts"), answer, progress_dir))
        try:
            os.remove(path)
        except Exception:
            pass
        log(progress_dir, f"orphan handled ({reason}): {os.path.basename(path)} "
                          f"agent_up={agent_up} age={int(age)}s "
                          f"delivered={','.join(modes)}")


def main():
    dirs = []
    for g in SCAN_GLOBS:
        dirs.extend(glob.glob(g))
    for d in dirs:
        if os.path.isdir(d):
            handle_dir(d)


if __name__ == "__main__":
    main()
