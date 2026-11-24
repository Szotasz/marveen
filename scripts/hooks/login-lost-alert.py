#!/usr/bin/env python3
"""Stop / StopFailure hook: tell the owner at once when an agent's Claude login is gone (LOGINKIESES1119).

Why: when the Claude login of a session expires, every turn ends with a synthetic assistant message
("Not logged in · Please run /login", "Login expired · Please run /login", error authentication_failed).
Measured 2026-11-19: the main channels session answered that way 328 times between 02:07 and 17:16, and
nobody told the owner, because the only thing that could have told him was the logged-out agent itself.
A hook runs locally even without a login, so it can raise the alarm from outside the model.

What it does, per agent (the id comes from the transcript path, ledger_lib.agent_id_from_payload):
  - a turn that ended logged out: the first one sends an alert through scripts/notify.sh (the install's own
    bot token, Bot API, independent of any channel plugin); while the login stays gone, at most one reminder
    every REPEAT_SECONDS (30 minutes);
  - the first normal turn after that: one "recovered" message, and the agent's state is cleared. With two
    sessions under one agent id, a normal turn of one does not recover the other while it is still logged out
    (a session not seen logged out for an hour counts as gone, and that recovery is worded as "probably"). A failed "recovered" send is retried.
    The 30-minute brake is per agent, so two logged-out sessions never double the alert, and a Stop plus a
    StopFailure for the same turn count as one failed turn.
State: <install>/store/login-alert-state.json (agent -> since, last alert, failed turns), under a lock.
A notify.sh that fails does not count as sent, so the next logged-out turn tries again.

Detection is strict, so an agent that only TALKS about a lost login never trips it:
  - StopFailure with error authentication_failed, or
  - the newest assistant entry of the transcript is a synthetic API error message with that error, or
  - the turn's whole last assistant text is one of the known login lines (matched end to end).

The hook never reads the bot token (notify.sh does) and writes nothing but the state file. It is
fire-and-forget: it prints nothing and always exits 0, so it can never block or alter a turn.
"""
import fcntl
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

STATE_FILE = "login-alert-state.json"
REPEAT_SECONDS = 30 * 60
SESSION_STALE_SECONDS = 60 * 60
SAME_TURN_SECONDS = 10
TRANSCRIPT_TAIL_BYTES = 256 * 1024
AUTH_ERROR = "authentication_failed"
# The whole last assistant text, end to end: "Not logged in · Please run /login",
# "Login expired · Please run /login", "Invalid API key · Please run /login" and the same with a plain dot or dash.
LOGIN_LINE = re.compile(
    r"\s*(?:not logged in|login expired|invalid api key|oauth token (?:has )?expired)"
    r"\s*[·.\-:]?\s*(?:please run /login\.?)?\s*", re.IGNORECASE)


def _install():
    return ledger_lib._install_dir()


def state_path():
    return os.path.join(_install(), "store", STATE_FILE)


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    return ""


def last_assistant_entry(transcript_path):
    """The newest assistant entry of the transcript (from its tail), or None."""
    if not transcript_path or not isinstance(transcript_path, str):
        return None
    try:
        with open(transcript_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - TRANSCRIPT_TAIL_BYTES))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if isinstance(d, dict) and d.get("type") == "assistant":
            return d
    return None


API_ERROR_TEXT = re.compile(r"\s*API Error\b", re.IGNORECASE)


def is_login_line(text):
    return bool(text) and len(text) <= 200 and LOGIN_LINE.fullmatch(text) is not None


def verdict(payload):
    """'down' (the turn ended logged out), 'up' (a normal turn) or None (cannot tell: change nothing)."""
    event = payload.get("hook_event_name") or ""
    if event == "StopFailure" or payload.get("error"):
        return "down" if str(payload.get("error") or "") == AUTH_ERROR else None
    text = payload.get("last_assistant_message")
    text = text.strip() if isinstance(text, str) else ""
    entry = last_assistant_entry(payload.get("transcript_path"))
    if entry is not None and entry.get("isApiErrorMessage"):
        etext = _text_of((entry.get("message") or {}).get("content")).strip()
        # The transcript ends on an API error line. It is THIS turn's line when the payload carries no text or the
        # same text; a different payload text is a newer turn whose line the transcript does not hold yet.
        if not text or text == etext:
            if entry.get("error") == AUTH_ERROR or is_login_line(etext):
                return "down"
            return None  # another API error (overload, prompt too long): no news about the login
    if text:
        if is_login_line(text):
            return "down"
        if API_ERROR_TEXT.match(text):
            return None  # an API error text with no transcript line yet: no news about the login either
        return "up"
    text = _text_of((entry.get("message") or {}).get("content")) if entry is not None else ""
    if isinstance(text, str) and is_login_line(text):
        return "down"
    if isinstance(text, str) and text.strip():
        return "up"
    return None


