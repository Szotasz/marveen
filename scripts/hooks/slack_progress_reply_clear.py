#!/usr/bin/env python3
"""
PostToolUse hook — clears the "✍️ Dolgozom rajta…" Slack placeholder as soon
as the agent actually SENDS a reply, instead of waiting for the turn to end
(Stop). Mirrors telegram_progress_reply_clear.py exactly, adapted to the
Slack API (chat.delete keyed on channel+ts instead of chat_id+message_id).

Why: a single long turn can pull a bigger task forward and emit several
replies before it finishes. With Stop-only cleanup the placeholder visibly
lingers for the whole (possibly very long) turn even though the user already
got an answer. Clearing on the reply tool makes the placeholder disappear
exactly when the answer appears.

Matches on (chat_id, thread_ts): a Slack channel can have several concurrent
threads, each with its own placeholder, so chat_id alone is not a precise
enough key (unlike Telegram, where chat_id already identifies a single DM
or group).

Fires after the Slack `reply` tool. Silent on stdout. Honors SLACK_STATE_DIR
(per-agent token) like the others.
"""
import sys, os, json, urllib.request


def state_dir():
    # #915: env override, then install-scoped once migrated, then legacy shared.
    d = os.environ.get("SLACK_STATE_DIR")
    if d:
        return d
    _root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    _inst = os.path.join(_root, ".claude", "channels", "slack")
    if os.path.isfile(os.path.join(_inst, ".env")):
        return _inst
    return os.path.expanduser("~/.claude/channels/slack")


def api_base():
    return os.environ.get("SLACK_API_BASE", "https://slack.com/api").rstrip("/")


def token(sd):
    try:
        for line in open(os.path.join(sd, ".env"), encoding="utf-8"):
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


def main():
    try:
        ev = json.loads(sys.stdin.read())
    except Exception:
        return
    tool = (ev.get("tool_name") or ev.get("toolName") or "").lower()
    if "slack" not in tool or "reply" not in tool:
        return
    ti = ev.get("tool_input") or ev.get("toolInput") or {}
    chat_id = ti.get("chat_id")
    if chat_id is None:
        return
    chat_id = str(chat_id)
    thread_ts = ti.get("thread_ts")
    sid = ev.get("session_id") or "default"
    sd = state_dir()
    path = os.path.join(sd, "progress", f"{sid}.json")
    try:
        pend = json.load(open(path))
    except Exception:
        return
    keep, drop = [], []
    for p in pend:
        match = str(p.get("chat_id")) == chat_id and p.get("thread_ts") == thread_ts
        (drop if match else keep).append(p)
    if not drop:
        return
    tok = token(sd)
    if tok:
        for p in drop:
            try:
                api(tok, "chat.delete", {"channel": p["chat_id"], "ts": p["ts"]})
            except Exception:
                pass
    try:
        if keep:
            json.dump(keep, open(path, "w"))
        else:
            os.remove(path)
    except Exception:
        pass


if __name__ == "__main__":
    main()
