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

Delivery failures are NOT success. Slack signals application errors with
HTTP 200 + {"ok": false, "error": "..."} (the Telegram Bot API uses HTTP 4xx,
which urlopen raises on by itself), so api() raises on an ok:false envelope
and every send/edit/delete failure is visible to the caller. Two classes:
  - RETRYABLE (HTTP 429/5xx, connection errors/timeouts, Slack "ratelimited",
    "internal_error", "service_unavailable", "fatal_error"): nothing reached
    Slack and waiting may fix it -> the marker is KEPT (mtime preserved, so
    its age and round anchor stand) and the next tick retries; the 24h stale
    bound still caps the retries.
  - TERMINAL (everything else: channel_not_found, not_in_channel, is_archived,
    invalid_auth, thread_not_found, msg_too_long, ...): waiting cannot fix
    it -> fall through to the generic-error rewrite so the user at least sees
    a failure instead of an eternal "working...", and drop the marker.
Before this, a rejected chat.postMessage was logged as "real-answer", the
placeholder deleted and the marker dropped: no answer, no error, a log that
claimed success.

`replied` entries are delete-only. slack_progress_reply_clear.py marks an entry
`"replied": true` when the agent's answer went out but the placeholder's
chat.delete failed RETRYABLY; it keeps the entry so that somebody still knows
the placeholder is there. For such an entry this watchdog retries the delete on
every tick, whatever the marker's age or the agent's state, and never delivers
an answer or an error rewrite for it -- the round has its reply. A retryable
failure keeps it for the next tick, a terminal one drops it, the 24h stale
bound caps the retries.

