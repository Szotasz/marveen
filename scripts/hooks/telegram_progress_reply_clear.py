#!/usr/bin/env python3
"""
PostToolUse hook — clears the "✍️ Dolgozom rajta…" placeholder as soon as the
agent actually SENDS a reply, instead of waiting for the turn to end (Stop).

Why: a single long turn can pull a bigger task forward and emit several replies
before it finishes. With Stop-only cleanup the placeholder visibly lingers for
the whole (possibly very long) turn even though the user already got an answer.
Clearing on the reply tool makes the placeholder disappear exactly when the
answer appears — matching the user's mental model.

Fires after the Telegram `reply` tool. Two jobs:
  1) Record a per-turn "a reply WAS sent to this chat" marker
     (replied-<sid>-<chatid>.marker), written UNCONDITIONALLY — even if no
     placeholder file exists yet. The UserPromptSubmit placeholder is created
     asynchronously, so on a fast turn the reply can fire BEFORE the placeholder
     is written; without a durable record the Stop enforce hook would later see
     a "still pending" placeholder, assume the agent never replied, and deliver
     the transcript prose a SECOND time -> the user got the answer twice (plus a
     bogus "you never replied" nudge). The Stop hook consults this marker and
     skips both the nudge and the prose fallback for chats already answered.
  2) Delete any pending placeholder(s) for the replied chat_id (best effort —
     the marker is the durable signal, the delete is cosmetic).

The Stop hook + watchdog remain as backstops for turns that end without a reply,
or true crashes.

Silent on stdout. Honors TELEGRAM_STATE_DIR (per-agent token) like the others.
"""
import sys, os, json, urllib.request


def state_dir():
    # #915: env override, then install-scoped once migrated, then legacy shared.
    d = os.environ.get("TELEGRAM_STATE_DIR")
    if d:
        return d
    _root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    _inst = os.path.join(_root, ".claude", "channels", "telegram")
    if os.path.isfile(os.path.join(_inst, ".env")):
        return _inst
    return os.path.expanduser("~/.claude/channels/telegram")


def token(sd):
    try:
        for line in open(os.path.join(sd, ".env"), encoding="utf-8"):
            line = line.strip()
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    except Exception:
        return None
    return None


def api(tok, method, payload):
    url = f"https://api.telegram.org/bot{tok}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def mark_replied(pdir, sid, chat_id):
    """Durably record that a reply went to this chat during this turn, so the
    Stop enforce hook won't re-deliver the transcript prose. Best effort."""
    try:
        os.makedirs(pdir, exist_ok=True)
        open(os.path.join(pdir, f"replied-{sid}-{chat_id}.marker"), "w").close()
    except Exception:
        pass


def main():
    try:
        ev = json.loads(sys.stdin.read())
    except Exception:
        return
    tool = ev.get("tool_name") or ev.get("toolName") or ""
    if "telegram" not in tool or "reply" not in tool:
        return
    ti = ev.get("tool_input") or ev.get("toolInput") or {}
    chat_id = ti.get("chat_id")
    if chat_id is None:
        return
    chat_id = str(chat_id)
    sid = ev.get("session_id") or "default"
    sd = state_dir()
    pdir = os.path.join(sd, "progress")

    # (1) Record the reply FIRST, unconditionally — before any pend check. This
    # is the durable signal the Stop hook trusts; it must survive the race where
    # the placeholder file is written only AFTER this reply fires.
    mark_replied(pdir, sid, chat_id)

    # (2) Cosmetic: drop any placeholder(s) already posted for this chat.
    path = os.path.join(pdir, f"{sid}.json")
    try:
        pend = json.load(open(path))
    except Exception:
        return
    keep, drop = [], []
    for p in pend:
        (drop if str(p.get("chat_id")) == chat_id else keep).append(p)
    if not drop:
        return
    tok = token(sd)
    if tok:
        for p in drop:
            try:
                api(tok, "deleteMessage", {"chat_id": p["chat_id"], "message_id": p["message_id"]})
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