def notify(text):
    cmd = os.path.join(_install(), "scripts", "notify.sh")
    try:
        r = subprocess.run(["bash", cmd, text], timeout=20,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return r.returncode == 0
    except Exception:
        return False


def _hhmm(ts):
    return time.strftime("%H:%M", time.localtime(ts))


def _load(f):
    f.seek(0)
    try:
        data = json.loads(f.read() or "{}")
        return data if isinstance(data, dict) else {}
    except ValueError:
        return {}


def _save(f, data):
    f.seek(0)
    f.truncate()
    f.write(json.dumps(data, ensure_ascii=False, indent=1))
    f.flush()


ACTION = "Teendő: a dashboardon az ügynök kártyáján a „Bejelentkezés” gomb."


def _session_key(payload):
    # The transcript file is named after the session id, so a payload without session_id keys the same session.
    sid = payload.get("session_id")
    if sid:
        return str(sid)
    tp = payload.get("transcript_path")
    if isinstance(tp, str) and tp:
        base = os.path.basename(tp)
        return base[:-len(".jsonl")] if base.endswith(".jsonl") else base
    return "-"


def handle(agent_id, v, now, session="-", event=""):
    path = state_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, "r+", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        data = _load(f)
        st = data.get(agent_id)
        if v == "down":
            if not isinstance(st, dict):
                st = {"since": now, "last_alert": 0, "failed_turns": 0}
            # Stop and StopFailure for the SAME turn count once: the other event of this session, moments ago.
            prev = st.get("last_down") if isinstance(st.get("last_down"), dict) else {}
            same_turn = (prev.get("session") == session and prev.get("event") != event
                         and now - float(prev.get("t") or 0) < SAME_TURN_SECONDS)
            if not same_turn:
                st["failed_turns"] = int(st.get("failed_turns") or 0) + 1
            st["last_down"] = {"session": session, "event": event, "t": now}
            st.pop("own_recovery", None)  # a new logged-out turn: an earlier, unsent own recovery no longer holds
            sessions = st.get("sessions") if isinstance(st.get("sessions"), dict) else {}
            sessions[session] = now
            st["sessions"] = sessions
            if now - float(st.get("last_alert") or 0) >= REPEAT_SECONDS:
                first = not st.get("last_alert")
                if first:
                    text = (f"RIASZTÁS: a(z) {agent_id} ügynök Claude-bejelentkezése kiesett "
                            f"({_hhmm(st['since'])} óta). Minden kérésre csak azt válaszolja, hogy jelentkezzen be, "
                            f"tehát addig nem dolgozik. {ACTION}")
                else:
                    text = (f"RIASZTÁS, ismétlés: a(z) {agent_id} ügynök {_hhmm(st['since'])} óta nincs bejelentkezve "
                            f"({st['failed_turns']} sikertelen kör). {ACTION}")
                if notify(text):
                    st["last_alert"] = now
            data[agent_id] = st
            _save(f, data)
        elif v == "up" and isinstance(st, dict):
            # Two sessions can share an agent id (the ledger maps every session under the install to the main
            # agent). A normal turn of one session must not "recover" another that is still logged out, or the
            # two would alternate alert / recovered on every turn. A session that has not been seen logged out
            # for SESSION_STALE_SECONDS counts as gone (replaced after a re-login or a restart); a recovery that rests
            # only on that says so, because the silent session may also just have had nothing to do.
            sessions = st.get("sessions") if isinstance(st.get("sessions"), dict) else {}
            own = session in sessions
            sessions.pop(session, None)
            sessions = {k: t for k, t in sessions.items() if now - float(t or 0) < SESSION_STALE_SECONDS}
            if not sessions and own:
                st["own_recovery"] = True  # kept if the send below fails, so the retry words it the same way
            if sessions:
                st["sessions"] = sessions
                data[agent_id] = st
                _save(f, data)
                return
            if st.get("last_alert"):
                minutes = max(1, int(round((now - float(st.get("since") or now)) / 60)))
                if st.get("own_recovery"):
                    msg = (f"HELYREÁLLT: a(z) {agent_id} ügynök újra rendesen válaszol "
                           f"(kiesés {_hhmm(st['since'])} és {_hhmm(now)} között, kb. {minutes} perc).")
                else:
                    msg = (f"VALÓSZÍNŰLEG HELYREÁLLT: a(z) {agent_id} ügynök egy munkamenete rendesen válaszol, a kiesett "
                           f"munkamenet egy órája nem jelzett (kiesés {_hhmm(st['since'])} óta). "
                           f"Ha még nincs bejelentkezve, a következő köre új riasztást küld.")
                sent = notify(msg)
                if not sent:
                    # Keep the outage so the next normal turn sends the "recovered" message again.
                    st["sessions"] = {}
                    data[agent_id] = st
                    _save(f, data)
                    return
            data.pop(agent_id, None)
            _save(f, data)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(payload, dict):
        return
    agent_id = ledger_lib.agent_id_from_payload(payload)
    if not agent_id:
        return
    v = verdict(payload)
    if v is None:
        return
    if v == "up":
        # Fast path: a normal turn with no recorded outage touches no file at all.
        try:
            with open(state_path(), encoding="utf-8") as f:
                if agent_id not in (json.loads(f.read() or "{}") or {}):
                    return
        except (OSError, ValueError):
            return
    handle(agent_id, v, time.time(), _session_key(payload), str(payload.get("hook_event_name") or ""))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