Standalone: scans every agent's per-agent Slack state dir. No marveen src
dependency; only Python stdlib + the `tmux` binary. API base overridable via
SLACK_API_BASE (tests point it at a local stub).
"""
import datetime, os, glob, json, time, subprocess, urllib.error, urllib.request

# State dirs to scan: per-agent dirs under the fleet, plus the default dir.
#
# TGWDOGVAK913 (ported from telegram_progress_watchdog.py): this daemon is
# launched by launchd/systemd, and launchd does NOT pass the operator's shell
# environment to a job -- the plist EnvironmentVariables holds only what the
# installer writes. So MARVEEN_ROOT is NOT set in the daemon's environment
# unless the installer put it there, and the old `~/marveen` default pointed at
# a directory that does not exist on the real install (root:
# /Users/<user>/ClaudeClaw). The watchdog then scanned non-existent globs and
# its log stayed 0 bytes -- a sentry that guards nothing.
#
# The durable fix is self-location: since #1305 the installer points the unit at
# the repo copy at <root>/scripts/hooks/slack_progress_watchdog.py, so the root
# is two directories up, needing no environment at all. MARVEEN_ROOT still wins
# as an explicit override; ~/marveen stays as the last-resort legacy fallback.
def _derive_fleet_root():
    env = os.environ.get("MARVEEN_ROOT")
    if env:
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    # <root>/scripts/hooks/slack_progress_watchdog.py -> <root>
    if os.path.basename(here) == "hooks" and os.path.basename(os.path.dirname(here)) == "scripts":
        cand = os.path.dirname(os.path.dirname(here))
        # Confirm it looks like an install root, so a stray copy in some other
        # scripts/hooks/ tree does not silently capture the scan.
        if os.path.isdir(os.path.join(cand, ".claude")) or os.path.isdir(os.path.join(cand, "agents")):
            return cand
    return os.path.expanduser("~/marveen")


FLEET_ROOT = _derive_fleet_root()
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
# Generic-error rewrite, per install language (resolved per state dir).
TEXTS = {
    "hu": {"error": ("⚠️ Valami elakadt, és erre nem érkezett válasz. "
                     "Lehet, hogy újra kell indítani az ügynököt, vagy próbáld újra kicsit később.")},
    "en": {"error": ("⚠️ Something got stuck and this message never got an answer. "
                     "The agent may need a restart, or try again a bit later.")},
}


def lang(sd):
    """Install language: MARVEEN_LANG env, else the install's `.lang` file
    (written by install.sh at the install root; found by walking up from the
    state dir, which is <root>/.claude/channels/slack or
    <root>/agents/<name>/.claude/channels/slack), else hu (the repo default)."""
    v = (os.environ.get("MARVEEN_LANG") or "").strip().lower()
    if v in TEXTS:
        return v
    d = os.path.abspath(sd)
    for _ in range(6):
        try:
            v = open(os.path.join(d, ".lang"), encoding="utf-8").read().strip().lower()
            if v in TEXTS:
                return v
        except Exception:
            pass
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return "hu"


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


# Slack error codes that mean "try again later", not "this cannot be delivered".
RETRYABLE_SLACK_ERRORS = {"ratelimited", "internal_error", "service_unavailable",
                          "fatal_error", "request_timeout"}


class SlackApiError(Exception):
    """An HTTP-200 envelope with ok:false (or a malformed body)."""
    def __init__(self, method, error):
        super().__init__(f"{method}: {error}")
        self.method, self.error = method, error
        self.retryable = error in RETRYABLE_SLACK_ERRORS


def retryable(e):
    """True when a failed call is worth another attempt on a later tick."""
    if isinstance(e, SlackApiError):
        return e.retryable
    if isinstance(e, urllib.error.HTTPError):
        return e.code == 429 or e.code >= 500
    return True  # URLError / timeout / connection reset: transient by nature


def api(tok, method, payload):
    url = f"{api_base()}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": f"Bearer {tok}",
    })
    with urllib.request.urlopen(req, timeout=8) as r:
        resp = json.loads(r.read().decode())
    if not isinstance(resp, dict) or not resp.get("ok"):
        err = resp.get("error") if isinstance(resp, dict) else None
        raise SlackApiError(method, err or "malformed-response")
    return resp


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
    """chat.delete one placeholder. False only on a RETRYABLE failure (the
    message is still there and a later attempt may remove it); True when it is
    gone or a TERMINAL rejection means no attempt ever will."""
    try:
        api(tok, "chat.delete", {"channel": p.get("chat_id"), "ts": p.get("ts")})
    except Exception as e:
        log(progress_dir, f"{label} delete failed (ts={p.get('ts')}): {e}")
        return not retryable(e)
    return True


def deliver(tok, chat_id, ts, thread_ts, answer, progress_dir, error_text):
    """Deliver the real answer if we have one (chat.postMessage + drop the
    placeholder via chat.delete), else rewrite the placeholder into a
    generic error (chat.update). Returns a short label for logging:
      "real-answer"   the answer is in the channel (a failed follow-up
                      chat.delete is only logged: the answer got through);
      "generic-error" the placeholder now shows the error text -- or a
                      TERMINAL rejection left nothing more to do;
      "send-failed"   a RETRYABLE failure: nothing reached Slack and the
                      placeholder is untouched; the caller keeps the marker
                      so the next tick tries again."""
    if answer:
        payload = {"channel": chat_id, "text": answer[:4000]}
        if thread_ts:
            payload["thread_ts"] = thread_ts
        try:
            api(tok, "chat.postMessage", payload)
        except Exception as e:
            if retryable(e):
                log(progress_dir, f"real-answer send failed, will retry (ts={ts}): {e}")
                return "send-failed"
            # Terminal: the answer cannot be posted this way. Say so on the
            # placeholder instead of leaving "working..." there forever.
            log(progress_dir, f"real-answer rejected, no retry (ts={ts}): {e} -> generic error")
        else:
            delete_placeholder(tok, {"chat_id": chat_id, "ts": ts}, progress_dir, "placeholder")
            return "real-answer"
    # No recoverable answer -> generic error, keep the (edited) placeholder.
    try:
        api(tok, "chat.update", {"channel": chat_id, "ts": ts, "text": error_text})
    except Exception as e:
        if retryable(e):
            log(progress_dir, f"error edit failed, will retry (ts={ts}): {e}")
            return "send-failed"
        log(progress_dir, f"error edit rejected, no retry (ts={ts}): {e}")
    return "generic-error"


def _entry_key(p):
    return (str(p.get("chat_id")), str(p.get("ts")))


def settle(path, done, progress_dir):
    """Take the entries this tick is finished with (`done`) out of the marker;
    whatever else it holds stays for a later tick. Removed when nothing is
    left, untouched when nothing was finished.

    Only the finished entries leave, so a later tick cannot re-deliver the ones
    that got through (duplicates) and still retries the ones that failed. The
    mtime is preserved on purpose: it is the marker's AGE (the fire thresholds
    and the 24h stale bound read it) and the round anchor for read_transcript
    -- a fresh mtime would restart the clock and re-anchor the transcript
    window on the wrong round.

    The marker is RE-READ here, right before the write, instead of writing back
    a list computed before the (slow) API calls. `replied` leftovers are handled
    at any age, i.e. also while their session is live: a submit hook may have
    appended the next turn's placeholder in the meantime, and writing the old
    list back would orphan it for good."""
    if not done:
        return
    gone = {_entry_key(p) for p in done}
    try:
        st = os.stat(path)
        with open(path) as f:
            cur = json.load(f)
    except Exception:
        return  # a hook removed or is rewriting it: nothing of ours to settle
    if not isinstance(cur, list):
        cur = []
    rest = [p for p in cur if not (isinstance(p, dict) and _entry_key(p) in gone)]
    try:
        if not rest:
            os.remove(path)
        elif len(rest) != len(cur):
            with open(path, "w") as f:
                json.dump(rest, f)
            os.utime(path, (st.st_atime, st.st_mtime))
    except Exception as e:
        log(progress_dir, f"marker update failed ({os.path.basename(path)}): {e}")


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
    error_text = TEXTS[lang(state_dir)]["error"]
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

        # `replied` leftovers: the reply hook answered these, only the
        # placeholder's chat.delete failed retryably (see
        # slack_progress_reply_clear.py). There is nothing to deliver and no
        # fire decision to wait for -- the delete is simply retried on every
        # tick, at any age, and NEVER followed by an answer or an error
        # rewrite: the round HAS its reply. The stale bound above is what
        # eventually gives up on a delete that keeps failing.
        done = []  # entries this tick is finished with; settle() takes them out
        owed = [p for p in pend if p.get("replied")]
        if owed:
            if tok is None:
                tok = token(state_dir)
            if tok:
                cleared = [p for p in owed
                           if delete_placeholder(tok, p, progress_dir, "replied placeholder")]
                done.extend(cleared)
                log(progress_dir, f"replied leftover(s): {len(cleared)}/{len(owed)} "
                                  f"settled, the rest retries next tick "
                                  f"({os.path.basename(path)}) delivered=none")
            pend = [p for p in pend if not p.get("replied")]
            if not pend:
                settle(path, done, progress_dir)
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
            settle(path, done, progress_dir)
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
            settle(path, done + pend, progress_dir)
            log(progress_dir, f"orphan cleared (reply-already-delivered): "
                              f"{os.path.basename(path)} agent_up={agent_up} "
                              f"age={int(age)}s delivered=none")
            continue

        modes, retry = [], []
        for p in pend:
            mode = deliver(tok, p.get("chat_id"), p.get("ts"), p.get("thread_ts"),
                           answer, progress_dir, error_text)
            modes.append(mode)
            if mode == "send-failed":
                retry.append(p)
            else:
                done.append(p)
        # Retryable failure(s): the marker stays (with only the failed entries)
        # and the next tick tries again; the stale bound above is what
        # eventually gives up. Nothing left to retry: the marker goes.
        settle(path, done, progress_dir)
        log(progress_dir, f"orphan handled ({reason}): {os.path.basename(path)} "
                          f"agent_up={agent_up} age={int(age)}s "
                          f"delivered={','.join(modes)}"
                          + (f" retry={len(retry)} (marker kept for the next tick)" if retry else ""))


def main():
    dirs = []
    for g in SCAN_GLOBS:
        dirs.extend(glob.glob(g))
    for d in dirs:
        if os.path.isdir(d):
            handle_dir(d)


if __name__ == "__main__":
    main()
