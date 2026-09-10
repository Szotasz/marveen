#!/usr/bin/env python3
"""
Stop hook — two jobs, mirroring telegram_progress_clear.py:

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

Loop safety: a per-session `enforce-<sid>.marker` guarantees we block at most
once; `stop_hook_active` is also honored. Silent on stdout EXCEPT the single
decision JSON when blocking. Token/state dir resolution mirrors the plugin
(SLACK_STATE_DIR, else the install-scoped dir (#915), else the legacy shared
default).
"""
import sys, os, json, glob, urllib.request

INSTRUCTION = (
    "KÖTELEZŐ: erre a Slack-üzenetre még NEM küldtél választ a Slack "
    "`reply` tool-lal (chat_id=%s). A CLI/transzkript szöveget a felhasználó a "
    "Slacken NEM látja — onnan nézve csak befagytál. Küldd el a válaszodat "
    "MOST a `reply` tool-lal a megfelelő chat_id-vel (és thread_ts-szel, ha "
    "volt). Ha tényleg nincs érdemi válasz, akkor is küldj egy rövid "
    "visszaigazolást."
)


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

    blocked_before = os.path.exists(guard)
    if not stop_active and not blocked_before:
        try:
            open(guard, "w").close()
        except Exception:
            pass
        chats = ", ".join(sorted({str(p.get("chat_id")) for p in pend}))
        log(sd, f"[enforce] blocking stop, no reply sent sid={sid} chats={chats}")
        print(json.dumps({"decision": "block", "reason": INSTRUCTION % chats}))
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
    for f in (path, guard):
        try:
            os.remove(f)
        except Exception:
            pass
    log(sd, f"[enforce] fallback-delivered={bool(answer)} cleared {len(pend)} "
            f"placeholder(s) sid={sid}")


if __name__ == "__main__":
    main()
