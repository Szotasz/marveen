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

Matching is keyed on chat_id first, then narrowed by thread — a Slack channel
can have several concurrent threads, each with its own placeholder, so chat_id
alone is not a precise enough key (unlike Telegram, where chat_id already
identifies a single DM or group). Thread narrowing is deliberately TOLERANT,
in three tiers, because a legitimate reply often carries a thread_ts that is
not byte-equal to the inbound block's:

  tier 1 (exact)    same thread, or threaded under the inbound message itself
                    (reply thread_ts == the entry's src_ts);
  tier 2 (loose)    either side is top-level ("" and missing both normalise to
                    None) — an install's outbound rules may tell the agent to
                    answer a threaded inbound WITHOUT thread_ts, and the
                    optional param is sometimes passed as an empty string;
  tier 3 (fallback) nothing matched but this chat has pending placeholders — a
                    reply to the chat is still the answer to that turn.

A miss here is not cosmetic: the placeholder stays pending, the Stop hook
blocks the turn claiming no reply was sent, the agent replies a second time,
and the second Stop dumps the raw transcript into Slack (the
slack-progress-hook-loop incident). Clearing one placeholder too eagerly
merely removes a "working on it" marker; leaving one behind corrupts the
conversation.

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


def norm_ts(v):
    """Empty, None and missing thread_ts all mean "no thread"; else a str key."""
    if v is None:
        return None
    v = str(v).strip()
    return v or None


def split_pending(pend, chat_id, thread_ts):
    """Return (keep, drop) for a reply into chat_id / thread_ts.

    Entries of other chats are always kept. Within the chat, the first
    non-empty tier wins: exact thread match, then loose (either side
    top-level), then every pending entry of the chat."""
    same_chat = [p for p in pend if str(p.get("chat_id")) == chat_id]

    def entry_thread(p):
        return norm_ts(p.get("thread_ts"))

    exact = [p for p in same_chat
             if thread_ts == entry_thread(p)
             or (thread_ts is not None and thread_ts == norm_ts(p.get("src_ts")))]
    loose = [p for p in same_chat
             if thread_ts is None or entry_thread(p) is None]
    fallback = same_chat
    drop = exact or loose or fallback
    id_set = {id(p) for p in drop}
    keep = [p for p in pend if id(p) not in id_set]
    return keep, drop


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
    thread_ts = norm_ts(ti.get("thread_ts"))
    sid = ev.get("session_id") or "default"
    sd = state_dir()
    path = os.path.join(sd, "progress", f"{sid}.json")
    try:
        pend = json.load(open(path))
    except Exception:
        return
    if not isinstance(pend, list):
        return
    keep, drop = split_pending(pend, chat_id, thread_ts)
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
