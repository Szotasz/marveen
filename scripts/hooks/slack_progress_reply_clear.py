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

A failed chat.delete is not a cleared placeholder. The entry used to leave the
pending file whatever chat.delete said (the exception was swallowed, and
Slack's HTTP-200 {"ok": false} was not even looked at), so after a rate limit
or a network blip the placeholder stayed in Slack while the file -- the only
thing the Stop hook and the watchdog read -- no longer knew about it: a
permanent "working on it…" under an answered message. Now, per entry:

  deleted, or TERMINAL rejection   (message_not_found, channel_not_found,
                                   cant_delete_message, invalid_auth, ...:
                                   waiting cannot help) -> entry dropped;
  RETRYABLE failure                (HTTP 429/5xx, connection error/timeout,
                                   Slack ratelimited / internal_error / ...)
                                   -> entry KEPT, marked `"replied": true`.

The mark is what makes keeping it safe. An unmarked leftover means "no reply
was sent" to the Stop hook, which would block the turn and provoke exactly the
duplicate reply described above. A `replied` entry says the opposite -- the
answer went out, only the cleanup is owed -- so every reader treats it as
delete-only: the Stop hook retries the delete and never enforces on it, the
watchdog retries on each tick (the 24h stale bound is what gives up) and never
delivers anything for it, and here it never takes part in the tier matching
(it must not shadow a later turn's live placeholder), its delete is just
retried whenever the chat is replied to again.

Fires after the Slack `reply` tool. Silent on stdout. Honors SLACK_STATE_DIR
(per-agent token) like the others.
"""
import sys, os, json, http.client, urllib.error, urllib.request

# Slack error codes that mean "try again later", not "this cannot be done".
# Same set as slack_progress_watchdog.py.
RETRYABLE_SLACK_ERRORS = {"ratelimited", "internal_error", "service_unavailable",
                          "fatal_error", "request_timeout"}


class SlackApiError(Exception):
    """An HTTP-200 envelope with ok:false (or a malformed body)."""
    def __init__(self, method, error):
        super().__init__(f"{method}: {error}")
        self.error = error


def retryable(e):
    """True when a failed chat.delete is worth another attempt later."""
    if isinstance(e, SlackApiError):
        return e.error in RETRYABLE_SLACK_ERRORS
    if isinstance(e, urllib.error.HTTPError):
        return e.code == 429 or e.code >= 500
    # URLError, socket timeout, connection reset, truncated response: transient.
    # Anything else (a malformed entry, a bug) will not get better by waiting.
    return isinstance(e, (OSError, http.client.HTTPException))


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
        resp = json.loads(r.read().decode())
    # Slack reports application errors as HTTP 200 + {"ok": false, "error": ...}.
    if not isinstance(resp, dict) or not resp.get("ok"):
        err = resp.get("error") if isinstance(resp, dict) else None
        raise SlackApiError(method, err or "malformed-response")
    return resp


def log(sd, msg):
    try:
        os.makedirs(os.path.join(sd, "progress"), exist_ok=True)
        with open(os.path.join(sd, "progress", "debug.log"), "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass


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
    top-level), then every pending entry of the chat.

    The tiers only see LIVE entries. A `replied` leftover (answered earlier,
    its chat.delete still owed) must not win a tier: it would shadow the
    placeholder this reply actually answers, which would then stay pending and
    walk the Stop hook into the duplicate-reply cascade. The chat's leftovers
    ride along instead -- a reply to the chat is a good moment to retry them."""
    in_chat = [p for p in pend if str(p.get("chat_id")) == chat_id]
    same_chat = [p for p in in_chat if not p.get("replied")]
    leftovers = [p for p in in_chat if p.get("replied")]

    def entry_thread(p):
        return norm_ts(p.get("thread_ts"))

    exact = [p for p in same_chat
             if thread_ts == entry_thread(p)
             or (thread_ts is not None and thread_ts == norm_ts(p.get("src_ts")))]
    loose = [p for p in same_chat
             if thread_ts is None or entry_thread(p) is None]
    fallback = same_chat
    drop = (exact or loose or fallback) + leftovers
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
    owed = []  # answered, but the placeholder is still in Slack: delete again later
    if tok:
        for p in drop:
            try:
                api(tok, "chat.delete", {"channel": p.get("chat_id"), "ts": p.get("ts")})
            except Exception as e:
                if retryable(e):
                    owed.append(dict(p, replied=True))
                    log(sd, f"[reply-clear] delete failed, entry kept as replied "
                            f"for a retry (ts={p.get('ts')}): {e}")
                else:
                    log(sd, f"[reply-clear] delete rejected, entry dropped "
                            f"(ts={p.get('ts')}): {e}")
    remaining = keep + owed
    try:
        if remaining:
            json.dump(remaining, open(path, "w"))
        else:
            os.remove(path)
    except Exception:
        pass


if __name__ == "__main__":
    main()
