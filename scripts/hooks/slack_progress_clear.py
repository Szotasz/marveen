#!/usr/bin/env python3
"""
Stop hook - two jobs, mirroring telegram_progress_clear.py:

  1) CLEAR: remove the "✍️ Dolgozom rajta…" placeholder(s) that
     slack_progress.py posted for this session. Under normal operation the
     PostToolUse reply hook already cleared them the moment the agent
     replied, so usually there is nothing left to do.

  2) ENFORCE DELIVERY: if the turn was triggered by an inbound Slack message
     but the agent ended the turn WITHOUT ever sending a reply to that
     chat/thread (i.e. a placeholder is still pending), the answer only
     exists in the CLI/transcript, which the Slack user never sees. This
     hook then:
       - on the first Stop: BLOCKS the stop and instructs the agent to send
         its answer via the Slack `reply` tool;
       - if it STILL did not reply after that one nudge: delivers the
         agent's final answer (last assistant message from the transcript)
         to the chat as a guaranteed fallback via chat.postMessage, then
         removes the placeholder via chat.delete.

`replied` entries are outside job 2. The reply hook marks an entry
`"replied": true` when the answer DID go out but the placeholder's chat.delete
failed retryably (rate limit, 5xx, network) -- see
slack_progress_reply_clear.py. Such an entry must never read as "no reply was
sent": blocking on it would make the agent answer a second time. This hook only
retries its delete -- after the delivery work, so a slow Slack cannot eat the
budget of the part that matters, and not at all on the Stop that blocks -- and
if that fails retryably again, leaves the entry in the file for the watchdog.

Loop safety: a per-session `enforce-<sid>.marker` guarantees we block at most
once; `stop_hook_active` is also honored. Silent on stdout EXCEPT the single
decision JSON when blocking. Token/state dir resolution mirrors the plugin
(SLACK_STATE_DIR, else the install-scoped dir (#915), else the legacy shared
default).
"""
import sys, os, json, glob, http.client, urllib.error, urllib.request

# Slack error codes that mean "try again later", not "this cannot be done".
# Same set as slack_progress_watchdog.py.
RETRYABLE_SLACK_ERRORS = {"ratelimited", "internal_error", "service_unavailable",
                          "fatal_error", "request_timeout"}

# The block reason is addressed to the agent, in the install language.
TEXTS = {
    "hu": {"instruction": (
        "KÖTELEZŐ: erre a Slack-üzenetre még NEM küldtél választ a Slack "
        "`reply` tool-lal (chat_id=%s). A CLI/transzkript szöveget a felhasználó a "
        "Slacken NEM látja - onnan nézve csak befagytál. Küldd el a válaszodat "
        "MOST a `reply` tool-lal a megfelelő chat_id-vel (és thread_ts-szel, ha "
        "volt). Ha tényleg nincs érdemi válasz, akkor is küldj egy rövid "
        "visszaigazolást."
    )},
    "en": {"instruction": (
        "MANDATORY: you have NOT yet answered this Slack message with the Slack "
        "`reply` tool (chat_id=%s). The user does NOT see CLI/transcript text on "
        "Slack - from their side you simply froze. Send your answer NOW with the "
        "`reply` tool using the right chat_id (and thread_ts, if there was one). "
        "If there is genuinely nothing substantive to say, still send a short "
        "acknowledgement."
    )},
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


def state_dir():
    # #915: env override, then the install-scoped dir once it holds the .env,
    # then the legacy shared path (unmigrated installs only).
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


def log(sd, msg):
    try:
        os.makedirs(os.path.join(sd, "progress"), exist_ok=True)
        with open(os.path.join(sd, "progress", "debug.log"), "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass


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


def delete_owed(tok, p):
    """Retry the chat.delete of one `replied` entry. True = nothing more to do
    (deleted, or a TERMINAL rejection such as message_not_found); False = a
    RETRYABLE failure, the entry stays. Reads the envelope itself: api() is the
    plain one the fallback path uses and does not raise on Slack's HTTP-200
    {"ok": false}."""
    try:
        resp = api(tok, "chat.delete", {"channel": p.get("chat_id"), "ts": p.get("ts")})
    except urllib.error.HTTPError as e:
        return not (e.code == 429 or e.code >= 500)
    except (OSError, http.client.HTTPException):
        return False  # URLError, timeout, connection reset: transient
    except Exception:
        return True
    if isinstance(resp, dict) and not resp.get("ok"):
        return resp.get("error") not in RETRYABLE_SLACK_ERRORS
    return True


def settle_owed(sd, path, owed, sid):
    """Retry the owed deletes and leave the pending file holding exactly the
    ones that failed retryably again (the next Stop, or the watchdog's next
    tick, picks them up); remove it when none is left."""
    still = []
    if owed:
        tok = token(sd)
        still = [p for p in owed if not tok or not delete_owed(tok, p)]
        log(sd, f"[stop] owed placeholder deletes: {len(owed) - len(still)} done, "
                f"{len(still)} left for the watchdog sid={sid}")
    try:
        if still:
            json.dump(still, open(path, "w"))
        else:
            os.remove(path)
    except Exception:
        pass


def last_assistant_text(transcript_path):
    """Return the last non-empty assistant text message from the JSONL
    transcript. Empty string if none / unreadable."""
    text = ""
    if not transcript_path:
        return text
    try:
        for line in open(transcript_path, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            msg = ev.get("message") or {}
            role = msg.get("role") or ev.get("role")
            if ev.get("type") == "assistant" or role == "assistant":
                content = msg.get("content", ev.get("content"))
                parts = []
                if isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and c.get("type") == "text":
                            parts.append(c.get("text", ""))
                elif isinstance(content, str):
                    parts.append(content)
                t = "\n".join(p for p in parts if p).strip()
                if t:
                    text = t  # keep the LAST non-empty one
    except Exception:
        pass
    return text


def main():
    raw = sys.stdin.read()
    try:
        ev = json.loads(raw)
    except Exception:
        ev = {}
    sid = ev.get("session_id") or "default"
    transcript = ev.get("transcript_path")
    stop_active = bool(ev.get("stop_hook_active"))
    sd = state_dir()
    pdir = os.path.join(sd, "progress")
    guard = os.path.join(pdir, f"enforce-{sid}.marker")

    # Clean up this session's dedup markers (created by slack_progress.py).
    for m in glob.glob(os.path.join(pdir, f"seen-{sid}-*.marker")):
        try:
            os.remove(m)
        except Exception:
            pass

    path = os.path.join(pdir, f"{sid}.json")
    try:
        pend = json.load(open(path))
    except Exception:
        pend = None

    if not pend:
        try:
            os.remove(guard)
        except Exception:
            pass
        return

    # `replied` entries were answered; only their chat.delete is owed (see the
    # docstring). They take no part in the enforcement below.
    owed = [p for p in pend if isinstance(p, dict) and p.get("replied")]
    pend = [p for p in pend if not (isinstance(p, dict) and p.get("replied"))]
    if not pend:
        settle_owed(sd, path, owed, sid)
        try:
            os.remove(guard)
        except Exception:
            pass
        return

    blocked_before = os.path.exists(guard)
    if not stop_active and not blocked_before:
        try:
            open(guard, "w").close()
        except Exception:
            pass
        chats = ", ".join(sorted({str(p.get("chat_id")) for p in pend}))
        log(sd, f"[enforce] blocking stop, no reply sent sid={sid} chats={chats}")
        instruction = TEXTS[lang(sd)]["instruction"]
        print(json.dumps({"decision": "block", "reason": instruction % chats}))
        return

    answer = last_assistant_text(transcript)
    tok = token(sd)
    if tok:
        for p in pend:
            cid, ts, thread_ts = p.get("chat_id"), p.get("ts"), p.get("thread_ts")
            if answer:
                payload = {"channel": cid, "text": answer[:4000]}
                if thread_ts:
                    payload["thread_ts"] = thread_ts
                try:
                    api(tok, "chat.postMessage", payload)
                except Exception as e:
                    log(sd, f"[enforce] fallback send failed: {e}")
            try:
                api(tok, "chat.delete", {"channel": cid, "ts": ts})
            except Exception as e:
                log(sd, f"[stop] delete failed: {e}")
    # Last, so a slow Slack cannot eat the budget of the delivery above.
    settle_owed(sd, path, owed, sid)
    try:
        os.remove(guard)
    except Exception:
        pass
    log(sd, f"[enforce] fallback-delivered={bool(answer)} cleared {len(pend)} "
            f"placeholder(s) sid={sid}")


if __name__ == "__main__":
    main()
